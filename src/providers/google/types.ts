import type {
	BillingChannel,
	BillingProvider,
	EntitlementSnapshot,
	ProductType,
	ProjectionSyncReason,
	PurchaseStatus,
	SubscriptionStatus,
} from "../../billing/types";

export interface GoogleAccountLink {
	obfuscatedAccountId: string;
}

export interface GoogleVerifyPurchaseInput {
	billingAccountId: string;
	purchaseKind: "subscription" | "consumable" | "non_consumable";
	purchaseToken: string;
	productId?: string;
}

export interface GooglePubSubPushEnvelope {
	message: {
		data: string;
		messageId: string;
		attributes?: Record<string, string>;
	};
	subscription: string;
}

export interface GoogleWebhookResult {
	processed: boolean;
	eventType: string;
	messageId: string;
	entitlements?: EntitlementSnapshot | null;
}

export interface GoogleDeveloperNotification {
	version: string;
	packageName: string;
	eventTimeMillis: string;
	subscriptionNotification?: {
		version: string;
		notificationType: number;
		purchaseToken: string;
	};
	oneTimeProductNotification?: {
		version: string;
		notificationType: number;
		purchaseToken: string;
		sku: string;
	};
	voidedPurchaseNotification?: {
		purchaseToken: string;
		orderId?: string;
		productType: number;
		refundType: number;
	};
	testNotification?: {
		version: string;
	};
}

export interface VerifiedGoogleRtdn {
	messageId: string;
	externalEventId: string;
	notification: GoogleDeveloperNotification;
}

export interface NormalizedGooglePurchase {
	billingAccountId: string | null;
	obfuscatedAccountId: string | null;
	externalProductId: string;
	externalPriceId: string | null;
	purchaseKind: ProductType;
	purchaseToken: string;
	linkedPurchaseToken: string | null;
	orderId: string | null;
	purchaseStatus: PurchaseStatus;
	subscriptionStatus: SubscriptionStatus | null;
	purchasedAt: Date;
	expiresAt: Date | null;
	autoRenew: boolean | null;
	acknowledgementState: string | null;
	consumptionState: string | null;
	quantity: number;
	refundableQuantity: number | null;
	invalidatedAt: Date | null;
	invalidationReason: string | null;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string | null;
	projectionReason: Extract<
		ProjectionSyncReason,
		"purchase_verified" | "provider_webhook" | "provider_reconciliation"
	>;
	projectionIdempotencyKey: string;
	requiresAcknowledgement: boolean;
	requiresConsumption: boolean;
}

export interface GoogleProjectionPurchaseContext {
	provider: BillingProvider;
	channel: BillingChannel;
	purchaseKind: ProductType;
	transactionId: string;
	productKey: string;
	creditAmount: number;
	quantity?: number;
	refundableQuantity?: number;
	purchasedAt: string;
}
