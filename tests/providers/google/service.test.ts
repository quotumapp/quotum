import { describe, expect, it } from "bun:test";
import { BillingError } from "../../../src/billing/errors";
import type { EntitlementSnapshot } from "../../../src/billing/types";
import type { ProviderSubscriptionReconciliationRow } from "../../../src/db/repository";
import { createGoogleObfuscatedAccountId } from "../../../src/providers/google/account-link";
import { GooglePlayBillingService } from "../../../src/providers/google/service";
import type { VerifiedGoogleRtdn } from "../../../src/providers/google/types";

const snapshot: EntitlementSnapshot = {
	billingAccountId: "user_1",
	generatedAt: "2026-05-31T00:00:00.000Z",
	entitlements: [],
};

const config = {
	packageName: "com.voysee.app",
	obfuscatedAccountIdSecret: "account-link-secret",
	previousObfuscatedAccountIdSecrets: [] as string[],
	rtdnAudience: "https://billing.example.com/v1/webhooks/google",
	rtdnServiceAccountEmail: "pubsub-push@example.iam.gserviceaccount.com",
	rtdnAuthorizedParty: "pubsub-push-client-id",
	enablePublisherMutations: true,
};

const expectedAccountId = createGoogleObfuscatedAccountId("user_1", "account-link-secret");
const previousAccountId = createGoogleObfuscatedAccountId("user_1", "previous-account-link-secret");
const farFutureSubscriptionExpiry = "2099-06-30T00:00:00.000Z";

const subscriptionPurchase = (overrides: Record<string, unknown> = {}) => ({
	subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
	startTime: "2026-05-31T00:00:00Z",
	latestOrderId: "GPA.1234-5678-9012-34567",
	acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
	externalAccountIdentifiers: {
		obfuscatedExternalAccountId: expectedAccountId,
	},
	lineItems: [
		{
			productId: "premium_monthly",
			expiryTime: farFutureSubscriptionExpiry,
			offerDetails: { basePlanId: "monthly-base" },
			autoRenewingPlan: { autoRenewEnabled: true },
		},
	],
	...overrides,
});

const productPurchase = () => ({
	purchaseCompletionTime: "2026-05-31T00:00:00Z",
	orderId: "GPA.1234-5678-9012-34567",
	purchaseStateContext: { purchaseState: "PURCHASED" },
	obfuscatedExternalAccountId: expectedAccountId,
	productLineItem: [
		{
			productId: "credits_10",
			productOfferDetails: {
				consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
				quantity: 1,
				refundableQuantity: 1,
			},
		},
	],
});

const reconciliationSubscription = (
	overrides: Partial<ProviderSubscriptionReconciliationRow> = {},
): ProviderSubscriptionReconciliationRow => ({
	id: "subscription_1",
	project_id: "project_1",
	project_key: "voysee",
	provider: "google",
	channel: "android",
	external_subscription_id: "purchase_token_1",
	external_product_id: "premium_monthly",
	external_price_id: "monthly-base",
	latest_transaction_id: "purchase_token_1",
	status: "active",
	expires_at: "2026-05-30T00:00:00.000Z",
	provider_reconciliation_attempts: 0,
	...overrides,
});

function serviceFixture(
	overrides: {
		subscriptionPurchase?: unknown;
		productPurchase?: unknown;
		recordingResult?: "processed" | "skipped";
		voidedRecordingResult?: "processed" | "skipped";
		verifyRtdn?: () => Promise<VerifiedGoogleRtdn>;
		consumeError?: Error;
		configOverrides?: Partial<typeof config>;
	} = {},
) {
	const calls: string[] = [];
	const repositoryInputs: unknown[] = [];
	const service = new GooglePlayBillingService({
		config: { ...config, ...overrides.configOverrides },
		client: {
			getSubscriptionPurchase(token) {
				calls.push(`get-subscription:${token}`);
				return Promise.resolve(overrides.subscriptionPurchase ?? subscriptionPurchase());
			},
			acknowledgeSubscriptionPurchase(subscriptionId, token, obfuscatedAccountId) {
				calls.push(`ack-subscription:${subscriptionId}:${token}:${obfuscatedAccountId}`);
				return Promise.resolve();
			},
			getProductPurchase(token) {
				calls.push(`get-product:${token}`);
				return Promise.resolve(overrides.productPurchase ?? productPurchase());
			},
			acknowledgeProductPurchase(productId, token) {
				calls.push(`ack-product:${productId}:${token}`);
				return Promise.resolve();
			},
			consumeProductPurchase(productId, token) {
				calls.push(`consume-product:${productId}:${token}`);
				return overrides.consumeError ? Promise.reject(overrides.consumeError) : Promise.resolve();
			},
		},
		repository: {
			getOrCreateGoogleProviderCustomer(billingAccountId, obfuscatedAccountId) {
				calls.push(`account-link:${billingAccountId}:${obfuscatedAccountId}`);
				return Promise.resolve(obfuscatedAccountId);
			},
			getGoogleAndroidProductKind(externalProductId) {
				calls.push(`product-kind:${externalProductId}`);
				return Promise.resolve(
					externalProductId === "credits_10" ? "consumable" : "non_consumable",
				);
			},
			recordGooglePurchaseAndEnqueueProjection(input) {
				calls.push(`record:${input.purchaseToken}`);
				repositoryInputs.push(input);
				if (overrides.recordingResult === "skipped") {
					return Promise.resolve({
						processingStatus: "skipped" as const,
						billingAccountId: null,
						entitlements: null,
					});
				}

				return Promise.resolve({
					processingStatus: "processed" as const,
					billingAccountId: "user_1",
					entitlements: snapshot,
				});
			},
			recordGoogleVoidedPurchaseAndEnqueueProjection(input) {
				calls.push(`record-voided:${input.purchaseToken}:${input.orderId}`);
				repositoryInputs.push(input);
				if (overrides.voidedRecordingResult === "skipped") {
					return Promise.resolve({
						processingStatus: "skipped" as const,
						billingAccountId: null,
						entitlements: null,
					});
				}

				return Promise.resolve({
					processingStatus: "processed" as const,
					billingAccountId: "user_1",
					entitlements: snapshot,
				});
			},
		},
		verifyRtdn:
			overrides.verifyRtdn ??
			(async () => ({
				messageId: "message_1",
				externalEventId: "google:message_1",
				notification: {
					version: "1.0",
					packageName: "com.voysee.app",
					eventTimeMillis: "1780185600000",
					subscriptionNotification: {
						version: "1.0",
						notificationType: 4,
						purchaseToken: "purchase_token_1",
					},
				},
			})),
	});

	return { service, calls, repositoryInputs };
}

describe("GooglePlayBillingService", () => {
	it("gets or creates account links", async () => {
		const { service, calls } = serviceFixture();

		const result = await service.getAccountLink("user_1");

		expect(result).toEqual({ obfuscatedAccountId: expectedAccountId });
		expect(calls).toEqual([`account-link:user_1:${expectedAccountId}`]);
	});

	it("verifies subscriptions, records them, acknowledges them, and returns entitlements", async () => {
		const { service, calls, repositoryInputs } = serviceFixture();

		const result = await service.verifyPurchase({
			billingAccountId: "user_1",
			purchaseKind: "subscription",
			purchaseToken: "purchase_token_1",
		});

		expect(result).toEqual(snapshot);
		expect(calls).toEqual([
			`account-link:user_1:${expectedAccountId}`,
			"get-subscription:purchase_token_1",
			"record:purchase_token_1",
			`ack-subscription:premium_monthly:purchase_token_1:${expectedAccountId}`,
		]);
		expect(repositoryInputs[0]).toMatchObject({
			billingAccountId: "user_1",
			obfuscatedAccountId: expectedAccountId,
			purchaseToken: "purchase_token_1",
			externalProductId: "premium_monthly",
		});
	});

	it("rejects purchases with mismatched obfuscated account ids", async () => {
		const { service } = serviceFixture({
			subscriptionPurchase: subscriptionPurchase({
				externalAccountIdentifiers: { obfuscatedExternalAccountId: "wrong" },
			}),
		});

		await expect(
			service.verifyPurchase({
				billingAccountId: "user_1",
				purchaseKind: "subscription",
				purchaseToken: "purchase_token_1",
			}),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_ACCOUNT_ID_MISMATCH" });
	});

	it("accepts purchases linked with a previous obfuscated account id secret", async () => {
		const { service, calls, repositoryInputs } = serviceFixture({
			configOverrides: {
				previousObfuscatedAccountIdSecrets: ["previous-account-link-secret"],
			},
			subscriptionPurchase: subscriptionPurchase({
				externalAccountIdentifiers: { obfuscatedExternalAccountId: previousAccountId },
			}),
		});

		await expect(
			service.verifyPurchase({
				billingAccountId: "user_1",
				purchaseKind: "subscription",
				purchaseToken: "purchase_token_1",
			}),
		).resolves.toEqual(snapshot);
		expect(calls).toContain(
			`ack-subscription:premium_monthly:purchase_token_1:${previousAccountId}`,
		);
		expect(repositoryInputs[0]).toMatchObject({
			obfuscatedAccountId: previousAccountId,
		});
	});

	it("does not acknowledge pending purchases or grant entitlements", async () => {
		const { service, calls } = serviceFixture({
			subscriptionPurchase: subscriptionPurchase({
				subscriptionState: "SUBSCRIPTION_STATE_PENDING",
			}),
		});

		await expect(
			service.verifyPurchase({
				billingAccountId: "user_1",
				purchaseKind: "subscription",
				purchaseToken: "purchase_token_1",
			}),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_PURCHASE_PENDING" });
		expect(calls).toEqual([
			`account-link:user_1:${expectedAccountId}`,
			"get-subscription:purchase_token_1",
		]);
	});

	it("records consumables before consuming them", async () => {
		const { service, calls } = serviceFixture();

		await service.verifyPurchase({
			billingAccountId: "user_1",
			purchaseKind: "consumable",
			purchaseToken: "purchase_token_2",
			productId: "credits_10",
		});

		expect(calls).toEqual([
			`account-link:user_1:${expectedAccountId}`,
			"get-product:purchase_token_2",
			"record:purchase_token_2",
			"consume-product:credits_10:purchase_token_2",
		]);
	});

	it("surfaces consume failures after durable recording", async () => {
		const { service, calls } = serviceFixture({
			consumeError: new BillingError(
				"Google Play purchase mutation failed",
				"GOOGLE_PLAY_MUTATION_FAILED",
				502,
			),
		});

		await expect(
			service.verifyPurchase({
				billingAccountId: "user_1",
				purchaseKind: "consumable",
				purchaseToken: "purchase_token_2",
				productId: "credits_10",
			}),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_MUTATION_FAILED" });
		expect(calls).toContain("record:purchase_token_2");
	});

	it("handles subscription RTDNs from current Google state", async () => {
		const { service, calls } = serviceFixture();

		const result = await service.handleRtdn({ authorizationHeader: "Bearer token", body: {} });

		expect(result).toEqual({
			processed: true,
			eventType: "SUBSCRIPTION_PURCHASED",
			messageId: "message_1",
			entitlements: snapshot,
		});
		expect(calls).toContain("get-subscription:purchase_token_1");
		expect(calls).toContain("record:purchase_token_1");
	});

	it("does not acknowledge webhook subscriptions without obfuscated account binding", async () => {
		const { service, calls } = serviceFixture({
			subscriptionPurchase: subscriptionPurchase({
				externalAccountIdentifiers: undefined,
			}),
		});

		const result = await service.handleRtdn({ authorizationHeader: "Bearer token", body: {} });

		expect(result.processed).toBe(true);
		expect(calls).toContain("record:purchase_token_1");
		expect(calls.some((call) => call.startsWith("ack-subscription:"))).toBe(false);
	});

	it("resolves one-time RTDN product kind from catalog before recording", async () => {
		const { service, calls, repositoryInputs } = serviceFixture({
			verifyRtdn: async () => ({
				messageId: "message_product",
				externalEventId: "google:message_product",
				notification: {
					version: "1.0",
					packageName: "com.voysee.app",
					eventTimeMillis: "1780185600000",
					oneTimeProductNotification: {
						version: "1.0",
						notificationType: 1,
						purchaseToken: "purchase_token_product",
						sku: "credits_10",
					},
				},
			}),
		});

		const result = await service.handleRtdn({ authorizationHeader: "Bearer token", body: {} });

		expect(result).toEqual({
			processed: true,
			eventType: "ONE_TIME_PRODUCT_PURCHASED",
			messageId: "message_product",
			entitlements: snapshot,
		});
		expect(calls).toContain("product-kind:credits_10");
		expect(calls).toContain("get-product:purchase_token_product");
		expect(calls).toContain("consume-product:credits_10:purchase_token_product");
		expect(repositoryInputs[0]).toMatchObject({
			purchaseKind: "consumable",
			purchaseToken: "purchase_token_product",
			externalProductId: "credits_10",
			eventType: "ONE_TIME_PRODUCT_PURCHASED",
			externalEventId: "google:message_product",
		});
	});

	it("records voided purchase RTDNs by token without looking up an unknown product", async () => {
		const { service, calls, repositoryInputs } = serviceFixture({
			verifyRtdn: async () => ({
				messageId: "message_voided",
				externalEventId: "google:message_voided",
				notification: {
					version: "1.0",
					packageName: "com.voysee.app",
					eventTimeMillis: "1780185600000",
					voidedPurchaseNotification: {
						purchaseToken: "purchase_token_voided",
						orderId: "GPA.1234-5678-9012-34567",
						productType: 2,
						refundType: 1,
					},
				},
			}),
		});

		const result = await service.handleRtdn({ authorizationHeader: "Bearer token", body: {} });

		expect(result).toEqual({
			processed: true,
			eventType: "VOIDED_PURCHASE",
			messageId: "message_voided",
			entitlements: snapshot,
		});
		expect(calls).toEqual([
			"get-product:purchase_token_voided",
			"record-voided:purchase_token_voided:GPA.1234-5678-9012-34567",
		]);
		expect(repositoryInputs[0]).toMatchObject({
			purchaseToken: "purchase_token_voided",
			orderId: "GPA.1234-5678-9012-34567",
			refundType: 1,
			quantity: 1,
			refundableQuantity: 1,
			eventType: "VOIDED_PURCHASE",
			externalEventId:
				"google:voided:purchase_token_voided:1780185600000:2:1:GPA.1234-5678-9012-34567",
			projectionIdempotencyKey:
				"google:voided:purchase_token_voided:1780185600000:2:1:GPA.1234-5678-9012-34567:projection",
		});
	});

	it("returns success for skipped RTDNs and test notifications", async () => {
		const skipped = serviceFixture({ recordingResult: "skipped" });

		expect(
			await skipped.service.handleRtdn({ authorizationHeader: "Bearer token", body: {} }),
		).toEqual({
			processed: false,
			eventType: "SUBSCRIPTION_PURCHASED",
			messageId: "message_1",
			entitlements: null,
		});

		const test = serviceFixture({
			verifyRtdn: async () => ({
				messageId: "message_2",
				externalEventId: "google:message_2",
				notification: {
					version: "1.0",
					packageName: "com.voysee.app",
					eventTimeMillis: "1780185600000",
					testNotification: { version: "1.0" },
				},
			}),
		});

		expect(
			await test.service.handleRtdn({ authorizationHeader: "Bearer token", body: {} }),
		).toEqual({
			processed: false,
			eventType: "TEST",
			messageId: "message_2",
			entitlements: null,
		});
	});

	it("replays stored Google subscription events through the recording repository", async () => {
		const { service, calls, repositoryInputs } = serviceFixture();

		const result = await service.replayStoreEvent({
			id: "event_1",
			project_id: "project_1",
			project_key: "voysee",
			provider: "google",
			channel: "android",
			external_event_id: "google:message_1",
			event_type: "SUBSCRIPTION_PURCHASED",
			customer_id: null,
			store_product_id: "premium_monthly",
			transaction_id: "purchase_token_1",
			purchase_kind: "subscription",
			processing_status: "processing",
			processing_error: null,
			attempts: 0,
			next_attempt_at: null,
			raw_payload: subscriptionPurchase(),
			processed_at: null,
			locked_at: "2026-05-31T00:00:00.000Z",
			locked_by: "worker-a",
			created_at: "2026-05-31T00:00:00.000Z",
			updated_at: "2026-05-31T00:00:00.000Z",
		});

		expect(result).toEqual({ status: "processed" });
		expect(calls).toContain("record:purchase_token_1");
		expect(repositoryInputs[0]).toMatchObject({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			externalProductId: "premium_monthly",
			eventType: "SUBSCRIPTION_PURCHASED",
			externalEventId: "google:message_1",
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: "google:message_1:projection",
		});
		expect(calls).toContain(
			`ack-subscription:premium_monthly:purchase_token_1:${expectedAccountId}`,
		);
	});

	it("returns retryable for replayed Google events that still cannot resolve a customer", async () => {
		const { service, calls } = serviceFixture({ recordingResult: "skipped" });

		const result = await service.replayStoreEvent({
			id: "event_1",
			project_id: "project_1",
			project_key: "voysee",
			provider: "google",
			channel: "android",
			external_event_id: "google:message_1",
			event_type: "SUBSCRIPTION_PURCHASED",
			customer_id: null,
			store_product_id: "premium_monthly",
			transaction_id: "purchase_token_1",
			purchase_kind: "subscription",
			processing_status: "processing",
			processing_error: null,
			attempts: 0,
			next_attempt_at: null,
			raw_payload: subscriptionPurchase(),
			processed_at: null,
			locked_at: "2026-05-31T00:00:00.000Z",
			locked_by: "worker-a",
			created_at: "2026-05-31T00:00:00.000Z",
			updated_at: "2026-05-31T00:00:00.000Z",
		});

		expect(result).toEqual({ status: "retryable", reason: "google_customer_unresolved" });
		expect(calls).not.toContain("ack-subscription:premium_monthly:purchase_token_1");
	});

	it("replays skipped Google voided purchase events through the voided purchase repository", async () => {
		const { service, calls, repositoryInputs } = serviceFixture({
			voidedRecordingResult: "skipped",
		});

		const result = await service.replayStoreEvent({
			id: "event_voided",
			project_id: "project_1",
			project_key: "voysee",
			provider: "google",
			channel: "android",
			external_event_id:
				"google:voided:purchase_token_voided:1780185600000:2:1:GPA.1234-5678-9012-34567",
			event_type: "VOIDED_PURCHASE",
			customer_id: null,
			store_product_id: null,
			transaction_id: "purchase_token_voided",
			purchase_kind: null,
			processing_status: "processing",
			processing_error: null,
			attempts: 0,
			next_attempt_at: null,
			raw_payload: {
				version: "1.0",
				packageName: "com.voysee.app",
				eventTimeMillis: "1780185600000",
				voidedPurchaseNotification: {
					purchaseToken: "purchase_token_voided",
					orderId: "GPA.1234-5678-9012-34567",
					productType: 2,
					refundType: 1,
				},
			},
			processed_at: null,
			locked_at: "2026-05-31T00:00:00.000Z",
			locked_by: "worker-a",
			created_at: "2026-05-31T00:00:00.000Z",
			updated_at: "2026-05-31T00:00:00.000Z",
		});

		expect(result).toEqual({ status: "retryable", reason: "google_customer_unresolved" });
		expect(calls).toEqual([
			"get-product:purchase_token_voided",
			"record-voided:purchase_token_voided:GPA.1234-5678-9012-34567",
		]);
		expect(repositoryInputs[0]).toMatchObject({
			purchaseToken: "purchase_token_voided",
			orderId: "GPA.1234-5678-9012-34567",
			eventType: "VOIDED_PURCHASE",
			externalEventId:
				"google:voided:purchase_token_voided:1780185600000:2:1:GPA.1234-5678-9012-34567",
			projectionReason: "provider_webhook",
			projectionIdempotencyKey:
				"google:voided:purchase_token_voided:1780185600000:2:1:GPA.1234-5678-9012-34567:projection",
		});
	});

	it("ignores stored Google events without a recordable purchase kind", async () => {
		const { service } = serviceFixture();

		const result = await service.replayStoreEvent({
			id: "event_1",
			project_id: "project_1",
			project_key: "voysee",
			provider: "google",
			channel: "android",
			external_event_id: "google:message_1",
			event_type: "UNKNOWN",
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
			reason: "google_store_event_not_recordable",
		});
	});

	it("reconciles provider subscriptions from current Google Play state", async () => {
		const { service, calls, repositoryInputs } = serviceFixture();

		const result = await service.reconcileSubscription(reconciliationSubscription());

		expect(result).toEqual({ status: "processed" });
		expect(calls).toEqual(["get-subscription:purchase_token_1", "record:purchase_token_1"]);
		expect(repositoryInputs[0]).toMatchObject({
			billingAccountId: null,
			purchaseToken: "purchase_token_1",
			eventType: "provider_reconciliation",
			externalEventId: null,
			projectionReason: "provider_reconciliation",
			projectionIdempotencyKey: `google:purchase_token_1:provider_reconciliation:SUBSCRIPTION_STATE_ACTIVE:active:auto_renew:true:premium_monthly:monthly-base:GPA.1234-5678-9012-34567:${farFutureSubscriptionExpiry}`,
		});
	});

	it("skips provider subscription reconciliation for pending Google Play purchases", async () => {
		const { service, calls, repositoryInputs } = serviceFixture({
			subscriptionPurchase: subscriptionPurchase({
				subscriptionState: "SUBSCRIPTION_STATE_PENDING",
			}),
		});

		const result = await service.reconcileSubscription(reconciliationSubscription());

		expect(result).toEqual({ status: "skipped" });
		expect(calls).toEqual(["get-subscription:purchase_token_1"]);
		expect(repositoryInputs).toEqual([]);
	});

	it("rejects non-Google provider subscription reconciliation rows", async () => {
		const { service } = serviceFixture();

		await expect(
			service.reconcileSubscription(
				reconciliationSubscription({ provider: "apple", channel: "ios" }),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
	});
});
