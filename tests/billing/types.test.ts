import { describe, expect, it } from "bun:test";
import {
	parseChannel,
	parseEntitlementSnapshot,
	parseProductType,
	parseProjectionPayload,
	parseProjectionSyncReason,
	parseProvider,
	parseStoreEventProcessingStatus,
	projectionSyncReasons,
	projectionSyncStatuses,
	storeEventProcessingStatuses,
	subscriptionStatuses,
} from "../../src/billing/types";

describe("billing type parsers", () => {
	it("accepts supported providers and channels", () => {
		expect(parseProvider("apple")).toBe("apple");
		expect(parseProvider("google")).toBe("google");
		expect(parseProvider("stripe")).toBe("stripe");
		expect(parseChannel("ios")).toBe("ios");
		expect(parseChannel("android")).toBe("android");
		expect(parseChannel("web")).toBe("web");
	});

	it("rejects unsupported providers and channels", () => {
		expect(() => parseProvider("paypal")).toThrow("Unsupported billing provider");
		expect(() => parseChannel("desktop")).toThrow("Unsupported billing channel");
	});

	it("accepts supported product types", () => {
		expect(parseProductType("subscription")).toBe("subscription");
		expect(parseProductType("consumable")).toBe("consumable");
		expect(parseProductType("non_consumable")).toBe("non_consumable");
	});

	it("exports canonical status and reason literals for SQL drift tests", () => {
		expect(subscriptionStatuses).toEqual([
			"active",
			"grace_period",
			"billing_retry",
			"cancelled",
			"expired",
			"refunded",
			"revoked",
		]);
		expect(projectionSyncStatuses).toEqual(["pending", "processing", "succeeded", "failed"]);
		expect(projectionSyncReasons).toEqual([
			"purchase_verified",
			"provider_webhook",
			"expiry_reconciliation",
			"provider_reconciliation",
			"usage_changed",
		]);
		expect(storeEventProcessingStatuses).toEqual([
			"pending",
			"processing",
			"processed",
			"skipped",
			"failed",
		]);
	});

	it("parses projection sync reasons and store event processing statuses", () => {
		expect(parseProjectionSyncReason("provider_reconciliation")).toBe("provider_reconciliation");
		expect(parseStoreEventProcessingStatus("processing")).toBe("processing");
		expect(() => parseStoreEventProcessingStatus("unknown")).toThrow(
			"Unsupported store event processing status: unknown",
		);
	});

	it("parses valid projection payloads", () => {
		const payload = parseProjectionPayload({
			billingAccountId: "user_1",
			generatedAt: "2026-05-31T00:00:00.000Z",
			balances: [
				{
					featureKey: "ai_credits",
					unit: "credit",
					available: "1010.25",
					held: "10",
					periodEndsAt: "2026-06-30T00:00:00.000Z",
				},
			],
			reason: "purchase_verified",
			entitlements: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [
					{
						key: "premium",
						active: true,
						expiresAt: null,
						metadata: { source: "purchase" },
					},
				],
			},
		});

		expect(payload.reason).toBe("purchase_verified");
		expect(payload.entitlements.entitlements[0]?.key).toBe("premium");
		expect(payload.balances[0]?.available).toBe("1010.25");
	});

	it("parses projection payloads with consumable purchase context", () => {
		const payload = parseProjectionPayload({
			billingAccountId: "user_1",
			generatedAt: "2026-05-31T00:00:00.000Z",
			balances: [],
			reason: "purchase_verified",
			entitlements: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
			purchase: {
				provider: "apple",
				channel: "ios",
				purchaseKind: "consumable",
				transactionId: "200000000000001",
				productKey: "echo_credits_10",
				creditAmount: 10,
				purchasedAt: "2026-05-31T00:00:00.000Z",
			},
		});

		expect(payload.purchase?.productKey).toBe("echo_credits_10");
		expect(payload.purchase?.creditAmount).toBe(10);
	});

	it("parses Google consumable projection payloads with quantity context", () => {
		const payload = parseProjectionPayload({
			billingAccountId: "user_1",
			generatedAt: "2026-05-31T00:00:00.000Z",
			balances: [],
			reason: "purchase_verified",
			entitlements: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
			purchase: {
				provider: "google",
				channel: "android",
				purchaseKind: "consumable",
				transactionId: "purchase_token_1",
				productKey: "echo_credits_10",
				creditAmount: 10,
				totalCreditAmount: 20,
				quantity: 2,
				refundableQuantity: 1,
				purchasedAt: "2026-05-31T00:00:00.000Z",
			},
		});

		expect(payload.purchase?.totalCreditAmount).toBe(20);
		expect(payload.purchase?.quantity).toBe(2);
		expect(payload.purchase?.refundableQuantity).toBe(1);
	});

	it("parses projection payloads with Stripe reversal context", () => {
		const payload = parseProjectionPayload({
			billingAccountId: "user_1",
			generatedAt: "2026-06-01T00:00:00.000Z",
			balances: [],
			reason: "provider_webhook",
			entitlements: {
				billingAccountId: "user_1",
				generatedAt: "2026-06-01T00:00:00.000Z",
				entitlements: [],
			},
			reversal: {
				provider: "stripe",
				channel: "web",
				reason: "refund",
				transactionId: "re_123",
				originalTransactionId: "pi_123",
				productKey: "credits_100",
				creditAmount: 100,
				totalCreditAmount: 100,
				quantity: 1,
				reversedAt: "2026-06-01T00:00:00.000Z",
			},
		});

		expect(payload.reversal?.reason).toBe("refund");
		expect(payload.reversal?.originalTransactionId).toBe("pi_123");
	});

	it("rejects projection payloads containing both purchase and reversal contexts", () => {
		expect(() =>
			parseProjectionPayload({
				billingAccountId: "user_1",
				reason: "provider_webhook",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-06-01T00:00:00.000Z",
					entitlements: [],
				},
				purchase: {
					provider: "stripe",
					channel: "web",
					purchaseKind: "consumable",
					transactionId: "pi_123",
					productKey: "credits_100",
					creditAmount: 100,
					purchasedAt: "2026-06-01T00:00:00.000Z",
				},
				reversal: {
					provider: "stripe",
					channel: "web",
					reason: "refund",
					transactionId: "re_123",
					originalTransactionId: "pi_123",
					productKey: "credits_100",
					creditAmount: 100,
					reversedAt: "2026-06-01T00:00:00.000Z",
				},
			}),
		).toThrow("Invalid projection payload");
	});

	it("rejects invalid projection payloads", () => {
		expect(() =>
			parseProjectionPayload({
				billingAccountId: "user_1",
				reason: "provider_webhook",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: {},
				},
			}),
		).toThrow("Invalid projection payload");
	});

	it("rejects projection payloads with mismatched top-level and snapshot users", () => {
		expect(() =>
			parseProjectionPayload({
				billingAccountId: "user_1",
				reason: "provider_webhook",
				entitlements: {
					billingAccountId: "user_2",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
			}),
		).toThrow("Invalid projection payload");
	});

	it("parses entitlement snapshots", () => {
		const snapshot = parseEntitlementSnapshot({
			billingAccountId: "user_1",
			generatedAt: "2026-05-31T00:00:00.000Z",
			entitlements: [
				{
					key: "premium",
					active: true,
					expiresAt: null,
					metadata: { source: "subscription" },
				},
			],
		});

		expect(snapshot.billingAccountId).toBe("user_1");
		expect(snapshot.entitlements[0]?.key).toBe("premium");
	});

	it("rejects invalid entitlement snapshots", () => {
		expect(() =>
			parseEntitlementSnapshot({
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [{ key: "", active: true, expiresAt: null, metadata: {} }],
			}),
		).toThrow("Invalid entitlement snapshot");
	});

	it("rejects invalid projection purchase context", () => {
		expect(() =>
			parseProjectionPayload({
				billingAccountId: "user_1",
				reason: "purchase_verified",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
				purchase: {
					provider: "apple",
					channel: "ios",
					purchaseKind: "consumable",
					transactionId: "200000000000001",
					productKey: "echo_credits_10",
					creditAmount: -1,
					purchasedAt: "2026-05-31T00:00:00.000Z",
				},
			}),
		).toThrow("Invalid projection payload");

		expect(() =>
			parseProjectionPayload({
				billingAccountId: "user_1",
				reason: "purchase_verified",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
				purchase: {
					provider: "google",
					channel: "android",
					purchaseKind: "consumable",
					transactionId: "purchase_token_1",
					productKey: "echo_credits_10",
					creditAmount: 10,
					quantity: 0,
					purchasedAt: "2026-05-31T00:00:00.000Z",
				},
			}),
		).toThrow("Invalid projection payload");
	});
});
