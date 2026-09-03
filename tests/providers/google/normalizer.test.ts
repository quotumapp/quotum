import { describe, expect, it } from "bun:test";
import {
	normalizeGoogleProductPurchase,
	normalizeGoogleSubscriptionPurchase,
	normalizeGoogleTestNotification,
	normalizeGoogleVoidedPurchase,
} from "../../../src/providers/google/normalizer";

const subscriptionPurchase = (overrides: Record<string, unknown> = {}) => ({
	subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
	startTime: "2026-05-31T00:00:00Z",
	latestOrderId: "GPA.1234-5678-9012-34567",
	acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
	externalAccountIdentifiers: {
		obfuscatedExternalAccountId: "gpa_account_1",
	},
	lineItems: [
		{
			productId: "premium_monthly",
			expiryTime: "2026-06-30T00:00:00Z",
			offerDetails: { basePlanId: "monthly-base" },
			autoRenewingPlan: { autoRenewEnabled: true },
		},
	],
	...overrides,
});

const productPurchase = (overrides: Record<string, unknown> = {}) => ({
	purchaseCompletionTime: "2026-05-31T00:00:00Z",
	orderId: "GPA.1234-5678-9012-34567",
	acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
	purchaseStateContext: { purchaseState: "PURCHASED" },
	obfuscatedExternalAccountId: "gpa_account_1",
	productLineItem: [
		{
			productId: "credits_10",
			productOfferDetails: {
				consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
				quantity: 2,
				refundableQuantity: 1,
			},
		},
	],
	...overrides,
});

describe("Google Play normalizer", () => {
	it("maps active subscriptions to active billing commands", () => {
		const command = normalizeGoogleSubscriptionPurchase({
			billingAccountId: "user_1",
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase(),
			now: new Date("2026-06-01T00:00:00Z"),
		});

		expect(command).toMatchObject({
			billingAccountId: "user_1",
			obfuscatedAccountId: "gpa_account_1",
			externalProductId: "premium_monthly",
			externalPriceId: "monthly-base",
			purchaseKind: "subscription",
			purchaseToken: "purchase_token_1",
			orderId: "GPA.1234-5678-9012-34567",
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			autoRenew: true,
			requiresAcknowledgement: true,
			requiresConsumption: false,
		});
		expect(command?.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
	});

	it("maps grace period, account hold, cancellation, and expiration statuses", () => {
		expect(
			normalizeGoogleSubscriptionPurchase({
				billingAccountId: "user_1",
				purchaseToken: "token_grace",
				purchase: subscriptionPurchase({
					subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
				}),
			})?.subscriptionStatus,
		).toBe("grace_period");

		expect(
			normalizeGoogleSubscriptionPurchase({
				billingAccountId: "user_1",
				purchaseToken: "token_hold",
				purchase: subscriptionPurchase({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" }),
			})?.subscriptionStatus,
		).toBe("billing_retry");

		const cancelled = normalizeGoogleSubscriptionPurchase({
			billingAccountId: "user_1",
			purchaseToken: "token_cancelled",
			purchase: subscriptionPurchase({
				subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
				lineItems: [
					{
						productId: "premium_monthly",
						expiryTime: "2026-06-30T00:00:00Z",
						autoRenewingPlan: { autoRenewEnabled: false },
					},
				],
			}),
			now: new Date("2026-06-01T00:00:00Z"),
		});
		expect(cancelled?.subscriptionStatus).toBe("active");
		expect(cancelled?.autoRenew).toBe(false);

		expect(
			normalizeGoogleSubscriptionPurchase({
				billingAccountId: "user_1",
				purchaseToken: "token_paused",
				purchase: subscriptionPurchase({
					subscriptionState: "SUBSCRIPTION_STATE_PAUSED",
					lineItems: [
						{
							productId: "premium_monthly",
							expiryTime: "2026-06-30T00:00:00Z",
							autoRenewingPlan: { autoRenewEnabled: false },
						},
					],
				}),
				now: new Date("2026-06-01T00:00:00Z"),
			})?.subscriptionStatus,
		).toBe("cancelled");

		expect(
			normalizeGoogleSubscriptionPurchase({
				billingAccountId: "user_1",
				purchaseToken: "token_expired",
				purchase: subscriptionPurchase({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }),
			})?.subscriptionStatus,
		).toBe("expired");
	});

	it("skips pending subscriptions and carries linked purchase tokens", () => {
		expect(
			normalizeGoogleSubscriptionPurchase({
				billingAccountId: "user_1",
				purchaseToken: "token_pending",
				purchase: subscriptionPurchase({ subscriptionState: "SUBSCRIPTION_STATE_PENDING" }),
			}),
		).toBeNull();

		expect(
			normalizeGoogleSubscriptionPurchase({
				billingAccountId: "user_1",
				purchaseToken: "token_new",
				purchase: subscriptionPurchase({ linkedPurchaseToken: "token_old" }),
			})?.linkedPurchaseToken,
		).toBe("token_old");
	});

	it("supports provider reconciliation projection reason and deterministic key", () => {
		const command = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase(),
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			now: new Date("2026-06-01T00:00:00Z"),
		});

		expect(command).toMatchObject({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			eventType: "provider_reconciliation",
			externalEventId: null,
			projectionReason: "provider_reconciliation",
			projectionIdempotencyKey:
				"google:purchase_token_1:provider_reconciliation:SUBSCRIPTION_STATE_ACTIVE:active:auto_renew:true:premium_monthly:monthly-base:GPA.1234-5678-9012-34567:2026-06-30T00:00:00.000Z",
		});
	});

	it("changes provider reconciliation keys when order or expiry changes", () => {
		const original = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase(),
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			now: new Date("2026-06-01T00:00:00Z"),
		});
		const changedOrder = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase({ latestOrderId: "GPA.2222-3333-4444-55555" }),
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			now: new Date("2026-06-01T00:00:00Z"),
		});
		const changedExpiry = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase({
				lineItems: [
					{
						productId: "premium_monthly",
						expiryTime: "2026-07-31T00:00:00Z",
						offerDetails: { basePlanId: "monthly-base" },
						autoRenewingPlan: { autoRenewEnabled: true },
					},
				],
			}),
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			now: new Date("2026-06-01T00:00:00Z"),
		});
		const noOrder = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase({ latestOrderId: undefined }),
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			now: new Date("2026-06-01T00:00:00Z"),
		});

		expect(changedOrder?.projectionIdempotencyKey).not.toBe(original?.projectionIdempotencyKey);
		expect(changedExpiry?.projectionIdempotencyKey).not.toBe(original?.projectionIdempotencyKey);
		expect(noOrder?.projectionIdempotencyKey).toBe(
			"google:purchase_token_1:provider_reconciliation:SUBSCRIPTION_STATE_ACTIVE:active:auto_renew:true:premium_monthly:monthly-base:no_order:2026-06-30T00:00:00.000Z",
		);
	});

	it("changes provider reconciliation keys when provider state changes without order or expiry changes", () => {
		const active = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase({
				subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
				lineItems: [
					{
						productId: "premium_monthly",
						expiryTime: "2026-06-30T00:00:00Z",
						offerDetails: { basePlanId: "monthly-base" },
						autoRenewingPlan: { autoRenewEnabled: true },
					},
				],
			}),
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			now: new Date("2026-06-01T00:00:00Z"),
		});
		const gracePeriod = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			purchase: subscriptionPurchase({
				subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
				lineItems: [
					{
						productId: "premium_monthly",
						expiryTime: "2026-06-30T00:00:00Z",
						offerDetails: { basePlanId: "monthly-base" },
						autoRenewingPlan: { autoRenewEnabled: true },
					},
				],
			}),
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			now: new Date("2026-06-01T00:00:00Z"),
		});

		expect(active?.orderId).toBe(gracePeriod?.orderId);
		expect(active?.expiresAt?.toISOString()).toBe(gracePeriod?.expiresAt?.toISOString());
		expect(active?.projectionIdempotencyKey).not.toBe(gracePeriod?.projectionIdempotencyKey);
		expect(gracePeriod?.projectionIdempotencyKey).toContain(
			"SUBSCRIPTION_STATE_IN_GRACE_PERIOD:grace_period",
		);
	});

	it("does not synthesize provider webhook keys from a null event id", () => {
		expect(() =>
			normalizeGoogleSubscriptionPurchase({
				billingAccountId: null,
				purchaseToken: "purchase_token_1",
				purchase: subscriptionPurchase(),
				projectionReason: "provider_webhook",
			}),
		).toThrow("externalEventId is required for provider webhook projection keys");
	});

	it("maps one-time purchased and cancelled product states", () => {
		const purchased = normalizeGoogleProductPurchase({
			billingAccountId: "user_1",
			purchaseToken: "purchase_token_1",
			purchaseKind: "consumable",
			productId: "credits_10",
			purchase: productPurchase(),
		});

		expect(purchased).toMatchObject({
			externalProductId: "credits_10",
			purchaseKind: "consumable",
			purchaseStatus: "completed",
			quantity: 2,
			refundableQuantity: 1,
			consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
			requiresAcknowledgement: false,
			requiresConsumption: true,
		});

		const canceled = normalizeGoogleProductPurchase({
			billingAccountId: "user_1",
			purchaseToken: "purchase_token_2",
			purchaseKind: "non_consumable",
			productId: "lifetime",
			purchase: productPurchase({
				purchaseStateContext: { purchaseState: "CANCELLED" },
				productLineItem: [{ productId: "lifetime" }],
			}),
		});

		expect(canceled?.purchaseStatus).toBe("voided");
		expect(canceled?.invalidationReason).toBe("canceled");
	});

	it("maps voided purchase notifications and ignores RTDN test notifications", () => {
		const voided = normalizeGoogleVoidedPurchase({
			billingAccountId: null,
			obfuscatedAccountId: null,
			externalProductId: "credits_10",
			purchaseKind: "consumable",
			purchaseToken: "purchase_token_1",
			orderId: "GPA.1234-5678-9012-34567",
			eventTimeMillis: "1780185600000",
			externalEventId: "google:message_1",
			rawPayload: { voidedPurchaseNotification: { purchaseToken: "purchase_token_1" } },
		});

		expect(voided).toMatchObject({
			purchaseStatus: "voided",
			invalidationReason: "voided_purchase",
			eventType: "VOIDED_PURCHASE",
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: "google:message_1:projection",
		});
		expect(voided.invalidatedAt?.toISOString()).toBe("2026-05-31T00:00:00.000Z");

		expect(
			normalizeGoogleTestNotification({
				messageId: "message_1",
				notification: {
					version: "1.0",
					packageName: "com.voysee.app",
					eventTimeMillis: "1780185600000",
					testNotification: { version: "1.0" },
				},
			}),
		).toBeNull();
	});
});
