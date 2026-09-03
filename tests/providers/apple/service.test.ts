import { describe, expect, it } from "bun:test";
import { BillingError } from "../../../src/billing/errors";
import type { ProviderSubscriptionReconciliationRow } from "../../../src/db/repository";
import { AppleStoreKitService } from "../../../src/providers/apple/service";
import type {
	AppleDecodedNotificationPayload,
	AppleDecodedTransactionPayload,
	AppleWebhookInput,
} from "../../../src/providers/apple/types";

const entitlementSnapshot = {
	billingAccountId: "user_1",
	generatedAt: "2026-05-31T00:00:00.000Z",
	entitlements: [],
};

const transaction = (
	overrides: Partial<AppleDecodedTransactionPayload> = {},
): AppleDecodedTransactionPayload => ({
	bundleId: "com.voysee.app",
	environment: "Sandbox",
	productId: "premium_monthly",
	type: "AUTO_RENEWABLE_SUBSCRIPTION",
	transactionId: "200000000000001",
	originalTransactionId: "100000000000001",
	webOrderLineItemId: "300000000000001",
	purchaseDate: Date.parse("2026-05-31T00:00:00.000Z"),
	expiresDate: Date.parse("2026-06-30T00:00:00.000Z"),
	appAccountToken: "11111111-1111-1111-1111-111111111111",
	...overrides,
});

const notification = (
	overrides: Partial<AppleDecodedNotificationPayload> = {},
): AppleDecodedNotificationPayload => ({
	notificationType: "DID_RENEW",
	notificationUUID: "notification_1",
	data: {
		bundleId: "com.voysee.app",
		environment: "Sandbox",
	},
	...overrides,
});

const reconciliationSubscription = (
	overrides: Partial<ProviderSubscriptionReconciliationRow> = {},
): ProviderSubscriptionReconciliationRow => ({
	id: "subscription_1",
	project_id: "project_1",
	project_key: "voysee",
	provider: "apple",
	channel: "ios",
	external_subscription_id: "100000000000001",
	external_product_id: "premium_monthly",
	external_price_id: null,
	latest_transaction_id: "200000000000001",
	status: "active",
	expires_at: "2026-05-30T00:00:00.000Z",
	provider_reconciliation_attempts: 0,
	...overrides,
});

function createService({
	clientOverrides = {},
	repositoryOverrides = {},
	environment = "sandbox",
}: {
	clientOverrides?: Partial<ConstructorParameters<typeof AppleStoreKitService>[0]["client"]>;
	repositoryOverrides?: Partial<
		ConstructorParameters<typeof AppleStoreKitService>[0]["repository"]
	>;
	environment?: "sandbox" | "production";
} = {}) {
	const calls: unknown[] = [];
	const repository = {
		getOrCreateProviderCustomerToken(billingAccountId: string, provider: "apple") {
			calls.push({ method: "getOrCreateProviderCustomerToken", billingAccountId, provider });
			return Promise.resolve("11111111-1111-1111-1111-111111111111");
		},
		recordStoreKitTransactionAndEnqueueProjection(input: unknown) {
			calls.push({ method: "recordStoreKitTransactionAndEnqueueProjection", input });
			return Promise.resolve({
				processingStatus: "processed" as const,
				billingAccountId: "user_1",
				entitlements: entitlementSnapshot,
			});
		},
		...repositoryOverrides,
	};
	const client = {
		verifyTransaction(transactionId: string) {
			calls.push({ method: "verifyTransaction", transactionId });
			return Promise.resolve({
				environment: "sandbox" as const,
				signedTransactionInfo: "signed-transaction",
				transaction: transaction(),
				renewalInfo: { autoRenewStatus: 1 },
			});
		},
		verifyNotification(signedPayload: string) {
			calls.push({ method: "verifyNotification", signedPayload });
			return Promise.resolve({
				environment: "sandbox" as const,
				notification: notification(),
				transaction: transaction(),
				renewalInfo: { autoRenewStatus: 1 },
			});
		},
		getLatestSubscriptionStatus(originalTransactionId: string) {
			calls.push({ method: "getLatestSubscriptionStatus", originalTransactionId });
			return Promise.resolve({
				environment: "sandbox" as const,
				signedTransactionInfo: "signed-status-transaction",
				transaction: transaction(),
				renewalInfo: { autoRenewStatus: 1 },
				storeKitStatus: 1,
			});
		},
		...clientOverrides,
	};

	return {
		calls,
		service: new AppleStoreKitService({
			bundleId: "com.voysee.app",
			environment,
			client,
			repository,
		}),
	};
}

describe("AppleStoreKitService", () => {
	it("gets or creates app account tokens", async () => {
		const { calls, service } = createService();

		const token = await service.getOrCreateAppAccountToken("user_1");

		expect(token).toBe("11111111-1111-1111-1111-111111111111");
		expect(calls).toEqual([
			{
				method: "getOrCreateProviderCustomerToken",
				billingAccountId: "user_1",
				provider: "apple",
			},
		]);
	});

	it("verifies purchases, checks account token binding, records transaction, and returns entitlements", async () => {
		const { calls, service } = createService();

		const snapshot = await service.verifyPurchase({
			billingAccountId: "user_1",
			transactionId: "200000000000001",
		});

		expect(snapshot).toEqual(entitlementSnapshot);
		expect(calls.map((call) => (call as { method: string }).method)).toEqual([
			"getOrCreateProviderCustomerToken",
			"verifyTransaction",
			"recordStoreKitTransactionAndEnqueueProjection",
		]);
		expect(calls[2]).toMatchObject({
			method: "recordStoreKitTransactionAndEnqueueProjection",
			input: {
				billingAccountId: "user_1",
				appAccountToken: "11111111-1111-1111-1111-111111111111",
				externalProductId: "premium_monthly",
				purchaseKind: "subscription",
				transactionId: "200000000000001",
				externalEventId: "apple:transaction:200000000000001:purchase_verified",
				projectionIdempotencyKey: "apple:200000000000001:purchase_verified",
			},
		});
	});

	it("fails when verified transaction has a mismatched app account token", async () => {
		const { service } = createService({
			clientOverrides: {
				verifyTransaction() {
					return Promise.resolve({
						environment: "sandbox" as const,
						signedTransactionInfo: "signed-transaction",
						transaction: transaction({
							appAccountToken: "22222222-2222-2222-2222-222222222222",
						}),
						renewalInfo: { autoRenewStatus: 1 },
					});
				},
			},
		});

		await expect(
			service.verifyPurchase({ billingAccountId: "user_1", transactionId: "200000000000001" }),
		).rejects.toMatchObject({
			code: "STOREKIT_ACCOUNT_TOKEN_MISMATCH",
			status: 403,
		});
	});

	it("checks verified purchases against the configured Apple environment", async () => {
		const { calls, service } = createService({
			environment: "production",
			clientOverrides: {
				verifyTransaction() {
					return Promise.resolve({
						environment: "sandbox" as const,
						signedTransactionInfo: "signed-transaction",
						transaction: transaction(),
						renewalInfo: { autoRenewStatus: 1 },
					});
				},
			},
		});

		await expect(
			service.verifyPurchase({ billingAccountId: "user_1", transactionId: "200000000000001" }),
		).rejects.toThrow("Apple transaction environment mismatch");
		expect(
			calls.some(
				(call) =>
					(call as { method: string }).method === "recordStoreKitTransactionAndEnqueueProjection",
			),
		).toBe(false);
	});

	it("returns skipped webhook results without coercing entitlements", async () => {
		const { service } = createService({
			repositoryOverrides: {
				recordStoreKitTransactionAndEnqueueProjection() {
					return Promise.resolve({
						processingStatus: "skipped" as const,
						billingAccountId: null,
						entitlements: null,
					});
				},
			},
		});

		const result = await service.handleNotification({ signedPayload: "signed-notification" });

		expect(result).toEqual({ status: "skipped", entitlements: null });
	});

	it("ignores signed TEST notifications", async () => {
		const { service } = createService({
			clientOverrides: {
				verifyNotification() {
					return Promise.resolve({
						environment: "sandbox" as const,
						notification: notification({ notificationType: "TEST" }),
						transaction: null,
						renewalInfo: null,
					});
				},
			},
		});

		const result = await service.handleNotification({ signedPayload: "signed-notification" });

		expect(result).toEqual({ status: "ignored", entitlements: null });
	});

	it("does not mutate repository state when notification verification fails", async () => {
		const { calls, service } = createService({
			clientOverrides: {
				verifyNotification(_input: string) {
					return Promise.reject(
						new BillingError("Invalid Apple signed payload", "STOREKIT_JWS_INVALID"),
					);
				},
			},
		});

		await expect(
			service.handleNotification({ signedPayload: "invalid" } satisfies AppleWebhookInput),
		).rejects.toMatchObject({ code: "STOREKIT_JWS_INVALID" });
		expect(
			calls.some(
				(call) =>
					(call as { method: string }).method === "recordStoreKitTransactionAndEnqueueProjection",
			),
		).toBe(false);
	});

	it("checks notifications against the configured Apple environment", async () => {
		const { calls, service } = createService({
			environment: "production",
			clientOverrides: {
				verifyNotification() {
					return Promise.resolve({
						environment: "sandbox" as const,
						notification: notification(),
						transaction: transaction(),
						renewalInfo: { autoRenewStatus: 1 },
					});
				},
			},
		});

		await expect(
			service.handleNotification({ signedPayload: "signed-notification" }),
		).rejects.toThrow("Apple notification environment mismatch");
		expect(
			calls.some(
				(call) =>
					(call as { method: string }).method === "recordStoreKitTransactionAndEnqueueProjection",
			),
		).toBe(false);
	});

	it("replays stored Apple events through the recording repository", async () => {
		const { calls, service } = createService();

		const result = await service.replayStoreEvent({
			id: "event_1",
			project_id: "project_1",
			project_key: "voysee",
			provider: "apple",
			channel: "ios",
			external_event_id: "notification_1",
			event_type: "DID_RENEW",
			customer_id: null,
			store_product_id: "premium_monthly",
			transaction_id: "200000000000001",
			purchase_kind: "subscription",
			processing_status: "processing",
			processing_error: null,
			attempts: 0,
			next_attempt_at: null,
			raw_payload: {
				transaction: transaction(),
				renewalInfo: { autoRenewStatus: 1 },
			},
			processed_at: null,
			locked_at: "2026-05-31T00:00:00.000Z",
			locked_by: "worker-a",
			created_at: "2026-05-31T00:00:00.000Z",
			updated_at: "2026-05-31T00:00:00.000Z",
		});

		expect(result).toEqual({ status: "processed" });
		expect(calls).toContainEqual({
			method: "recordStoreKitTransactionAndEnqueueProjection",
			input: expect.objectContaining({
				billingAccountId: null,
				channel: "ios",
				transactionId: "200000000000001",
				eventType: "DID_RENEW",
				externalEventId: "notification_1",
				projectionReason: "provider_webhook",
				projectionIdempotencyKey: "apple:notification_1:projection",
			}),
		});
	});

	it("returns retryable when replayed Apple events still cannot resolve a customer", async () => {
		const { service } = createService({
			repositoryOverrides: {
				recordStoreKitTransactionAndEnqueueProjection() {
					return Promise.resolve({
						processingStatus: "skipped" as const,
						billingAccountId: null,
						entitlements: null,
					});
				},
			},
		});

		const result = await service.replayStoreEvent({
			id: "event_1",
			project_id: "project_1",
			project_key: "voysee",
			provider: "apple",
			channel: "ios",
			external_event_id: "notification_1",
			event_type: "DID_RENEW",
			customer_id: null,
			store_product_id: "premium_monthly",
			transaction_id: "200000000000001",
			purchase_kind: "subscription",
			processing_status: "processing",
			processing_error: null,
			attempts: 0,
			next_attempt_at: null,
			raw_payload: { transaction: transaction() },
			processed_at: null,
			locked_at: "2026-05-31T00:00:00.000Z",
			locked_by: "worker-a",
			created_at: "2026-05-31T00:00:00.000Z",
			updated_at: "2026-05-31T00:00:00.000Z",
		});

		expect(result).toEqual({ status: "retryable", reason: "apple_customer_unresolved" });
	});

	it("ignores stored Apple events without a recordable transaction", async () => {
		const { service } = createService();

		const result = await service.replayStoreEvent({
			id: "event_1",
			project_id: "project_1",
			project_key: "voysee",
			provider: "apple",
			channel: "ios",
			external_event_id: "notification_1",
			event_type: "DID_RENEW",
			customer_id: null,
			store_product_id: null,
			transaction_id: null,
			purchase_kind: null,
			processing_status: "processing",
			processing_error: null,
			attempts: 0,
			next_attempt_at: null,
			raw_payload: {},
			processed_at: null,
			locked_at: "2026-05-31T00:00:00.000Z",
			locked_by: "worker-a",
			created_at: "2026-05-31T00:00:00.000Z",
			updated_at: "2026-05-31T00:00:00.000Z",
		});

		expect(result).toEqual({
			status: "ignored",
			reason: "apple_store_event_not_recordable",
		});
	});

	it("ignores stored Apple events with an explicit null transaction", async () => {
		const { calls, service } = createService();

		const result = await service.replayStoreEvent({
			id: "event_1",
			project_id: "project_1",
			project_key: "voysee",
			provider: "apple",
			channel: "ios",
			external_event_id: "notification_1",
			event_type: "DID_RENEW",
			customer_id: null,
			store_product_id: null,
			transaction_id: null,
			purchase_kind: null,
			processing_status: "processing",
			processing_error: null,
			attempts: 0,
			next_attempt_at: null,
			raw_payload: { transaction: null },
			processed_at: null,
			locked_at: "2026-05-31T00:00:00.000Z",
			locked_by: "worker-a",
			created_at: "2026-05-31T00:00:00.000Z",
			updated_at: "2026-05-31T00:00:00.000Z",
		});

		expect(result).toEqual({
			status: "ignored",
			reason: "apple_store_event_not_recordable",
		});
		expect(
			calls.some(
				(call) =>
					(call as { method: string }).method === "recordStoreKitTransactionAndEnqueueProjection",
			),
		).toBe(false);
	});

	it("reconciles provider subscriptions from latest StoreKit status", async () => {
		const { calls, service } = createService();

		const result = await service.reconcileSubscription(reconciliationSubscription());

		expect(result).toEqual({ status: "processed" });
		expect(calls.map((call) => (call as { method: string }).method)).toEqual([
			"getLatestSubscriptionStatus",
			"recordStoreKitTransactionAndEnqueueProjection",
		]);
		expect(calls[1]).toMatchObject({
			method: "recordStoreKitTransactionAndEnqueueProjection",
			input: {
				billingAccountId: null,
				transactionId: "200000000000001",
				originalTransactionId: "100000000000001",
				eventType: "provider_reconciliation",
				externalEventId: null,
				projectionReason: "provider_reconciliation",
				projectionIdempotencyKey:
					"apple:200000000000001:provider_reconciliation:100000000000001:300000000000001:premium_monthly:2026-06-30T00:00:00.000Z:completed:active:auto_renew:true:storekit_status:1:billing_retry:false:grace:no_grace:invalidated:none:invalidation_reason:none",
			},
		});
	});

	it("passes StoreKit status into provider subscription reconciliation normalization", async () => {
		const { calls, service } = createService({
			clientOverrides: {
				getLatestSubscriptionStatus(originalTransactionId: string) {
					calls.push({ method: "getLatestSubscriptionStatus", originalTransactionId });
					return Promise.resolve({
						environment: "sandbox" as const,
						signedTransactionInfo: "signed-status-transaction",
						transaction: transaction({
							expiresDate: Date.parse("2026-05-30T00:00:00.000Z"),
						}),
						renewalInfo: { autoRenewStatus: 1 },
						storeKitStatus: 4,
					});
				},
			},
		});

		const result = await service.reconcileSubscription(reconciliationSubscription());

		expect(result).toEqual({ status: "processed" });
		expect(calls[1]).toMatchObject({
			method: "recordStoreKitTransactionAndEnqueueProjection",
			input: {
				transactionId: "200000000000001",
				purchaseStatus: "completed",
				subscriptionStatus: "grace_period",
				projectionIdempotencyKey: expect.stringContaining(
					":completed:grace_period:auto_renew:true:storekit_status:4:",
				),
			},
		});
	});

	it("checks provider subscription reconciliation against the configured Apple environment", async () => {
		const { calls, service } = createService({
			environment: "production",
			clientOverrides: {
				getLatestSubscriptionStatus(originalTransactionId: string) {
					calls.push({ method: "getLatestSubscriptionStatus", originalTransactionId });
					return Promise.resolve({
						environment: "sandbox" as const,
						signedTransactionInfo: "signed-status-transaction",
						transaction: transaction(),
						renewalInfo: { autoRenewStatus: 1 },
						storeKitStatus: 1,
					});
				},
			},
		});

		await expect(service.reconcileSubscription(reconciliationSubscription())).rejects.toThrow(
			"Apple transaction environment mismatch",
		);
		expect(
			calls.some(
				(call) =>
					(call as { method: string }).method === "recordStoreKitTransactionAndEnqueueProjection",
			),
		).toBe(false);
	});

	it("skips provider subscription reconciliation when StoreKit has no status", async () => {
		const { calls, service } = createService({
			clientOverrides: {
				getLatestSubscriptionStatus(originalTransactionId: string) {
					calls.push({ method: "getLatestSubscriptionStatus", originalTransactionId });
					return Promise.resolve(null);
				},
			},
		});

		const result = await service.reconcileSubscription(reconciliationSubscription());

		expect(result).toEqual({ status: "skipped" });
		expect(calls).toEqual([
			{
				method: "getLatestSubscriptionStatus",
				originalTransactionId: "100000000000001",
			},
		]);
	});

	it("rejects non-Apple provider subscription reconciliation rows", async () => {
		const { service } = createService();

		await expect(
			service.reconcileSubscription(
				reconciliationSubscription({ provider: "google", channel: "android" }),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
	});
});
