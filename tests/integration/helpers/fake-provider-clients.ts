import type Stripe from "stripe";
import type {
	AppleDecodedNotificationPayload,
	AppleDecodedRenewalInfoPayload,
	AppleDecodedTransactionPayload,
} from "../../../src/providers/apple/types";

type JsonRecord = Record<string, unknown>;
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

	return {
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
	};
}

export function createFakeGooglePlayClient(options: FakeGooglePlayClientOptions) {
	const calls: string[] = [];
	const productId = options.productId ?? "echo_credits_10";
	const subscriptionProductId = options.subscriptionProductId ?? "premium_monthly";
	const basePlanId = options.basePlanId ?? "monthly-base";
	const quantity = options.quantity ?? 1;
	let refundableQuantity = options.refundableQuantity ?? quantity;
	let productPurchaseState = "PURCHASED";

	return {
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
	};
}

export function createFakeStripeBillingClient(options: FakeStripeBillingClientOptions = {}) {
	const calls: string[] = [];
	const checkoutSessionParams: Stripe.Checkout.SessionCreateParams[] = [];
	const portalSessionParams: Stripe.BillingPortal.SessionCreateParams[] = [];
	let checkoutSessionFailuresRemaining = options.createCheckoutSessionFailures ?? 0;
	const event =
		options.event ?? stripeEvent("customer.subscription.updated", stripeSubscriptionObject());

	return {
		calls,
		checkoutSessionParams,
		client: {
			async createCheckoutSession(params: Stripe.Checkout.SessionCreateParams) {
				calls.push("createCheckoutSession");
				checkoutSessionParams.push(params);
				if (checkoutSessionFailuresRemaining > 0) {
					checkoutSessionFailuresRemaining -= 1;
					throw new Error("Fake Stripe Checkout is temporarily unavailable");
				}

				return {
					id: "cs_test_integration",
					url: "https://checkout.stripe.test/session/cs_test_integration",
				};
			},
			async createCustomer(input: { billingAccountId: string; email: string | null }) {
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

				return stripeCheckoutSessionObject({ id: sessionId });
			},
			async retrieveSubscription(subscriptionId: string) {
				calls.push(`retrieveSubscription:${subscriptionId}`);

				return stripeSubscriptionObject({ id: subscriptionId });
			},
		},
		portalSessionParams,
	};
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
