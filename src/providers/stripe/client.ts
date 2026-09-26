import { createHash, randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { StripeBillingEnv } from "../../env";
import { canonicalJson } from "../../shared/canonical-json";

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

export interface StripeBillingConfig extends StripeBillingEnv {
	apiVersion: typeof STRIPE_API_VERSION;
}

/**
 * Checkout Session create parameters plus the card-only filter hosted setup needs. The pinned API
 * reference documents `allowed_payment_method_types` on Checkout Sessions, while stripe-node
 * 22.6.2 omits it there. Keep this extension narrow until the SDK catches up.
 * https://docs.stripe.com/api/checkout/sessions/create#allowed_payment_method_types
 */
export type StripeCheckoutSessionCreateParams = Stripe.Checkout.SessionCreateParams & {
	allowed_payment_method_types?: string[];
};

interface StripeClientLike {
	paymentIntents: { retrieve(id: string): Promise<Stripe.PaymentIntent> };
	customers: {
		create(
			params: Stripe.CustomerCreateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Customer>;
		retrieve?(
			customerId: string,
			params?: Stripe.CustomerRetrieveParams,
		): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
		update?(
			customerId: string,
			params: Stripe.CustomerUpdateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Customer>;
	};
	setupIntents?: {
		retrieve(
			setupIntentId: string,
			params?: Stripe.SetupIntentRetrieveParams,
		): Promise<Stripe.SetupIntent>;
	};
	checkout: {
		sessions: {
			create(
				params: StripeCheckoutSessionCreateParams,
				options?: Stripe.RequestOptions,
			): Promise<Stripe.Checkout.Session>;
			expire?(sessionId: string): Promise<Stripe.Checkout.Session>;
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
		cancel?(
			subscriptionId: string,
			params?: Stripe.SubscriptionCancelParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Subscription>;
		create?(
			params: Stripe.SubscriptionCreateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Subscription>;
		list?(params: Stripe.SubscriptionListParams): Promise<Stripe.ApiList<Stripe.Subscription>>;
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
	coupons?: {
		create(
			params: Stripe.CouponCreateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.Coupon>;
		retrieve(couponId: string): Promise<Stripe.Coupon>;
	};
	promotionCodes?: {
		create(
			params: Stripe.PromotionCodeCreateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.PromotionCode>;
		update(
			promotionCodeId: string,
			params: Stripe.PromotionCodeUpdateParams,
			options?: Stripe.RequestOptions,
		): Promise<Stripe.PromotionCode>;
		list(params: Stripe.PromotionCodeListParams): Promise<Stripe.ApiList<Stripe.PromotionCode>>;
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
		/** Scopes the idempotency key to one tenant, so two projects never share a created customer. */
		idempotencyScope?: string | null;
	}): Promise<Stripe.Customer> {
		const params: Stripe.CustomerCreateParams = {
			email: input.email ?? undefined,
			metadata: { billingAccountId: input.billingAccountId },
		};
		return this.stripe.customers.create(params, {
			idempotencyKey: stripeIdempotencyKey(
				"customers:create",
				input.idempotencyScope == null
					? params
					: {
							scope: input.idempotencyScope,
							params,
						},
			),
		});
	}

	/** Points the customer's invoice default at a saved method; nothing else on the customer moves. */
	async updateCustomerDefaultPaymentMethod(input: {
		customerId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	}): Promise<void> {
		if (this.stripe.customers.update === undefined) {
			throw new Error("Stripe customer updates are unavailable");
		}
		await this.stripe.customers.update(
			input.customerId,
			{ invoice_settings: { default_payment_method: input.paymentMethodId } },
			{ idempotencyKey: input.idempotencyKey },
		);
	}

	async retrieveSetupIntent(setupIntentId: string): Promise<Record<string, unknown>> {
		if (this.stripe.setupIntents === undefined) {
			throw new Error("Stripe setup intents are unavailable");
		}
		const setupIntent = await this.stripe.setupIntents.retrieve(setupIntentId, {
			expand: ["payment_method"],
		});
		return setupIntent as unknown as Record<string, unknown>;
	}

	/** The hosted setup session with its SetupIntent and saved method, as stored provider facts. */
	async retrieveSetupCheckoutSession(sessionId: string): Promise<Record<string, unknown>> {
		const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
			expand: ["setup_intent", "setup_intent.payment_method"],
		});
		return session as unknown as Record<string, unknown>;
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

	createCheckoutSession(params: StripeCheckoutSessionCreateParams, idempotencyKey?: string) {
		return this.stripe.checkout.sessions.create(params, {
			idempotencyKey: idempotencyKey ?? stripeOperationIdempotencyKey("checkout-sessions:create"),
		});
	}

	createPortalSession(params: Stripe.BillingPortal.SessionCreateParams) {
		return this.stripe.billingPortal.sessions.create(params, {
			idempotencyKey: stripeOperationIdempotencyKey("portal-sessions:create"),
		});
	}

	expireCheckoutSession(sessionId: string) {
		if (!this.stripe.checkout.sessions.expire)
			throw new Error("Checkout expiration is unavailable");
		return this.stripe.checkout.sessions.expire(sessionId);
	}

	retrievePaymentIntent(id: string) {
		return this.stripe.paymentIntents.retrieve(id);
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

	async createSubscription(
		params: Stripe.SubscriptionCreateParams,
		idempotencyKey: string,
	): Promise<Record<string, unknown>> {
		if (this.stripe.subscriptions.create === undefined) {
			throw new Error("Stripe subscription creation is unavailable");
		}
		const subscription = await this.stripe.subscriptions.create(params, { idempotencyKey });
		return subscription as unknown as Record<string, unknown>;
	}

	async listCustomerSubscriptions(customerId: string): Promise<Array<Record<string, unknown>>> {
		if (this.stripe.subscriptions.list === undefined) {
			throw new Error("Stripe subscription listing is unavailable");
		}
		const page = await this.stripe.subscriptions.list({
			customer: customerId,
			status: "all",
			limit: 100,
		});
		return page.data as unknown as Array<Record<string, unknown>>;
	}

	/** The subscription's current discounts, so an update can keep them when adding a coupon. */
	async retrieveSubscriptionDiscounts(
		subscriptionId: string,
	): Promise<Array<{ id: string; couponId: string | null }>> {
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
			expand: ["discounts"],
		});
		return subscription.discounts.flatMap((discount) =>
			typeof discount === "string"
				? [{ id: discount, couponId: null }]
				: [
						{
							id: discount.id,
							couponId:
								typeof discount.source.coupon === "string"
									? discount.source.coupon
									: (discount.source.coupon?.id ?? null),
						},
					],
		);
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

	/**
	 * Ends the subscription now. Quotum asks for no proration credit and no closing invoice: an
	 * immediate cancellation ends access without refunding the paid period, and postpaid usage in
	 * the open period settles on its own window rather than being pulled forward.
	 */
	cancelSubscription(subscriptionId: string, idempotencyKey: string) {
		if (this.stripe.subscriptions.cancel === undefined)
			throw new Error("Stripe subscription cancellation is unavailable");
		return this.stripe.subscriptions.cancel(
			subscriptionId,
			{ prorate: false, invoice_now: false },
			{ idempotencyKey },
		);
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

	createCoupon(params: Stripe.CouponCreateParams, idempotencyKey: string) {
		if (this.stripe.coupons === undefined) throw new Error("Stripe coupons are unavailable");
		return this.stripe.coupons.create(params, { idempotencyKey });
	}

	retrieveCoupon(couponId: string) {
		if (this.stripe.coupons === undefined) throw new Error("Stripe coupons are unavailable");
		return this.stripe.coupons.retrieve(couponId);
	}

	createPromotionCode(params: Stripe.PromotionCodeCreateParams, idempotencyKey: string) {
		if (this.stripe.promotionCodes === undefined) {
			throw new Error("Stripe promotion codes are unavailable");
		}
		return this.stripe.promotionCodes.create(params, { idempotencyKey });
	}

	updatePromotionCode(
		promotionCodeId: string,
		params: Stripe.PromotionCodeUpdateParams,
		idempotencyKey: string,
	) {
		if (this.stripe.promotionCodes === undefined) {
			throw new Error("Stripe promotion codes are unavailable");
		}
		return this.stripe.promotionCodes.update(promotionCodeId, params, { idempotencyKey });
	}

	async findPromotionCodes(input: { code: string; coupon: string }) {
		if (this.stripe.promotionCodes === undefined) {
			throw new Error("Stripe promotion codes are unavailable");
		}
		const page = await this.stripe.promotionCodes.list({
			code: input.code,
			coupon: input.coupon,
			limit: 10,
		});
		return page.data;
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
