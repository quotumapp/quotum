import { createHash, randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { StripeBillingConfig } from "../client";
import type { StripeBillingClientDependency } from "../service";

interface FakeCheckoutSession {
	id: string;
	clientReferenceId: string | null;
	metadata: Stripe.Metadata | null;
}

interface FakeInvoice {
	id: string;
	currency: string;
	total: number;
	status: "draft" | "open" | "paid" | "void";
	paymentIntentId: string;
}

export interface FakeStripeBillingClientOptions {
	defaultPaymentMethod?: string | null;
	paymentBehavior?: "succeeded" | "action_required" | "retryable_failure";
	priceAmountsMinor?: Readonly<Record<string, number>>;
}

/** A network-free Stripe boundary for local cross-service tests. */
export class FakeStripeBillingClient implements StripeBillingClientDependency {
	private readonly stripe: Stripe;
	private readonly sessions = new Map<string, FakeCheckoutSession>();
	private readonly sessionsByIdempotencyKey = new Map<string, FakeCheckoutSession>();
	private readonly subscriptions = new Map<string, Record<string, unknown>>();
	private readonly invoices = new Map<string, FakeInvoice>();
	private readonly invoicesByIdempotencyKey = new Map<string, FakeInvoice>();
	private readonly invoiceLineKeys = new Set<string>();
	private readonly subscriptionUpdates = new Map<string, { id: string }>();
	private readonly priceAmountsMinor: Readonly<Record<string, number>>;

	constructor(
		private readonly config: StripeBillingConfig,
		private readonly options: FakeStripeBillingClientOptions = {},
	) {
		this.stripe = new Stripe("sk_test_billing_fake", { apiVersion: config.apiVersion });
		this.priceAmountsMinor = {
			price_credits_10: 499,
			...options.priceAmountsMinor,
		};
	}

	async createCustomer(input: {
		billingAccountId: string;
		email: string | null;
	}): Promise<{ id: string }> {
		return { id: `cus_fake_${digest(input.billingAccountId).slice(0, 24)}` };
	}

	async createCheckoutSession(
		params: Stripe.Checkout.SessionCreateParams,
		idempotencyKey?: string,
	): Promise<{ id: string; url: string }> {
		const existing =
			idempotencyKey === undefined ? undefined : this.sessionsByIdempotencyKey.get(idempotencyKey);
		if (existing !== undefined) {
			return checkoutRedirect(existing.id);
		}

		const id = `cs_fake_${digest(idempotencyKey ?? randomUUID()).slice(0, 24)}`;
		const session = {
			id,
			clientReferenceId: params.client_reference_id ?? null,
			metadata: normalizeMetadata(params.metadata),
		};
		this.sessions.set(id, session);
		if (idempotencyKey !== undefined) {
			this.sessionsByIdempotencyKey.set(idempotencyKey, session);
		}
		return checkoutRedirect(id);
	}

	async createPortalSession(
		params: Stripe.BillingPortal.SessionCreateParams,
	): Promise<{ url: string }> {
		const id = `bps_fake_${digest(String(params.customer)).slice(0, 24)}`;
		return { url: `https://billing.stripe.test/session/${id}` };
	}

	async retrieveCheckoutSession(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (session === undefined) {
			throw new Error(`Unknown fake Stripe Checkout session: ${sessionId}`);
		}
		return {
			id: session.id,
			status: "complete",
			payment_status: "paid",
			client_reference_id: session.clientReferenceId,
			metadata: session.metadata,
		};
	}

	async constructWebhookEvent(rawBody: string, signature: string): Promise<Stripe.Event> {
		const event = await this.stripe.webhooks.constructEventAsync(
			rawBody,
			signature,
			this.config.webhookSecret,
		);
		const object = event.data.object as unknown as Record<string, unknown>;
		if (event.type.startsWith("customer.subscription.") && typeof object.id === "string") {
			this.subscriptions.set(object.id, object);
		}
		return event;
	}

	async retrieveSubscription(subscriptionId: string): Promise<Record<string, unknown>> {
		const subscription = this.subscriptions.get(subscriptionId);
		if (subscription === undefined) {
			throw new Error(`Unknown fake Stripe subscription: ${subscriptionId}`);
		}
		return subscription;
	}

	async retrieveDefaultPaymentMethod(_customerId: string): Promise<string | null> {
		return this.options.defaultPaymentMethod === undefined
			? "pm_fake_default"
			: this.options.defaultPaymentMethod;
	}

	async updateSubscription(
		subscriptionId: string,
		_params: Stripe.SubscriptionUpdateParams,
		idempotencyKey: string,
	): Promise<{ id: string }> {
		const existing = this.subscriptionUpdates.get(idempotencyKey);
		if (existing !== undefined) return existing;
		const updated = { id: subscriptionId };
		this.subscriptionUpdates.set(idempotencyKey, updated);
		return updated;
	}

	async createInvoice(
		params: Stripe.InvoiceCreateParams,
		idempotencyKey: string,
	): Promise<{ id: string }> {
		const existing = this.invoicesByIdempotencyKey.get(idempotencyKey);
		if (existing !== undefined) return { id: existing.id };
		const id = `in_fake_${digest(idempotencyKey).slice(0, 24)}`;
		const invoice: FakeInvoice = {
			id,
			currency: params.currency ?? "usd",
			total: 0,
			status: "draft",
			paymentIntentId: `pi_fake_${digest(id).slice(0, 24)}`,
		};
		this.invoices.set(id, invoice);
		this.invoicesByIdempotencyKey.set(idempotencyKey, invoice);
		return { id };
	}

	async addInvoiceLines(
		invoiceId: string,
		params: Stripe.InvoiceAddLinesParams,
		idempotencyKey: string,
	): Promise<unknown> {
		const invoice = this.requireInvoice(invoiceId);
		if (this.invoiceLineKeys.has(idempotencyKey)) return invoiceReceipt(invoice);
		for (const line of params.lines) invoice.total += this.lineAmount(line);
		this.invoiceLineKeys.add(idempotencyKey);
		return invoiceReceipt(invoice);
	}

	async finalizeInvoice(invoiceId: string, _idempotencyKey: string): Promise<unknown> {
		const invoice = this.requireInvoice(invoiceId);
		if (invoice.status === "draft") invoice.status = "open";
		return invoiceReceipt(invoice);
	}

	async payInvoice(invoiceId: string, _idempotencyKey: string): Promise<unknown> {
		const invoice = this.requireInvoice(invoiceId);
		if (this.options.paymentBehavior === "action_required") {
			throw Object.assign(new Error("Customer authentication is required"), {
				code: "invoice_payment_intent_requires_action",
				payment_intent: { id: invoice.paymentIntentId },
			});
		}
		if (this.options.paymentBehavior === "retryable_failure") {
			throw new Error("Fake Stripe is temporarily unavailable");
		}
		invoice.status = "paid";
		return invoiceReceipt(invoice);
	}

	async voidInvoice(invoiceId: string, _idempotencyKey: string): Promise<unknown> {
		const invoice = this.requireInvoice(invoiceId);
		invoice.status = "void";
		return invoiceReceipt(invoice);
	}

	private requireInvoice(invoiceId: string): FakeInvoice {
		const invoice = this.invoices.get(invoiceId);
		if (invoice === undefined) throw new Error(`Unknown fake Stripe invoice: ${invoiceId}`);
		return invoice;
	}

	private lineAmount(line: Stripe.InvoiceAddLinesParams.Line): number {
		const quantity = line.quantity ?? 1;
		if (typeof line.amount === "number") return line.amount * quantity;
		if (line.price_data?.unit_amount !== undefined && line.price_data.unit_amount !== null) {
			return line.price_data.unit_amount * quantity;
		}
		const priceId = line.pricing?.price;
		if (typeof priceId !== "string") {
			throw new Error("Fake Stripe invoice line must contain an amount or price");
		}
		const amount = this.priceAmountsMinor[priceId];
		if (amount === undefined) throw new Error(`Unknown fake Stripe price: ${priceId}`);
		return amount * quantity;
	}
}

function invoiceReceipt(invoice: FakeInvoice): Record<string, unknown> {
	return {
		id: invoice.id,
		status: invoice.status,
		total: invoice.total,
		amount_paid: invoice.status === "paid" ? invoice.total : 0,
		currency: invoice.currency,
		payments: {
			data:
				invoice.status === "paid"
					? [
							{
								payment: {
									type: "payment_intent",
									payment_intent: invoice.paymentIntentId,
								},
							},
						]
					: [],
		},
	};
}

function checkoutRedirect(id: string): { id: string; url: string } {
	return { id, url: `https://checkout.stripe.test/session/${id}` };
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeMetadata(metadata: Stripe.MetadataParam | undefined): Stripe.Metadata | null {
	if (metadata === undefined) {
		return null;
	}
	return Object.fromEntries(
		Object.entries(metadata)
			.filter((entry): entry is [string, string | number] => entry[1] !== null)
			.map(([key, value]) => [key, String(value)]),
	);
}
