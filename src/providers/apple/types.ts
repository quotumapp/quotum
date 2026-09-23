import type {
	EntitlementSnapshot,
	ProjectionSyncReason,
	PurchaseKind,
	PurchaseStatus,
	SubscriptionStatus,
} from "../../billing/types";

export type AppleEnvironmentName = "sandbox" | "production";
export type AppleSignedEnvironment = "Sandbox" | "Production" | "sandbox" | "production";

export interface AppleVerifyPurchaseInput {
	billingAccountId: string;
	transactionId: string;
}

export interface AppleWebhookInput {
	signedPayload: string;
}

export interface AppleWebhookResult {
	status: "processed" | "skipped" | "ignored";
	entitlements: EntitlementSnapshot | null;
}

export interface AppleDecodedTransactionPayload {
	appAccountToken?: string;
	bundleId?: string;
	environment?: AppleSignedEnvironment;
	productId?: string;
	type?: string;
	transactionId?: string;
	originalTransactionId?: string;
	webOrderLineItemId?: string;
	purchaseDate?: number;
	expiresDate?: number;
	revocationDate?: number;
	revocationReason?: number;
	/** 1 introductory, 2 promotional, 3 offer code, 4 win-back. */
	offerType?: number;
	/** FREE_TRIAL, PAY_AS_YOU_GO, PAY_UP_FRONT or ONE_TIME. */
	offerDiscountType?: string;
	offerIdentifier?: string;
	/** ISO 8601 duration of the offer, such as P1W. */
	offerPeriod?: string;
}

export interface AppleDecodedRenewalInfoPayload {
	appAccountToken?: string;
	autoRenewStatus?: number | boolean;
	isInBillingRetryPeriod?: boolean;
	gracePeriodExpiresDate?: number;
	autoRenewProductId?: string;
	environment?: AppleSignedEnvironment;
}

export interface AppleDecodedNotificationPayload {
	signedDate?: number;
	notificationType: string;
	subtype?: string;
	notificationUUID: string;
	data?: {
		bundleId?: string;
		environment?: AppleSignedEnvironment;
		status?: number;
	};
}

export interface NormalizedStoreKitTransaction {
	billingAccountId: string | null;
	appAccountToken: string | null;
	externalProductId: string;
	purchaseKind: PurchaseKind;
	transactionId: string;
	originalTransactionId: string | null;
	webOrderLineItemId: string | null;
	purchaseStatus: PurchaseStatus;
	subscriptionStatus: SubscriptionStatus | null;
	purchasedAt: Date;
	expiresAt: Date | null;
	/** Bounds of a free-trial transaction; both null for any other transaction. */
	trialStart: Date | null;
	trialEnd: Date | null;
	autoRenew: boolean | null;
	invalidatedAt: Date | null;
	invalidationReason: string | null;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string | null;
	projectionReason: ProjectionSyncReason;
	projectionIdempotencyKey: string;
}
