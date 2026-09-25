import { createHash, randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { StripeBillingConfig } from "../client";
import type { StripeBillingClientDependency } from "../service";
import { createFakeStripeIdempotency } from "./fake-idempotency";
import { createFakeStripePromotions } from "./fake-promotions";

interface FakeCheckoutSession {
	id: string;
	clientReferenceId: string | null;
	metadata: Stripe.Metadata | null;
	mode: Stripe.Checkout.SessionCreateParams.Mode;
	currency: string | null;
	status: "open" | "complete" | "expired";
	setupIntentId: string | null;
}

/** A hosted setup that the fake has taken through to a saved card. */
interface FakeSetupIntent {
	id: string;
	customerId: string;
	status: "requires_payment_method" | "succeeded";
	paymentMethod: Record<string, unknown> | null;
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
	private readonly subscriptionsByIdempotencyKey = new Map<string, Record<string, unknown>>();
	/** Every subscriptions.create, so a test can assert the saved-card plan start. */
	readonly subscriptionCreates: Array<{
		params: Stripe.SubscriptionCreateParams;
		idempotencyKey: string;
	}> = [];
	/** When set, the next create stores the subscription and then throws, as a lost response. */
	loseNextSubscriptionCreate = false;
	private readonly invoices = new Map<string, FakeInvoice>();
	private readonly invoicesByIdempotencyKey = new Map<string, FakeInvoice>();
	private readonly invoiceLineKeys = new Set<string>();
	private readonly setupIntents = new Map<string, FakeSetupIntent>();
	/** Every default-payment-method write, so a test can assert exactly what was promoted. */
	readonly defaultPaymentMethodWrites: Array<{
		customerId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	}> = [];
	private readonly subscriptionUpdates = new Map<string, { id: string }>();
	private readonly subscriptionCancellations = new Map<string, { id: string }>();
	private readonly subscriptionDiscounts = new Map<
		string,
		Array<{ id: string; couponId: string | null }>
	>();
	private readonly priceAmountsMinor: Readonly<Record<string, number>>;
	/** Every invoice creation, so a test can assert what the charge was attached to. */
	readonly invoiceCreateParams: Stripe.InvoiceCreateParams[] = [];
	private readonly failures = new Map<string, Error>();
	private readonly idempotency = createFakeStripeIdempotency();
	readonly promotions = createFakeStripePromotions(this.idempotency);
	readonly createCoupon = this.promotions.createCoupon;
	readonly retrieveCoupon = this.promotions.retrieveCoupon;
	readonly createPromotionCode = this.promotions.createPromotionCode;
	readonly updatePromotionCode = this.promotions.updatePromotionCode;
	readonly findPromotionCodes = this.promotions.findPromotionCodes;

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

	failNext(method: string, error: Error): void {
		this.failures.set(method, error);
	}

	private throwIfFailed(method: string): void {
		const error = this.failures.get(method);
		if (error !== undefined) {
			this.failures.delete(method);
			throw error;
		}
	}

	async createCustomer(input: {
		billingAccountId: string;
		email: string | null;
		idempotencyScope?: string | null;
	}): Promise<{ id: string }> {
		this.throwIfFailed("createCustomer");
		return { id: `cus_fake_${digest(input.billingAccountId).slice(0, 24)}` };
	}

	async createCheckoutSession(
		params: Stripe.Checkout.SessionCreateParams,
		idempotencyKey?: string,
	): Promise<{ id: string; url: string }> {
		this.throwIfFailed("createCheckoutSession");
		this.idempotency.claim(idempotencyKey, "POST /v1/checkout/sessions", params);
		const existing =
			idempotencyKey === undefined ? undefined : this.sessionsByIdempotencyKey.get(idempotencyKey);
		if (existing !== undefined) {
			return checkoutRedirect(existing.id);
		}

		const id = `cs_fake_${digest(idempotencyKey ?? randomUUID()).slice(0, 24)}`;
		const mode = params.mode ?? "payment";
		const session: FakeCheckoutSession = {
			id,
			clientReferenceId: params.client_reference_id ?? null,
			metadata: normalizeMetadata(params.metadata),
			mode,
			currency: params.currency ?? null,
			status: "open",
			setupIntentId: mode === "setup" ? `seti_fake_${digest(id).slice(0, 24)}` : null,
		};
		if (session.setupIntentId !== null) {
			this.setupIntents.set(session.setupIntentId, {
				id: session.setupIntentId,
				customerId: String(params.customer ?? ""),
				status: "requires_payment_method",
				paymentMethod: null,
			});
		}
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

	/** Drives the fake through a customer finishing hosted setup and saving a card. */
	completeSetupSession(
		sessionId: string,
		card: { brand: string; last4: string; expMonth: number; expYear: number } = {
			brand: "visa",
			last4: "4242",
			expMonth: 12,
			expYear: 2031,
		},
	): { setupIntentId: string; paymentMethodId: string } {
		const session = this.requireSession(sessionId);
		const setupIntentId = session.setupIntentId;
		if (setupIntentId === null) throw new Error(`Session ${sessionId} is not a setup session`);
		const paymentMethodId = `pm_fake_${digest(setupIntentId).slice(0, 24)}`;
		session.status = "complete";
		this.setupIntents.set(setupIntentId, {
			id: setupIntentId,
			customerId: this.setupIntents.get(setupIntentId)?.customerId ?? "",
			status: "succeeded",
			paymentMethod: {
				id: paymentMethodId,
				type: "card",
				card: {
					brand: card.brand,
					last4: card.last4,
					exp_month: card.expMonth,
					exp_year: card.expYear,
				},
			},
		});
		return { setupIntentId, paymentMethodId };
	}

	/** Drives the fake through a hosted link the customer never finished. */
	expireSetupSession(sessionId: string): void {
		this.requireSession(sessionId).status = "expired";
	}

	async retrieveSetupCheckoutSession(sessionId: string): Promise<Record<string, unknown>> {
		this.throwIfFailed("retrieveSetupCheckoutSession");
		const session = this.requireSession(sessionId);
		return {
			id: session.id,
			mode: session.mode,
			status: session.status,
			currency: session.currency,
			client_reference_id: session.clientReferenceId,
			metadata: session.metadata,
			setup_intent: session.setupIntentId,
		};
	}

	async retrieveSetupIntent(setupIntentId: string): Promise<Record<string, unknown>> {
		this.throwIfFailed("retrieveSetupIntent");
		const intent = this.setupIntents.get(setupIntentId);
		if (intent === undefined) {
			throw new Error(`Unknown fake Stripe setup intent: ${setupIntentId}`);
		}
		return {
			id: intent.id,
			status: intent.status,
			customer: intent.customerId,
			payment_method: intent.paymentMethod,
		};
	}

	async updateCustomerDefaultPaymentMethod(input: {
		customerId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	}): Promise<void> {
		this.throwIfFailed("updateCustomerDefaultPaymentMethod");
		this.idempotency.claim(input.idempotencyKey, `POST /v1/customers/${input.customerId}`, {
			invoice_settings: { default_payment_method: input.paymentMethodId },
		});
		this.defaultPaymentMethodWrites.push(input);
	}

	private requireSession(sessionId: string): FakeCheckoutSession {
		const session = this.sessions.get(sessionId);
		if (session === undefined) {
			throw new Error(`Unknown fake Stripe Checkout session: ${sessionId}`);
		}
		return session;
	}

	async retrieveCheckoutSession(sessionId: string) {
		const session = this.requireSession(sessionId);
		return {
			id: session.id,
			status: session.mode === "setup" ? session.status : "complete",
			payment_status: session.mode === "setup" ? null : "paid",
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

	async createSubscription(
		params: Stripe.SubscriptionCreateParams,
		idempotencyKey: string,
	): Promise<Record<string, unknown>> {
		this.throwIfFailed("createSubscription");
		const replay = this.subscriptionsByIdempotencyKey.get(idempotencyKey);
		if (replay !== undefined) return replay;
		this.subscriptionCreates.push({ params, idempotencyKey });
		const id = `sub_fake_${digest(idempotencyKey).slice(0, 24)}`;
		const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
		const metadata = (params.metadata ?? {}) as Record<string, string>;
		const subscription: Record<string, unknown> = {
			id,
			customer: params.customer,
			status: (params.trial_period_days ?? 0) > 0 ? "trialing" : "active",
			created: Math.floor(Date.now() / 1000),
			current_period_end: periodEnd,
			cancel_at_period_end: false,
			metadata,
			latest_invoice: null,
			items: {
				data: (params.items ?? []).map((item, index) => ({
					id: `si_${id}_${index}`,
					quantity: item.quantity ?? 1,
					current_period_end: periodEnd,
					price: {
						id: item.price,
						product:
							typeof metadata.externalProductId === "string"
								? metadata.externalProductId
								: "prod_fake",
					},
				})),
			},
		};
		this.subscriptions.set(id, subscription);
		this.subscriptionsByIdempotencyKey.set(idempotencyKey, subscription);
		if (this.loseNextSubscriptionCreate) {
			this.loseNextSubscriptionCreate = false;
			throw new Error("Fake Stripe subscription create response was lost");
		}
		return subscription;
	}

	async listCustomerSubscriptions(customerId: string): Promise<Array<Record<string, unknown>>> {
		this.throwIfFailed("listCustomerSubscriptions");
		return [...this.subscriptions.values()].filter(
			(subscription) => subscription.customer === customerId,
		);
	}

	async retrieveDefaultPaymentMethod(customerId: string): Promise<string | null> {
		const saved = [...this.defaultPaymentMethodWrites]
			.reverse()
			.find((write) => write.customerId === customerId);
		if (saved !== undefined) return saved.paymentMethodId;
		return this.options.defaultPaymentMethod === undefined
			? "pm_fake_default"
			: this.options.defaultPaymentMethod;
	}

	async updateSubscription(
		subscriptionId: string,
		params: Stripe.SubscriptionUpdateParams,
		idempotencyKey: string,
	): Promise<{ id: string }> {
		this.throwIfFailed("updateSubscription");
		this.idempotency.claim(idempotencyKey, `POST /v1/subscriptions/${subscriptionId}`, params);
		const existing = this.subscriptionUpdates.get(idempotencyKey);
		if (existing !== undefined) return existing;
		const updated = { id: subscriptionId };
		this.subscriptionUpdates.set(idempotencyKey, updated);
		if (Array.isArray(params.discounts)) {
			const previous = this.subscriptionDiscounts.get(subscriptionId) ?? [];
			this.subscriptionDiscounts.set(
				subscriptionId,
				params.discounts.map((discount, index) =>
					discount.discount !== undefined
						? (previous.find((entry) => entry.id === discount.discount) ?? {
								id: discount.discount,
								couponId: null,
							})
						: {
								id: `di_fake_${digest(`${subscriptionId}:${index}`).slice(0, 16)}`,
								couponId: discount.coupon ?? null,
							},
				),
			);
		}
		return updated;
	}

	/** Cancelled subscriptions end now, as Stripe reports them once `ended_at` is set. */
	async cancelSubscription(
		subscriptionId: string,
		idempotencyKey: string,
	): Promise<{ id: string }> {
		this.throwIfFailed("cancelSubscription");
		this.idempotency.claim(idempotencyKey, `DELETE /v1/subscriptions/${subscriptionId}`);
		const existing = this.subscriptionCancellations.get(idempotencyKey);
		if (existing !== undefined) return existing;
		const cancelled = { id: subscriptionId };
		this.subscriptionCancellations.set(idempotencyKey, cancelled);
		return cancelled;
	}

	async retrieveSubscriptionDiscounts(
		subscriptionId: string,
	): Promise<Array<{ id: string; couponId: string | null }>> {
		this.throwIfFailed("retrieveSubscriptionDiscounts");
		return this.subscriptionDiscounts.get(subscriptionId) ?? [];
	}

	async createInvoice(
		params: Stripe.InvoiceCreateParams,
		idempotencyKey: string,
	): Promise<{ id: string }> {
		this.throwIfFailed("createInvoice");
		this.idempotency.claim(idempotencyKey, "POST /v1/invoices", params);
		this.invoiceCreateParams.push(params);
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
		this.idempotency.claim(idempotencyKey, `POST /v1/invoices/${invoiceId}/add_lines`, params);
		if (this.invoiceLineKeys.has(idempotencyKey)) return invoiceReceipt(invoice);
		for (const line of params.lines) invoice.total += this.lineAmount(line);
		this.invoiceLineKeys.add(idempotencyKey);
		return invoiceReceipt(invoice);
	}

	async finalizeInvoice(invoiceId: string, idempotencyKey: string): Promise<unknown> {
		const invoice = this.requireInvoice(invoiceId);
		this.idempotency.claim(idempotencyKey, `POST /v1/invoices/${invoiceId}/finalize`);
		if (invoice.status === "draft") invoice.status = "open";
		return invoiceReceipt(invoice);
	}

	async payInvoice(invoiceId: string, idempotencyKey: string): Promise<unknown> {
		this.throwIfFailed("payInvoice");
		const invoice = this.requireInvoice(invoiceId);
		this.idempotency.claim(idempotencyKey, `POST /v1/invoices/${invoiceId}/pay`);
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

	async voidInvoice(invoiceId: string, idempotencyKey: string): Promise<unknown> {
		const invoice = this.requireInvoice(invoiceId);
		this.idempotency.claim(idempotencyKey, `POST /v1/invoices/${invoiceId}/void`);
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
