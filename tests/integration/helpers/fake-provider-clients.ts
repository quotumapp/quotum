import type Stripe from "stripe";
import type {
	AppleDecodedNotificationPayload,
	AppleDecodedRenewalInfoPayload,
	AppleDecodedTransactionPayload,
} from "../../../src/providers/apple/types";
import { createFakeStripePromotions } from "../../../src/providers/stripe/testing/fake-promotions";

type JsonRecord = Record<string, unknown>;

function attachFailNext<T extends { client: object }>(value: T) {
	const pending = new Map<string, Error>();
	const client = new Proxy(value.client, {
		get(target, prop, receiver) {
			const orig = Reflect.get(target, prop, receiver);
			if (typeof orig !== "function") {
				return orig;
			}
			return (...args: unknown[]) => {
				const error = pending.get(String(prop));
				if (error !== undefined) {
					pending.delete(String(prop));
					throw error;
				}
				return orig.apply(target, args);
			};
		},
	});
	return {
		...value,
		client,
		failNext(method: string, error: Error) {
			pending.set(method, error);
		},
	};
}
type AppleDateInput = Date | number | string;
const farFutureSubscriptionExpiry = "2099-06-30T00:00:00.000Z";
const farFutureSubscriptionPeriodEnd = 4_086_460_800;
const seededStripeEchoCreditsAmount = 499;

interface FakeAppleStoreKitClientOptions {
	transactionId: string;
	originalTransactionId: string;
	productId?: string;
	purchaseDate?: AppleDateInput;
	expiresDate?: AppleDateInput;
}

interface FakeGooglePlayClientOptions {
	obfuscatedAccountId: string;
	productId?: string;
	subscriptionProductId?: string;
	basePlanId?: string;
	quantity?: number;
	refundableQuantity?: number;
}

interface FakeStripeBillingClientOptions {
	event?: JsonRecord;
	constructWebhookError?: Error;
	createCustomerId?: (input: { billingAccountId: string; email: string | null }) => string;
	createCheckoutSessionFailures?: number;
	checkoutSession?: JsonRecord;
}

export function createFakeAppleStoreKitClient(options: FakeAppleStoreKitClientOptions) {
	const calls: string[] = [];
	let appAccountToken = "00000000-0000-0000-0000-000000000000";
	let renewalAppAccountToken: string | undefined = appAccountToken;
	let transactionAppAccountToken: string | undefined = appAccountToken;

	const renewalInfo = (): AppleDecodedRenewalInfoPayload => ({
		autoRenewProductId: options.productId ?? "premium_monthly",
		autoRenewStatus: 1,
		environment: "Sandbox",
		...appleAccountTokenPayload(renewalAppAccountToken),
	});
	const transaction = (): AppleDecodedTransactionPayload => ({
		bundleId: "com.voysee.app",
		environment: "Sandbox",
		expiresDate: appleDateMillis(options.expiresDate ?? farFutureSubscriptionExpiry),
		originalTransactionId: options.originalTransactionId,
		productId: options.productId ?? "premium_monthly",
		purchaseDate: appleDateMillis(options.purchaseDate ?? "2026-05-31T00:00:00.000Z"),
		transactionId: options.transactionId,
		type: "Auto-Renewable Subscription",
		webOrderLineItemId: `${options.originalTransactionId}_line`,
		...appleAccountTokenPayload(transactionAppAccountToken),
	});
	const notification = (): AppleDecodedNotificationPayload => ({
		data: {
			bundleId: "com.voysee.app",
			environment: "Sandbox",
			status: 1,
		},
		notificationType: "DID_RENEW",
		notificationUUID: "00000000-0000-0000-0000-000000000001",
	});

	return attachFailNext({
		calls,
		client: {
			async getLatestSubscriptionStatus(originalTransactionId: string) {
				calls.push(`getLatestSubscriptionStatus:${originalTransactionId}`);

				return {
					environment: "sandbox" as const,
					renewalInfo: renewalInfo(),
					storeKitStatus: 1,
					transaction: transaction(),
				};
			},
			async verifyNotification(signedPayload: string) {
				calls.push(`verifyNotification:${signedPayload}`);

				return {
					environment: "sandbox" as const,
					notification: notification(),
					renewalInfo: renewalInfo(),
					transaction: transaction(),
				};
			},
			async verifyTransaction(transactionId: string) {
				calls.push(`verifyTransaction:${transactionId}`);

				return {
					environment: "sandbox" as const,
					renewalInfo: renewalInfo(),
					transaction: transaction(),
				};
			},
		},
		setAppAccountToken(token: string) {
			appAccountToken = token;
			renewalAppAccountToken = token;
			transactionAppAccountToken = token;
		},
		setRenewalAppAccountToken(token: string | undefined) {
			renewalAppAccountToken = token;
		},
		setTransactionAppAccountToken(token: string | undefined) {
			transactionAppAccountToken = token;
		},
	});
}

export function createFakeGooglePlayClient(options: FakeGooglePlayClientOptions) {
	const calls: string[] = [];
	const productId = options.productId ?? "echo_credits_10";
	const subscriptionProductId = options.subscriptionProductId ?? "premium_monthly";
	const basePlanId = options.basePlanId ?? "monthly-base";
	const quantity = options.quantity ?? 1;
	let refundableQuantity = options.refundableQuantity ?? quantity;
	let productPurchaseState = "PURCHASED";
	let subscriptionLineItemOverrides: Record<string, unknown> = {};

	return attachFailNext({
		calls,
		client: {
			async acknowledgeProductPurchase(productId: string, token: string) {
				calls.push(`acknowledgeProductPurchase:${productId}:${token}`);
			},
			async acknowledgeSubscriptionPurchase(
				subscriptionId: string,
				token: string,
				obfuscatedAccountId: string,
			) {
				calls.push(
					`acknowledgeSubscriptionPurchase:${subscriptionId}:${token}:${obfuscatedAccountId}`,
				);
			},
			async consumeProductPurchase(productId: string, token: string) {
				calls.push(`consumeProductPurchase:${productId}:${token}`);
			},
			async getProductPurchase(token: string) {
				calls.push(`getProductPurchase:${token}`);

				return {
					acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
					obfuscatedExternalAccountId: options.obfuscatedAccountId,
					orderId: "GPA.1111-2222-3333-44444",
					productLineItem: [
						{
							productId,
							productOfferDetails: {
								consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
								quantity,
								refundableQuantity,
							},
						},
					],
					purchaseCompletionTime: "2026-05-31T00:00:00.000Z",
					purchaseStateContext: {
						purchaseState: productPurchaseState,
					},
				};
			},
			async getSubscriptionPurchase(token: string) {
				calls.push(`getSubscriptionPurchase:${token}`);

				return {
					acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
					externalAccountIdentifiers: {
						obfuscatedExternalAccountId: options.obfuscatedAccountId,
					},
					latestOrderId: "GPA.5555-6666-7777-88888",
					lineItems: [
						{
							autoRenewingPlan: {
								autoRenewEnabled: true,
							},
							expiryTime: farFutureSubscriptionExpiry,
							offerDetails: {
								basePlanId,
							},
							productId: subscriptionProductId,
							...subscriptionLineItemOverrides,
						},
					],
					startTime: "2026-05-31T00:00:00.000Z",
					subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
				};
			},
		},
		setProductPurchaseState(state: "PURCHASED" | "CANCELLED") {
			productPurchaseState = state;
		},
		setRefundableQuantity(value: number) {
			refundableQuantity = value;
		},
		/** Merges fields such as `offerPhase` or `expiryTime` into the subscription line item. */
		setSubscriptionLineItem(overrides: Record<string, unknown>) {
			subscriptionLineItemOverrides = overrides;
		},
	});
}

export function createFakeStripeBillingClient(options: FakeStripeBillingClientOptions = {}) {
	const calls: string[] = [];
	const checkoutSessionParams: Stripe.Checkout.SessionCreateParams[] = [];
	const portalSessionParams: Stripe.BillingPortal.SessionCreateParams[] = [];
	const expiredSessions = new Set<string>();
	const invoices = new Map<
		string,
		{
			id: string;
			total: number;
			status: "draft" | "open" | "paid" | "void";
			currency: string;
			paymentIntentId: string;
		}
	>();
	let checkoutSessionFailuresRemaining = options.createCheckoutSessionFailures ?? 0;
	const promotions = createFakeStripePromotions();
	const subscriptionUpdates: Array<{
		subscriptionId: string;
		params: Stripe.SubscriptionUpdateParams;
		idempotencyKey: string;
	}> = [];
	const subscriptionCancellations: Array<{ subscriptionId: string; idempotencyKey: string }> = [];
	const setupSessions = new Map<
		string,
		{
			id: string;
			customerId: string;
			setupIntentId: string;
			status: "open" | "complete" | "expired";
			paymentMethod: JsonRecord | null;
		}
	>();
	const setupSessionsByIdempotencyKey = new Map<string, string>();
	const defaultPaymentMethodWrites: Array<{
		customerId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	}> = [];
	const invoiceCreateParams: Stripe.InvoiceCreateParams[] = [];
	const subscriptionDiscounts = new Map<string, Array<{ id: string; couponId: string | null }>>();
	let event =
		options.event ?? stripeEvent("customer.subscription.updated", stripeSubscriptionObject());

	const requireSetupSession = (sessionId: string) => {
		const session = setupSessions.get(sessionId);
		if (session === undefined) throw new Error(`Unknown fake Stripe setup session: ${sessionId}`);
		return session;
	};

	return attachFailNext({
		calls,
		checkoutSessionParams,
		defaultPaymentMethodWrites,
		invoiceCreateParams,
		/** The event the next verified webhook delivers; the signature check itself is faked. */
		setWebhookEvent(next: JsonRecord) {
			event = next;
		},
		/** Drives the fake through a customer finishing hosted setup with a saved card. */
		completeSetupSession(sessionId: string) {
			const session = requireSetupSession(sessionId);
			session.status = "complete";
			session.paymentMethod = {
				id: `pm_setup_${sessionId}`,
				type: "card",
				card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2031 },
			};
			return { setupIntentId: session.setupIntentId, paymentMethodId: `pm_setup_${sessionId}` };
		},
		/** Drives the fake through a hosted link the customer never finished. */
		expireSetupSession(sessionId: string) {
			requireSetupSession(sessionId).status = "expired";
		},
		promotions: promotions.state,
		subscriptionUpdates,
		subscriptionCancellations,
		subscriptionDiscounts,
		client: {
			async retrieveSubscriptionDiscounts(subscriptionId: string) {
				calls.push(`retrieveSubscriptionDiscounts:${subscriptionId}`);
				return subscriptionDiscounts.get(subscriptionId) ?? [];
			},
			async updateSubscription(
				subscriptionId: string,
				params: Stripe.SubscriptionUpdateParams,
				idempotencyKey: string,
			) {
				calls.push(`updateSubscription:${idempotencyKey}`);
				subscriptionUpdates.push({ subscriptionId, params, idempotencyKey });
				return { id: subscriptionId };
			},
			async cancelSubscription(subscriptionId: string, idempotencyKey: string) {
				calls.push(`cancelSubscription:${idempotencyKey}`);
				subscriptionCancellations.push({ subscriptionId, idempotencyKey });
				return { id: subscriptionId };
			},
			createCoupon: promotions.createCoupon,
			retrieveCoupon: promotions.retrieveCoupon,
			createPromotionCode: promotions.createPromotionCode,
			updatePromotionCode: promotions.updatePromotionCode,
			findPromotionCodes: promotions.findPromotionCodes,
			async createCheckoutSession(
				params: Stripe.Checkout.SessionCreateParams,
				idempotencyKey?: string,
			) {
				calls.push("createCheckoutSession");
				checkoutSessionParams.push(params);
				if (checkoutSessionFailuresRemaining > 0) {
					checkoutSessionFailuresRemaining -= 1;
					throw new Error("Fake Stripe Checkout is temporarily unavailable");
				}
				if (params.mode !== "setup") {
					return {
						id: "cs_test_integration",
						url: "https://checkout.stripe.test/session/cs_test_integration",
					};
				}
				// Stripe replays the original session for a repeated idempotency key.
				const existing =
					idempotencyKey === undefined
						? undefined
						: setupSessionsByIdempotencyKey.get(idempotencyKey);
				const id = existing ?? `cs_setup_integration_${setupSessions.size + 1}`;
				if (existing === undefined) {
					setupSessions.set(id, {
						id,
						customerId: String(params.customer ?? ""),
						setupIntentId: `seti_${id}`,
						status: "open",
						paymentMethod: null,
					});
					if (idempotencyKey !== undefined) setupSessionsByIdempotencyKey.set(idempotencyKey, id);
				}
				return { id, url: `https://checkout.stripe.test/setup/${id}` };
			},
			async retrieveSetupCheckoutSession(sessionId: string) {
				calls.push(`retrieveSetupCheckoutSession:${sessionId}`);
				const session = requireSetupSession(sessionId);
				return {
					id: session.id,
					mode: "setup",
					status: session.status,
					setup_intent: session.setupIntentId,
				};
			},
			async retrieveSetupIntent(setupIntentId: string) {
				calls.push(`retrieveSetupIntent:${setupIntentId}`);
				const session = [...setupSessions.values()].find(
					(entry) => entry.setupIntentId === setupIntentId,
				);
				if (session === undefined) {
					throw new Error(`Unknown fake Stripe setup intent: ${setupIntentId}`);
				}
				return {
					id: setupIntentId,
					status: session.paymentMethod === null ? "requires_payment_method" : "succeeded",
					customer: session.customerId,
					payment_method: session.paymentMethod,
				};
			},
			async updateCustomerDefaultPaymentMethod(input: {
				customerId: string;
				paymentMethodId: string;
				idempotencyKey: string;
			}) {
				calls.push(`updateCustomerDefaultPaymentMethod:${input.idempotencyKey}`);
				defaultPaymentMethodWrites.push(input);
			},
			async createCustomer(input: {
				billingAccountId: string;
				email: string | null;
				idempotencyScope?: string | null;
			}) {
				const { billingAccountId } = input;
				calls.push(`createCustomer:${billingAccountId}`);

				return {
					id:
						options.createCustomerId?.(input) ??
						stripeCustomerIdForBillingAccount(billingAccountId),
				};
			},
			async createPortalSession(params: Stripe.BillingPortal.SessionCreateParams) {
				calls.push("createPortalSession");
				portalSessionParams.push(params);

				return { url: "https://billing.stripe.test/session/bps_integration" };
			},
			constructWebhookEvent(rawBody: string, signature: string) {
				calls.push(`constructWebhookEvent:${rawBody}:${signature}`);

				if (options.constructWebhookError !== undefined) {
					throw options.constructWebhookError;
				}

				return event;
			},
			async retrieveCheckoutSession(sessionId: string) {
				calls.push(`retrieveCheckoutSession:${sessionId}`);
				const expired = expiredSessions.has(sessionId);
				return stripeCheckoutSessionObject({
					id: sessionId,
					...(options.checkoutSession ?? {}),
					...(expired ? { status: "expired", payment_status: "unpaid" } : {}),
				});
			},
			async expireCheckoutSession(sessionId: string) {
				calls.push(`expireCheckoutSession:${sessionId}`);
				expiredSessions.add(sessionId);
			},
			async retrieveSubscription(subscriptionId: string) {
				calls.push(`retrieveSubscription:${subscriptionId}`);

				return stripeSubscriptionObject({ id: subscriptionId });
			},
			async retrieveDefaultPaymentMethod(customerId: string) {
				calls.push(`retrieveDefaultPaymentMethod:${customerId}`);
				// A completed hosted setup is what puts a card here, exactly as Stripe would.
				const saved = defaultPaymentMethodWrites.findLast(
					(write) => write.customerId === customerId,
				);
				return saved?.paymentMethodId ?? "pm_integration";
			},
			async createInvoice(params: Stripe.InvoiceCreateParams, idempotencyKey: string) {
				calls.push(`createInvoice:${idempotencyKey}`);
				invoiceCreateParams.push(params);
				const id = `in_integration_${idempotencyKey}`;
				invoices.set(id, {
					id,
					total: 0,
					status: "draft",
					currency: params.currency ?? "usd",
					paymentIntentId: `pi_integration_${idempotencyKey}`,
				});
				return { id };
			},
			async addInvoiceLines(
				invoiceId: string,
				_params: Stripe.InvoiceAddLinesParams,
				idempotencyKey: string,
			) {
				calls.push(`addInvoiceLines:${idempotencyKey}`);
				const invoice = invoices.get(invoiceId);
				if (invoice === undefined) throw new Error(`Unknown fake Stripe invoice: ${invoiceId}`);
				invoice.total = seededStripeEchoCreditsAmount;
				return stripeInvoiceReceipt(invoice);
			},
			async finalizeInvoice(invoiceId: string, idempotencyKey: string) {
				calls.push(`finalizeInvoice:${idempotencyKey}`);
				const invoice = invoices.get(invoiceId);
				if (invoice === undefined) throw new Error(`Unknown fake Stripe invoice: ${invoiceId}`);
				if (invoice.status === "draft") invoice.status = "open";
				return stripeInvoiceReceipt(invoice);
			},
			async payInvoice(invoiceId: string, idempotencyKey: string) {
				calls.push(`payInvoice:${idempotencyKey}`);
				const invoice = invoices.get(invoiceId);
				if (invoice === undefined) throw new Error(`Unknown fake Stripe invoice: ${invoiceId}`);
				invoice.status = "paid";
				return stripeInvoiceReceipt(invoice);
			},
			async voidInvoice(invoiceId: string, idempotencyKey: string) {
				calls.push(`voidInvoice:${idempotencyKey}`);
				const invoice = invoices.get(invoiceId);
				if (invoice === undefined) throw new Error(`Unknown fake Stripe invoice: ${invoiceId}`);
				invoice.status = "void";
				return stripeInvoiceReceipt(invoice);
			},
		},
		portalSessionParams,
	});
}

function stripeCustomerIdForBillingAccount(billingAccountId: string): string {
	const normalized = billingAccountId.trim();
	if (normalized === "integration_user") {
		return "cus_integration";
	}

	const sanitized = normalized.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return `cus_${sanitized || "customer"}`;
}

export function stripeEvent(type: string, object: JsonRecord, id = `${type}:evt`) {
	return {
		data: { object },
		id,
		type,
	};
}

export function stripeSubscriptionObject(overrides: JsonRecord = {}) {
	return {
		cancel_at_period_end: false,
		created: 1_779_840_000,
		current_period_end: farFutureSubscriptionPeriodEnd,
		customer: "cus_integration",
		id: "sub_1",
		items: {
			data: [
				{
					current_period_end: farFutureSubscriptionPeriodEnd,
					id: "si_integration",
					price: {
						id: "price_premium_monthly",
						product: "prod_stripe_premium",
					},
				},
			],
		},
		latest_invoice: "in_integration",
		metadata: {
			billingAccountId: "integration_user",
			externalPriceId: "price_premium_monthly",
			externalProductId: "prod_stripe_premium",
			productKey: "premium_monthly",
			purchaseKind: "subscription",
		},
		object: "subscription",
		status: "active",
		...overrides,
	};
}

function stripeInvoiceReceipt(invoice: {
	id: string;
	total: number;
	status: "draft" | "open" | "paid" | "void";
	currency: string;
	paymentIntentId: string;
}) {
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

export function stripeCheckoutSessionObject(overrides: JsonRecord = {}) {
	return {
		amount_total: seededStripeEchoCreditsAmount,
		charge: "ch_integration",
		client_reference_id: "integration_user",
		created: 1_779_840_000,
		currency: "usd",
		customer: "cus_integration",
		id: "cs_test_integration",
		latest_charge: "ch_integration",
		metadata: {
			billingAccountId: "integration_user",
			externalPriceId: "price_credits_10",
			externalProductId: "prod_stripe_credits_10",
			productKey: "echo_credits_10",
			purchaseKind: "consumable",
		},
		mode: "payment",
		object: "checkout.session",
		payment_intent: {
			id: "pi_integration",
			latest_charge: "ch_integration",
			metadata: {
				billingAccountId: "integration_user",
			},
		},
		payment_status: "paid",
		status: "complete",
		...overrides,
	};
}

export function stripeRefundObject(overrides: JsonRecord = {}) {
	return {
		amount: seededStripeEchoCreditsAmount,
		charge: "ch_integration",
		created: 1_779_840_000,
		currency: "usd",
		customer: "cus_integration",
		id: "re_integration",
		metadata: {
			billingAccountId: "integration_user",
			productKey: "echo_credits_10",
		},
		object: "refund",
		payment_intent: "pi_integration",
		reason: "requested_by_customer",
		status: "succeeded",
		...overrides,
	};
}

export function stripeRefundedChargeObject(overrides: JsonRecord = {}) {
	return {
		amount_refunded: seededStripeEchoCreditsAmount,
		created: 1_779_840_000,
		currency: "usd",
		customer: "cus_integration",
		id: "ch_integration",
		object: "charge",
		payment_intent: "pi_integration",
		...overrides,
	};
}

function appleDateMillis(input: AppleDateInput): number {
	if (typeof input === "number") {
		return input;
	}

	return new Date(input).getTime();
}

function appleAccountTokenPayload(token: string | undefined): { appAccountToken?: string } {
	return token === undefined ? {} : { appAccountToken: token };
}
