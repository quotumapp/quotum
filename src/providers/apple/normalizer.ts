import type { ProjectionSyncReason } from "../../billing/types";
import type { StoreEventReplayJobRow } from "../../db/repository";
import type {
	AppleDecodedNotificationPayload,
	AppleDecodedRenewalInfoPayload,
	AppleDecodedTransactionPayload,
	AppleEnvironmentName,
	NormalizedStoreKitTransaction,
} from "./types";

interface NormalizeVerifiedTransactionInput {
	billingAccountId: string;
	transaction: AppleDecodedTransactionPayload;
	renewalInfo: AppleDecodedRenewalInfoPayload | null;
	expectedBundleId: string;
	expectedEnvironment: AppleEnvironmentName;
	now?: Date;
}

interface NormalizeNotificationInput {
	notification: AppleDecodedNotificationPayload;
	transaction: AppleDecodedTransactionPayload | null;
	renewalInfo: AppleDecodedRenewalInfoPayload | null;
	expectedBundleId: string;
	expectedEnvironment: AppleEnvironmentName;
	now?: Date;
}

interface NormalizeSubscriptionStatusRefreshInput {
	billingAccountId: string | null;
	transaction: AppleDecodedTransactionPayload;
	renewalInfo: AppleDecodedRenewalInfoPayload | null;
	storeKitStatus: number | null;
	expectedBundleId: string;
	expectedEnvironment: AppleEnvironmentName;
	now?: Date;
}

type StoreKitRecordingProjectionReason = Extract<
	ProjectionSyncReason,
	"purchase_verified" | "provider_webhook" | "provider_reconciliation"
>;

interface AppleNotificationHandling {
	action: "record" | "ignore";
	allowedSubtypes: readonly (string | null)[];
}

const appleNotificationHandlingByType: Record<string, AppleNotificationHandling> = {
	SUBSCRIBED: { action: "record", allowedSubtypes: ["INITIAL_BUY", "RESUBSCRIBE"] },
	DID_CHANGE_RENEWAL_PREF: { action: "record", allowedSubtypes: [null, "DOWNGRADE", "UPGRADE"] },
	DID_CHANGE_RENEWAL_STATUS: {
		action: "record",
		allowedSubtypes: [null, "AUTO_RENEW_ENABLED", "AUTO_RENEW_DISABLED"],
	},
	OFFER_REDEEMED: { action: "record", allowedSubtypes: [null, "DOWNGRADE", "UPGRADE"] },
	DID_RENEW: { action: "record", allowedSubtypes: [null, "BILLING_RECOVERY"] },
	EXPIRED: {
		action: "record",
		allowedSubtypes: [null, "VOLUNTARY", "BILLING_RETRY", "PRICE_INCREASE", "PRODUCT_NOT_FOR_SALE"],
	},
	DID_FAIL_TO_RENEW: { action: "record", allowedSubtypes: [null, "GRACE_PERIOD"] },
	GRACE_PERIOD_EXPIRED: { action: "record", allowedSubtypes: [null] },
	PRICE_INCREASE: { action: "record", allowedSubtypes: ["PENDING", "ACCEPTED"] },
	REFUND: { action: "record", allowedSubtypes: [null] },
	REFUND_DECLINED: { action: "ignore", allowedSubtypes: [null] },
	CONSUMPTION_REQUEST: { action: "ignore", allowedSubtypes: [null] },
	RENEWAL_EXTENDED: { action: "record", allowedSubtypes: [null] },
	REVOKE: { action: "record", allowedSubtypes: [null] },
	TEST: { action: "ignore", allowedSubtypes: [null] },
	RENEWAL_EXTENSION: { action: "ignore", allowedSubtypes: ["SUMMARY", "FAILURE"] },
	REFUND_REVERSED: { action: "record", allowedSubtypes: [null] },
	EXTERNAL_PURCHASE_TOKEN: {
		action: "ignore",
		allowedSubtypes: ["CREATED", "ACTIVE_TOKEN_REMINDER", "UNREPORTED"],
	},
	ONE_TIME_CHARGE: { action: "record", allowedSubtypes: [null] },
	RESCIND_CONSENT: { action: "ignore", allowedSubtypes: [null] },
	METADATA_UPDATE: { action: "ignore", allowedSubtypes: [null] },
	MIGRATION: { action: "ignore", allowedSubtypes: [null] },
	PRICE_CHANGE: { action: "ignore", allowedSubtypes: [null] },
};

export function normalizeVerifiedStoreKitTransaction(
	input: NormalizeVerifiedTransactionInput,
): NormalizedStoreKitTransaction {
	validateTransactionContext(input.transaction, input.expectedBundleId, input.expectedEnvironment);

	return normalizeTransaction({
		billingAccountId: input.billingAccountId,
		transaction: input.transaction,
		renewalInfo: input.renewalInfo,
		notificationType: null,
		notificationSubtype: null,
		externalEventId: verifiedTransactionExternalEventId(input.transaction),
		projectionReason: "purchase_verified",
		storeKitStatus: null,
		now: input.now ?? new Date(),
	});
}

export function normalizeStoreKitSubscriptionStatusRefresh(
	input: NormalizeSubscriptionStatusRefreshInput,
): NormalizedStoreKitTransaction {
	validateTransactionContext(input.transaction, input.expectedBundleId, input.expectedEnvironment);

	return normalizeTransaction({
		billingAccountId: input.billingAccountId,
		transaction: input.transaction,
		renewalInfo: input.renewalInfo,
		notificationType: "provider_reconciliation",
		notificationSubtype: null,
		externalEventId: null,
		projectionReason: "provider_reconciliation",
		storeKitStatus: input.storeKitStatus,
		now: input.now ?? new Date(),
	});
}

export function normalizeStoreKitNotification(
	input: NormalizeNotificationInput,
): NormalizedStoreKitTransaction | null {
	const notificationHandling = appleNotificationHandling(input.notification);

	if (input.notification.notificationType !== "TEST") {
		validateNotificationContext(
			input.notification,
			input.expectedBundleId,
			input.expectedEnvironment,
		);
	}

	if (notificationHandling.action === "ignore") {
		return null;
	}

	if (!input.transaction) {
		throw new Error(
			`Apple notification ${input.notification.notificationType} requires transaction payload`,
		);
	}

	validateTransactionContext(input.transaction, input.expectedBundleId, input.expectedEnvironment);

	return normalizeTransaction({
		billingAccountId: null,
		transaction: input.transaction,
		renewalInfo: input.renewalInfo,
		notificationType: input.notification.notificationType,
		notificationSubtype: notificationHandling.subtype,
		externalEventId: input.notification.notificationUUID,
		projectionReason: "provider_webhook",
		storeKitStatus: null,
		now: input.now ?? new Date(),
	});
}

export function normalizeStoredStoreKitEvent(input: {
	event: StoreEventReplayJobRow;
	expectedBundleId: string;
	expectedEnvironment: AppleEnvironmentName;
	now?: Date;
}): NormalizedStoreKitTransaction | null {
	const transaction = input.event.raw_payload.transaction as
		| AppleDecodedTransactionPayload
		| null
		| undefined;
	if (transaction === null || transaction === undefined) {
		return null;
	}

	validateTransactionContext(transaction, input.expectedBundleId, input.expectedEnvironment);
	const notificationSubtype =
		typeof input.event.raw_payload.notificationSubtype === "string"
			? input.event.raw_payload.notificationSubtype
			: null;
	const notificationHandling = appleNotificationHandling({
		notificationType: input.event.event_type,
		subtype: notificationSubtype ?? undefined,
		notificationUUID: input.event.external_event_id ?? input.event.id,
	});

	if (notificationHandling.action === "ignore") {
		return null;
	}

	return normalizeTransaction({
		billingAccountId: null,
		transaction,
		renewalInfo:
			(input.event.raw_payload.renewalInfo as AppleDecodedRenewalInfoPayload | null) ?? null,
		notificationType: input.event.event_type,
		notificationSubtype: notificationHandling.subtype,
		externalEventId: input.event.external_event_id,
		projectionReason: "provider_webhook",
		storeKitStatus: null,
		now: input.now ?? new Date(),
	});
}

interface NormalizeTransactionInput {
	billingAccountId: string | null;
	transaction: AppleDecodedTransactionPayload;
	renewalInfo: AppleDecodedRenewalInfoPayload | null;
	notificationType: string | null;
	notificationSubtype: string | null;
	externalEventId: string | null;
	projectionReason: StoreKitRecordingProjectionReason;
	storeKitStatus: number | null;
	now: Date;
}

function normalizeTransaction(input: NormalizeTransactionInput): NormalizedStoreKitTransaction {
	const transactionId = requireString(input.transaction.transactionId, "Apple transaction id");
	const productId = requireString(input.transaction.productId, "Apple product id");
	const purchaseKind = normalizePurchaseKind(input.transaction.type);
	const purchaseStatus = derivePurchaseStatus(
		input.notificationType,
		input.transaction,
		input.storeKitStatus,
	);
	const invalidatedAt = deriveInvalidatedAt(
		input.notificationType,
		input.transaction,
		input.storeKitStatus,
		input.now,
	);
	const invalidationReason = deriveInvalidationReason(
		input.notificationType,
		input.transaction,
		input.storeKitStatus,
	);
	const purchasedAt = dateFromMillis(input.transaction.purchaseDate, "Apple purchase date");
	const transactionExpiresAt = optionalDateFromMillis(input.transaction.expiresDate);
	const expiresAt = deriveEffectiveExpiresAt({
		transactionExpiresAt,
		renewalInfo: input.renewalInfo,
		notificationType: input.notificationType,
		notificationSubtype: input.notificationSubtype,
		storeKitStatus: input.storeKitStatus,
		now: input.now,
	});
	const autoRenew = normalizeAutoRenew(input.renewalInfo);
	const eventType = input.notificationType ?? "purchase_verified";
	const subscriptionStatus =
		purchaseKind === "subscription"
			? deriveSubscriptionStatus(
					input.notificationType,
					input.notificationSubtype,
					input.transaction,
					expiresAt,
					input.renewalInfo,
					input.storeKitStatus,
					input.now,
				)
			: null;

	return {
		billingAccountId: input.billingAccountId,
		appAccountToken: input.transaction.appAccountToken ?? null,
		externalProductId: productId,
		purchaseKind,
		transactionId,
		originalTransactionId: input.transaction.originalTransactionId ?? null,
		webOrderLineItemId: input.transaction.webOrderLineItemId ?? null,
		purchaseStatus,
		subscriptionStatus,
		purchasedAt,
		expiresAt,
		autoRenew,
		invalidatedAt,
		invalidationReason,
		rawPayload: {
			transaction: input.transaction,
			renewalInfo: input.renewalInfo,
			notificationType: input.notificationType,
			notificationSubtype: input.notificationSubtype,
			storeKitStatus: input.storeKitStatus,
		},
		eventType,
		externalEventId: input.externalEventId,
		projectionReason: input.projectionReason,
		projectionIdempotencyKey: appleProjectionIdempotencyKey({
			input,
			transactionId,
			productId,
			expiresAt,
			purchaseStatus,
			subscriptionStatus,
			autoRenew,
			invalidatedAt,
			invalidationReason,
		}),
	};
}

function appleProjectionIdempotencyKey({
	input,
	transactionId,
	productId,
	expiresAt,
	purchaseStatus,
	subscriptionStatus,
	autoRenew,
	invalidatedAt,
	invalidationReason,
}: {
	input: NormalizeTransactionInput;
	transactionId: string;
	productId: string;
	expiresAt: Date | null;
	purchaseStatus: "completed" | "refunded" | "revoked" | "voided";
	subscriptionStatus:
		| "active"
		| "grace_period"
		| "billing_retry"
		| "cancelled"
		| "expired"
		| "refunded"
		| "revoked"
		| null;
	autoRenew: boolean | null;
	invalidatedAt: Date | null;
	invalidationReason: string | null;
}): string {
	if (input.projectionReason === "purchase_verified") {
		return `apple:${transactionId}:purchase_verified`;
	}

	if (input.projectionReason === "provider_reconciliation") {
		return [
			"apple",
			transactionId,
			"provider_reconciliation",
			input.transaction.originalTransactionId ?? "no_original_transaction",
			input.transaction.webOrderLineItemId ?? "no_web_order_line_item",
			productId,
			expiresAt?.toISOString() ?? "no_expires",
			purchaseStatus,
			subscriptionStatus ?? "no_subscription",
			`auto_renew:${autoRenew ?? "unknown"}`,
			`storekit_status:${input.storeKitStatus ?? "unknown"}`,
			`billing_retry:${input.renewalInfo?.isInBillingRetryPeriod === true}`,
			`grace:${optionalDateFromMillis(input.renewalInfo?.gracePeriodExpiresDate)?.toISOString() ?? "no_grace"}`,
			`invalidated:${providerReconciliationInvalidatedKey(input, invalidatedAt)}`,
			`invalidation_reason:${invalidationReason ?? "none"}`,
		].join(":");
	}

	if (input.externalEventId === null) {
		throw new Error("externalEventId is required for Apple provider webhook projection keys");
	}

	return `apple:${input.externalEventId}:projection`;
}

function verifiedTransactionExternalEventId(transaction: AppleDecodedTransactionPayload): string {
	const transactionId = requireString(transaction.transactionId, "Apple transaction id");
	return `apple:transaction:${transactionId}:purchase_verified`;
}

function providerReconciliationInvalidatedKey(
	input: NormalizeTransactionInput,
	invalidatedAt: Date | null,
): string {
	if (
		input.storeKitStatus === 5 &&
		input.transaction.revocationDate === undefined &&
		input.notificationType === "provider_reconciliation"
	) {
		return "provider_revoked_no_date";
	}

	return invalidatedAt?.toISOString() ?? "none";
}

function validateNotificationContext(
	notification: AppleDecodedNotificationPayload,
	expectedBundleId: string,
	expectedEnvironment: AppleEnvironmentName,
): void {
	if (notification.data?.bundleId && notification.data.bundleId !== expectedBundleId) {
		throw new Error("Apple notification bundle mismatch");
	}

	if (
		notification.data?.environment &&
		normalizeEnvironment(notification.data.environment) !== expectedEnvironment
	) {
		throw new Error("Apple notification environment mismatch");
	}
}

function validateTransactionContext(
	transaction: AppleDecodedTransactionPayload,
	expectedBundleId: string,
	expectedEnvironment: AppleEnvironmentName,
): void {
	if (transaction.bundleId !== expectedBundleId) {
		throw new Error("Apple transaction bundle mismatch");
	}

	if (normalizeEnvironment(transaction.environment) !== expectedEnvironment) {
		throw new Error("Apple transaction environment mismatch");
	}
}

function normalizeEnvironment(value: string | undefined): AppleEnvironmentName {
	if (value === "Sandbox" || value === "sandbox") {
		return "sandbox";
	}

	if (value === "Production" || value === "production") {
		return "production";
	}

	throw new Error("Apple transaction environment mismatch");
}

function normalizePurchaseKind(
	value: string | undefined,
): "subscription" | "consumable" | "non_consumable" {
	const normalized = value?.toLowerCase().replace(/[-\s]/g, "_");

	if (normalized === "auto_renewable_subscription" || normalized?.includes("subscription")) {
		return "subscription";
	}

	if (normalized === "consumable") {
		return "consumable";
	}

	if (normalized === "non_consumable" || normalized === "nonconsumable") {
		return "non_consumable";
	}

	throw new Error(`Unsupported Apple product type: ${value ?? "unknown"}`);
}

function deriveEffectiveExpiresAt(input: {
	transactionExpiresAt: Date | null;
	renewalInfo: AppleDecodedRenewalInfoPayload | null;
	notificationType: string | null;
	notificationSubtype: string | null;
	storeKitStatus: number | null;
	now: Date;
}): Date | null {
	const gracePeriodExpiresAt = optionalDateFromMillis(input.renewalInfo?.gracePeriodExpiresDate);
	const usesGraceAccess =
		input.storeKitStatus === 4 ||
		input.notificationType === "DID_FAIL_TO_RENEW" ||
		input.notificationSubtype === "GRACE_PERIOD";

	if (!usesGraceAccess || gracePeriodExpiresAt === null || gracePeriodExpiresAt <= input.now) {
		return input.transactionExpiresAt;
	}

	if (input.transactionExpiresAt === null || gracePeriodExpiresAt > input.transactionExpiresAt) {
		return gracePeriodExpiresAt;
	}

	return input.transactionExpiresAt;
}

function derivePurchaseStatus(
	notificationType: string | null,
	transaction: AppleDecodedTransactionPayload,
	storeKitStatus: number | null,
): "completed" | "refunded" | "revoked" | "voided" {
	if (notificationType === "REFUND_REVERSED") {
		return "completed";
	}

	if (storeKitStatus === 5) {
		return "revoked";
	}

	if (notificationType === "REFUND") {
		return "refunded";
	}

	if (notificationType === "REVOKE" || transaction.revocationDate !== undefined) {
		return "revoked";
	}

	return "completed";
}

function deriveSubscriptionStatus(
	notificationType: string | null,
	notificationSubtype: string | null,
	transaction: AppleDecodedTransactionPayload,
	expiresAt: Date | null,
	renewalInfo: AppleDecodedRenewalInfoPayload | null,
	storeKitStatus: number | null,
	now: Date,
): "active" | "grace_period" | "billing_retry" | "cancelled" | "expired" | "refunded" | "revoked" {
	if (notificationType === "REFUND_REVERSED") {
		return expiresAt !== null && expiresAt <= now ? "expired" : "active";
	}

	switch (storeKitStatus) {
		case 1:
			if (transaction.revocationDate === undefined) {
				return "active";
			}
			break;
		case 2:
			return "expired";
		case 3:
			return "billing_retry";
		case 4:
			return "grace_period";
		case 5:
			return "revoked";
	}

	if (notificationType === "REFUND") {
		return "refunded";
	}

	if (notificationType === "REVOKE") {
		return "revoked";
	}

	if (transaction.revocationDate !== undefined) {
		return "revoked";
	}

	if (notificationType === "EXPIRED" || notificationType === "GRACE_PERIOD_EXPIRED") {
		return "expired";
	}

	const gracePeriodExpiresAt = optionalDateFromMillis(renewalInfo?.gracePeriodExpiresDate);
	if (notificationType === "DID_FAIL_TO_RENEW" && notificationSubtype === "GRACE_PERIOD") {
		return "grace_period";
	}

	if (
		notificationType === "DID_FAIL_TO_RENEW" &&
		gracePeriodExpiresAt !== null &&
		gracePeriodExpiresAt > now
	) {
		return "grace_period";
	}

	if (notificationType === "DID_FAIL_TO_RENEW" && renewalInfo?.isInBillingRetryPeriod) {
		return "billing_retry";
	}

	if (notificationType === "DID_FAIL_TO_RENEW") {
		return "billing_retry";
	}

	if (
		notificationType === "DID_CHANGE_RENEWAL_STATUS" &&
		(notificationSubtype === "AUTO_RENEW_DISABLED" || normalizeAutoRenew(renewalInfo) === false)
	) {
		return expiresAt !== null && expiresAt <= now ? "cancelled" : "active";
	}

	if (expiresAt !== null && expiresAt <= now) {
		return "expired";
	}

	return "active";
}

function deriveInvalidatedAt(
	notificationType: string | null,
	transaction: AppleDecodedTransactionPayload,
	storeKitStatus: number | null,
	now: Date,
): Date | null {
	if (notificationType === "REFUND_REVERSED") {
		return null;
	}

	if (storeKitStatus === 5) {
		return notificationType === "provider_reconciliation"
			? optionalDateFromMillis(transaction.revocationDate)
			: (optionalDateFromMillis(transaction.revocationDate) ?? now);
	}

	if (notificationType === "REFUND" || notificationType === "REVOKE") {
		return optionalDateFromMillis(transaction.revocationDate) ?? now;
	}

	return optionalDateFromMillis(transaction.revocationDate);
}

function deriveInvalidationReason(
	notificationType: string | null,
	transaction: AppleDecodedTransactionPayload,
	storeKitStatus: number | null,
): string | null {
	if (notificationType === "REFUND_REVERSED") {
		return null;
	}

	if (storeKitStatus === 5) {
		return "revocation";
	}

	if (notificationType === "REFUND") {
		return "refund";
	}

	if (notificationType === "REVOKE") {
		return "revoke";
	}

	return transaction.revocationDate === undefined ? null : "revocation";
}

function normalizeAutoRenew(renewalInfo: AppleDecodedRenewalInfoPayload | null): boolean | null {
	if (renewalInfo?.autoRenewStatus === undefined) {
		return null;
	}

	return renewalInfo.autoRenewStatus === 1 || renewalInfo.autoRenewStatus === true;
}

function appleNotificationHandling(
	notification: AppleDecodedNotificationPayload,
): AppleNotificationHandling & { subtype: string | null } {
	const handling = appleNotificationHandlingByType[notification.notificationType];
	if (handling === undefined) {
		throw new Error(`Unsupported Apple notification type: ${notification.notificationType}`);
	}

	const subtype = notification.subtype ?? null;
	if (!handling.allowedSubtypes.includes(subtype)) {
		const subtypeLabel = subtype === null ? "empty" : subtype;
		throw new Error(
			`Unsupported Apple notification subtype ${subtypeLabel} for ${notification.notificationType}`,
		);
	}

	return { ...handling, subtype };
}

function requireString(value: string | undefined, label: string): string {
	if (value === undefined || value.trim() === "") {
		throw new Error(`${label} is required`);
	}

	return value;
}

function dateFromMillis(value: number | undefined, label: string): Date {
	if (value === undefined) {
		throw new Error(`${label} is required`);
	}

	return new Date(value);
}

function optionalDateFromMillis(value: number | undefined): Date | null {
	return value === undefined ? null : new Date(value);
}
