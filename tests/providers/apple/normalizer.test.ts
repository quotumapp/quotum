import { describe, expect, it } from "bun:test";
import {
	normalizeStoreKitNotification,
	normalizeStoreKitSubscriptionStatusRefresh,
	normalizeVerifiedStoreKitTransaction,
} from "../../../src/providers/apple/normalizer";
import type {
	AppleDecodedNotificationPayload,
	AppleDecodedRenewalInfoPayload,
	AppleDecodedTransactionPayload,
} from "../../../src/providers/apple/types";

const now = new Date("2026-05-31T00:00:00.000Z");

const subscriptionTransaction = (
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
	notificationType: string,
	overrides: Partial<AppleDecodedNotificationPayload> = {},
): AppleDecodedNotificationPayload => ({
	notificationType,
	notificationUUID: "notification_1",
	data: {
		bundleId: "com.voysee.app",
		environment: "Sandbox",
	},
	...overrides,
});

const renewalInfo = (
	overrides: Partial<AppleDecodedRenewalInfoPayload> = {},
): AppleDecodedRenewalInfoPayload => ({
	autoRenewStatus: 1,
	...overrides,
});

describe("StoreKit normalizer", () => {
	it("maps active auto-renewable subscriptions to active billing commands", () => {
		const command = normalizeVerifiedStoreKitTransaction({
			billingAccountId: "user_1",
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo(),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command).toMatchObject({
			billingAccountId: "user_1",
			appAccountToken: "11111111-1111-1111-1111-111111111111",
			externalProductId: "premium_monthly",
			purchaseKind: "subscription",
			transactionId: "200000000000001",
			originalTransactionId: "100000000000001",
			webOrderLineItemId: "300000000000001",
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			autoRenew: true,
			eventType: "purchase_verified",
			externalEventId: "apple:transaction:200000000000001:purchase_verified",
			projectionReason: "purchase_verified",
			projectionIdempotencyKey: "apple:200000000000001:purchase_verified",
		});
		expect(command.purchasedAt.toISOString()).toBe("2026-05-31T00:00:00.000Z");
		expect(command.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
	});

	it("uses only the transaction app account token for StoreKit identity binding", () => {
		const command = normalizeVerifiedStoreKitTransaction({
			billingAccountId: "user_1",
			transaction: subscriptionTransaction({ appAccountToken: undefined }),
			renewalInfo: renewalInfo({
				appAccountToken: "11111111-1111-1111-1111-111111111111",
			}),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command.appAccountToken).toBeNull();
	});

	it("maps failed renewal with grace period to grace_period", () => {
		const command = normalizeStoreKitNotification({
			notification: notification("DID_FAIL_TO_RENEW"),
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo({
				gracePeriodExpiresDate: Date.parse("2026-06-05T00:00:00.000Z"),
				isInBillingRetryPeriod: true,
			}),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command?.subscriptionStatus).toBe("grace_period");
		expect(command?.externalEventId).toBe("notification_1");
		expect(command?.projectionIdempotencyKey).toBe("apple:notification_1:projection");
	});

	it("maps failed renewal without grace period to billing_retry", () => {
		const command = normalizeStoreKitNotification({
			notification: notification("DID_FAIL_TO_RENEW"),
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo({ isInBillingRetryPeriod: true }),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command?.subscriptionStatus).toBe("billing_retry");
	});

	it("uses the failed renewal grace-period subtype even when renewal info omits a grace date", () => {
		const command = normalizeStoreKitNotification({
			notification: notification("DID_FAIL_TO_RENEW", { subtype: "GRACE_PERIOD" }),
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo({ isInBillingRetryPeriod: true }),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command?.subscriptionStatus).toBe("grace_period");
	});

	it("maps failed renewal without retry fields to billing_retry", () => {
		const command = normalizeStoreKitNotification({
			notification: notification("DID_FAIL_TO_RENEW"),
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo(),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command?.subscriptionStatus).toBe("billing_retry");
	});

	it("maps expired notifications to expired", () => {
		for (const notificationType of ["EXPIRED", "GRACE_PERIOD_EXPIRED"]) {
			const command = normalizeStoreKitNotification({
				notification: notification(notificationType),
				transaction: subscriptionTransaction({
					expiresDate: Date.parse("2026-05-30T00:00:00.000Z"),
				}),
				renewalInfo: renewalInfo({ autoRenewStatus: 0 }),
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			});

			expect(command?.subscriptionStatus).toBe("expired");
		}
	});

	it("maps refunds and revocations to invalidated purchase commands", () => {
		const refund = normalizeStoreKitNotification({
			notification: notification("REFUND"),
			transaction: subscriptionTransaction({
				revocationDate: Date.parse("2026-06-01T00:00:00.000Z"),
			}),
			renewalInfo: renewalInfo(),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});
		const revoke = normalizeStoreKitNotification({
			notification: notification("REVOKE"),
			transaction: subscriptionTransaction({
				revocationDate: Date.parse("2026-06-01T00:00:00.000Z"),
			}),
			renewalInfo: renewalInfo(),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(refund?.purchaseStatus).toBe("refunded");
		expect(refund?.subscriptionStatus).toBe("refunded");
		expect(refund?.invalidationReason).toBe("refund");
		expect(revoke?.purchaseStatus).toBe("revoked");
		expect(revoke?.subscriptionStatus).toBe("revoked");
		expect(revoke?.invalidationReason).toBe("revoke");
		expect(revoke?.invalidatedAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
	});

	it("does not keep revoked verified transactions active", () => {
		const command = normalizeVerifiedStoreKitTransaction({
			billingAccountId: "user_1",
			transaction: subscriptionTransaction({
				revocationDate: Date.parse("2026-06-01T00:00:00.000Z"),
			}),
			renewalInfo: renewalInfo(),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command.purchaseStatus).toBe("revoked");
		expect(command.subscriptionStatus).toBe("revoked");
		expect(command.invalidationReason).toBe("revocation");
	});

	it("restores transactions for refund reversal notifications", () => {
		const command = normalizeStoreKitNotification({
			notification: notification("REFUND_REVERSED"),
			transaction: subscriptionTransaction({
				revocationDate: Date.parse("2026-06-01T00:00:00.000Z"),
			}),
			renewalInfo: renewalInfo(),
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command?.purchaseStatus).toBe("completed");
		expect(command?.subscriptionStatus).toBe("active");
		expect(command?.invalidatedAt).toBeNull();
		expect(command?.invalidationReason).toBeNull();
	});

	it("maps one-time consumable charges to consumable purchase commands", () => {
		const command = normalizeStoreKitNotification({
			notification: notification("ONE_TIME_CHARGE"),
			transaction: subscriptionTransaction({
				productId: "echo_credits_10",
				type: "CONSUMABLE",
				originalTransactionId: undefined,
				webOrderLineItemId: undefined,
				expiresDate: undefined,
			}),
			renewalInfo: null,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command).toMatchObject({
			purchaseKind: "consumable",
			subscriptionStatus: null,
			originalTransactionId: null,
			webOrderLineItemId: null,
			externalProductId: "echo_credits_10",
		});
	});

	it("ignores signed TEST notifications after verification", () => {
		const command = normalizeStoreKitNotification({
			notification: notification("TEST"),
			transaction: null,
			renewalInfo: null,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command).toBeNull();
	});

	it("explicitly ignores Apple notifications that do not change local entitlements", () => {
		const ignoredCases: Array<{
			notificationType: string;
			subtype?: string;
			transaction: AppleDecodedTransactionPayload | null;
		}> = [
			{ notificationType: "REFUND_DECLINED", transaction: subscriptionTransaction() },
			{ notificationType: "CONSUMPTION_REQUEST", transaction: subscriptionTransaction() },
			{ notificationType: "RENEWAL_EXTENSION", subtype: "SUMMARY", transaction: null },
			{
				notificationType: "RENEWAL_EXTENSION",
				subtype: "FAILURE",
				transaction: subscriptionTransaction(),
			},
			{ notificationType: "EXTERNAL_PURCHASE_TOKEN", subtype: "CREATED", transaction: null },
			{
				notificationType: "EXTERNAL_PURCHASE_TOKEN",
				subtype: "ACTIVE_TOKEN_REMINDER",
				transaction: null,
			},
			{ notificationType: "EXTERNAL_PURCHASE_TOKEN", subtype: "UNREPORTED", transaction: null },
			{ notificationType: "RESCIND_CONSENT", transaction: null },
			{ notificationType: "METADATA_UPDATE", transaction: subscriptionTransaction() },
			{ notificationType: "MIGRATION", transaction: subscriptionTransaction() },
			{ notificationType: "PRICE_CHANGE", transaction: subscriptionTransaction() },
		];

		for (const testCase of ignoredCases) {
			const command = normalizeStoreKitNotification({
				notification: notification(testCase.notificationType, {
					subtype: testCase.subtype,
				}),
				transaction: testCase.transaction,
				renewalInfo: null,
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			});

			expect(command).toBeNull();
		}
	});

	it("rejects unknown Apple notification types and subtype combinations", () => {
		expect(() =>
			normalizeStoreKitNotification({
				notification: notification("UNKNOWN_TYPE"),
				transaction: subscriptionTransaction(),
				renewalInfo: renewalInfo(),
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			}),
		).toThrow("Unsupported Apple notification type: UNKNOWN_TYPE");

		expect(() =>
			normalizeStoreKitNotification({
				notification: notification("DID_RENEW", { subtype: "UPGRADE" }),
				transaction: subscriptionTransaction(),
				renewalInfo: renewalInfo(),
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			}),
		).toThrow("Unsupported Apple notification subtype UPGRADE for DID_RENEW");
	});

	it("rejects mismatched bundle id or environment", () => {
		expect(() =>
			normalizeVerifiedStoreKitTransaction({
				billingAccountId: "user_1",
				transaction: subscriptionTransaction({ bundleId: "com.other.app" }),
				renewalInfo: renewalInfo(),
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			}),
		).toThrow("Apple transaction bundle mismatch");

		expect(() =>
			normalizeVerifiedStoreKitTransaction({
				billingAccountId: "user_1",
				transaction: subscriptionTransaction({ environment: "Production" }),
				renewalInfo: renewalInfo(),
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			}),
		).toThrow("Apple transaction environment mismatch");
	});

	it("normalizes provider reconciliation with a deterministic transaction key", () => {
		const command = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo(),
			storeKitStatus: 1,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command).toMatchObject({
			billingAccountId: null,
			eventType: "provider_reconciliation",
			externalEventId: null,
			projectionReason: "provider_reconciliation",
			projectionIdempotencyKey:
				"apple:200000000000001:provider_reconciliation:100000000000001:300000000000001:premium_monthly:2026-06-30T00:00:00.000Z:completed:active:auto_renew:true:storekit_status:1:billing_retry:false:grace:no_grace:invalidated:none:invalidation_reason:none",
			subscriptionStatus: "active",
		});
	});

	it("uses StoreKit status for provider reconciliation subscription states", () => {
		for (const [storeKitStatus, subscriptionStatus] of [
			[3, "billing_retry"],
			[4, "grace_period"],
		] as const) {
			const command = normalizeStoreKitSubscriptionStatusRefresh({
				billingAccountId: null,
				transaction: subscriptionTransaction({
					expiresDate: Date.parse("2026-05-30T00:00:00.000Z"),
				}),
				renewalInfo: renewalInfo(),
				storeKitStatus,
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			});

			expect(command.purchaseStatus).toBe("completed");
			expect(command.subscriptionStatus).toBe(subscriptionStatus);
			expect(command.projectionIdempotencyKey).toContain(`:completed:${subscriptionStatus}:`);
			expect(command.projectionIdempotencyKey).toContain(`:storekit_status:${storeKitStatus}:`);
		}
	});

	it("uses effective grace expiry for StoreKit status 4 provider reconciliation", () => {
		const gracePeriodExpiresDate = Date.parse("2026-06-05T00:00:00.000Z");
		const first = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction({
				expiresDate: Date.parse("2026-05-30T00:00:00.000Z"),
			}),
			renewalInfo: renewalInfo({ gracePeriodExpiresDate }),
			storeKitStatus: 4,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});
		const second = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction({
				expiresDate: Date.parse("2026-05-30T00:00:00.000Z"),
			}),
			renewalInfo: renewalInfo({ gracePeriodExpiresDate }),
			storeKitStatus: 4,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now: new Date("2026-06-01T00:00:00.000Z"),
		});

		expect(first.subscriptionStatus).toBe("grace_period");
		expect(first.expiresAt?.toISOString()).toBe("2026-06-05T00:00:00.000Z");
		expect(first.projectionIdempotencyKey).toBe(second.projectionIdempotencyKey);
		expect(first.projectionIdempotencyKey).toContain(
			":premium_monthly:2026-06-05T00:00:00.000Z:completed:grace_period:",
		);
		expect(first.projectionIdempotencyKey).toContain("grace:2026-06-05T00:00:00.000Z");
	});

	it("maps StoreKit status 5 provider reconciliation to revoked semantics", () => {
		const command = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction({
				revocationDate: undefined,
			}),
			renewalInfo: renewalInfo(),
			storeKitStatus: 5,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(command.purchaseStatus).toBe("revoked");
		expect(command.subscriptionStatus).toBe("revoked");
		expect(command.invalidatedAt).toBeNull();
		expect(command.invalidationReason).toBe("revocation");
		expect(command.projectionIdempotencyKey).toContain(
			":revoked:revoked:auto_renew:true:storekit_status:5:",
		);
	});

	it("keeps StoreKit status 5 provider reconciliation key stable without revocation date", () => {
		const first = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction({
				revocationDate: undefined,
			}),
			renewalInfo: renewalInfo(),
			storeKitStatus: 5,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now: new Date("2026-05-31T00:00:00.000Z"),
		});
		const second = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction({
				revocationDate: undefined,
			}),
			renewalInfo: renewalInfo(),
			storeKitStatus: 5,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now: new Date("2026-06-01T00:00:00.000Z"),
		});

		expect(first.invalidatedAt).toBeNull();
		expect(second.invalidatedAt).toBeNull();
		expect(first.invalidatedAt).toBe(second.invalidatedAt);
		expect(first.projectionIdempotencyKey).toBe(second.projectionIdempotencyKey);
		expect(first.projectionIdempotencyKey).toContain("invalidated:provider_revoked_no_date");
	});

	it("changes provider reconciliation idempotency when StoreKit state changes for the same transaction", () => {
		const active = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo({ autoRenewStatus: 1 }),
			storeKitStatus: 1,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});
		const billingRetry = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo({ autoRenewStatus: 1, isInBillingRetryPeriod: true }),
			storeKitStatus: 3,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});
		const autoRenewOff = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction(),
			renewalInfo: renewalInfo({ autoRenewStatus: 0 }),
			storeKitStatus: 1,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});
		const revoked = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: subscriptionTransaction({
				revocationDate: Date.parse("2026-06-01T00:00:00.000Z"),
			}),
			renewalInfo: renewalInfo({ autoRenewStatus: 1 }),
			storeKitStatus: 5,
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			now,
		});

		expect(billingRetry.projectionIdempotencyKey).not.toBe(active.projectionIdempotencyKey);
		expect(autoRenewOff.projectionIdempotencyKey).not.toBe(active.projectionIdempotencyKey);
		expect(revoked.projectionIdempotencyKey).not.toBe(active.projectionIdempotencyKey);
		expect(billingRetry.transactionId).toBe(active.transactionId);
		expect(autoRenewOff.transactionId).toBe(active.transactionId);
		expect(revoked.transactionId).toBe(active.transactionId);
	});

	it("validates provider reconciliation transaction context", () => {
		expect(() =>
			normalizeStoreKitSubscriptionStatusRefresh({
				billingAccountId: null,
				transaction: subscriptionTransaction({ bundleId: "com.other.app" }),
				renewalInfo: renewalInfo(),
				storeKitStatus: 1,
				expectedBundleId: "com.voysee.app",
				expectedEnvironment: "sandbox",
				now,
			}),
		).toThrow("Apple transaction bundle mismatch");
	});
});
