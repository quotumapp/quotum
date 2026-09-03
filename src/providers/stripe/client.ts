import { createHash, randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { StripeBillingEnv } from "../../env";

export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

export interface StripeBillingConfig extends StripeBillingEnv {
	apiVersion: typeof STRIPE_API_VERSION;
}

interface StripeClientLike {
	customers: {
		create(
			params: Stripe.CustomerCreateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Customer>;
		retrieve?(
			customerId: string,
			params?: Stripe.CustomerRetrieveParams,
		): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
	};
	checkout: {
		sessions: {
			create(
				params: Stripe.Checkout.SessionCreateParams,
				options?: Stripe.RequestOptions,
			): Promise<Stripe.Checkout.Session>;
			retrieve(
				sessionId: string,
				params: Stripe.Checkout.SessionRetrieveParams,
			): Promise<Stripe.Checkout.Session>;
		};
	};
	billingPortal: {
		sessions: {
			create(
				params: Stripe.BillingPortal.SessionCreateParams,
				options?: Stripe.RequestOptions,
			): Promise<Stripe.BillingPortal.Session>;
		};
	};
	subscriptions: {
		retrieve(
			subscriptionId: string,
			params: Stripe.SubscriptionRetrieveParams,
		): Promise<Stripe.Subscription>;
		update?(
			subscriptionId: string,
			params: Stripe.SubscriptionUpdateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Subscription>;
	};
	invoices?: {
		create(
			params: Stripe.InvoiceCreateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Invoice>;
		addLines(
			invoiceId: string,
			params: Stripe.InvoiceAddLinesParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Invoice>;
		finalizeInvoice(
			invoiceId: string,
			params?: Stripe.InvoiceFinalizeInvoiceParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Invoice>;
		pay(
			invoiceId: string,
			params?: Stripe.InvoicePayParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Invoice>;
		voidInvoice?(
			invoiceId: string,
			params?: Stripe.InvoiceVoidInvoiceParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Invoice>;
	};
	webhooks: {
		constructEvent(rawBody: string, signature: string, secret: string): Stripe.Event;
		constructEventAsync?(rawBody: string, signature: string, secret: string): Promise<Stripe.Event>;
	};
}

export function buildStripeConfig(env: StripeBillingEnv): StripeBillingConfig {
	return { ...env, apiVersion: STRIPE_API_VERSION };
}

export class StripeBillingClient {
	private readonly stripe: StripeClientLike;

	constructor(
		private readonly config: StripeBillingConfig,
		stripe: StripeClientLike = new Stripe(config.secretKey, { apiVersion: config.apiVersion }),
	) {
		this.stripe = stripe;
	}

	createCustomer(input: {
		billingAccountId: string;
		email: string | null;
	}): Promise<Stripe.Customer> {
		const params: Stripe.CustomerCreateParams = {
			email: input.email ?? undefined,
			metadata: { billingAccountId: input.billingAccountId },
		};
		return this.stripe.customers.create(params, {
			idempotencyKey: stripeIdempotencyKey("customers:create", params),
		});
	}

	async retrieveDefaultPaymentMethod(customerId: string): Promise<string | null> {
		if (this.stripe.customers.retrieve === undefined) {
			throw new Error("Stripe customer retrieval is unavailable");
		}
		const customer = await this.stripe.customers.retrieve(customerId, {
			expand: ["invoice_settings.default_payment_method"],
		});
		if ("deleted" in customer && customer.deleted) return null;
		const paymentMethod = customer.invoice_settings.default_payment_method;
		if (typeof paymentMethod === "string") return paymentMethod;
		return paymentMethod?.id ?? null;
	}

	createCheckoutSession(params: Stripe.Checkout.SessionCreateParams, idempotencyKey?: string) {
		return this.stripe.checkout.sessions.create(params, {
			idempotencyKey: idempotencyKey ?? stripeOperationIdempotencyKey("checkout-sessions:create"),
		});
	}

	createPortalSession(params: Stripe.BillingPortal.SessionCreateParams) {
		return this.stripe.billingPortal.sessions.create(params, {
			idempotencyKey: stripeOperationIdempotencyKey("portal-sessions:create"),
		});
	}

	retrieveCheckoutSession(sessionId: string) {
		return this.stripe.checkout.sessions.retrieve(sessionId, {
			expand: ["payment_intent", "subscription"],
		});
	}

	retrieveSubscription(subscriptionId: string) {
		return this.stripe.subscriptions.retrieve(subscriptionId, {
			expand: ["latest_invoice"],
		});
	}

	updateSubscription(
		subscriptionId: string,
		params: Stripe.SubscriptionUpdateParams,
		idempotencyKey: string,
	) {
		if (this.stripe.subscriptions.update === undefined)
			throw new Error("Stripe subscription updates are unavailable");
		return this.stripe.subscriptions.update(subscriptionId, params, { idempotencyKey });
	}

	createInvoice(params: Stripe.InvoiceCreateParams, idempotencyKey: string) {
		if (this.stripe.invoices === undefined) throw new Error("Stripe invoices are unavailable");
		return this.stripe.invoices.create(params, { idempotencyKey });
	}

	addInvoiceLines(invoiceId: string, params: Stripe.InvoiceAddLinesParams, idempotencyKey: string) {
		if (this.stripe.invoices === undefined) throw new Error("Stripe invoices are unavailable");
		return this.stripe.invoices.addLines(invoiceId, params, { idempotencyKey });
	}

	finalizeInvoice(invoiceId: string, idempotencyKey: string) {
		if (this.stripe.invoices === undefined) throw new Error("Stripe invoices are unavailable");
		return this.stripe.invoices.finalizeInvoice(invoiceId, {}, { idempotencyKey });
	}

	payInvoice(invoiceId: string, idempotencyKey: string) {
		if (this.stripe.invoices === undefined) throw new Error("Stripe invoices are unavailable");
		return this.stripe.invoices.pay(
			invoiceId,
			{ expand: ["payments.data.payment.payment_intent"] },
			{ idempotencyKey },
		);
	}

	voidInvoice(invoiceId: string, idempotencyKey: string) {
		if (this.stripe.invoices?.voidInvoice === undefined) {
			throw new Error("Stripe invoice voiding is unavailable");
		}
		return this.stripe.invoices.voidInvoice(invoiceId, {}, { idempotencyKey });
	}

	async constructWebhookEvent(rawBody: string, signature: string): Promise<Stripe.Event> {
		if (this.stripe.webhooks.constructEventAsync !== undefined) {
			return await this.stripe.webhooks.constructEventAsync(
				rawBody,
				signature,
				this.config.webhookSecret,
			);
		}

		return this.stripe.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
	}
}

function stripeOperationIdempotencyKey(scope: string): string {
	return `quotum-api:${scope}:${randomUUID()}`;
}

function stripeIdempotencyKey(scope: string, params: unknown): string {
	return `quotum-api:${scope}:${createHash("sha256").update(canonicalJson(params)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	if (value === undefined) {
		return "null";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (value instanceof Date) {
		return JSON.stringify(value.toISOString());
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}
