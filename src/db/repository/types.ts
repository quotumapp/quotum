import type { SQL as DrizzleSQL } from "drizzle-orm";
import type {
	BillingChannel,
	BillingProvider,
	EntitlementSnapshot,
	ProjectionContract,
	ProjectionJobPayload,
	ProjectionSyncReason,
	ProjectionSyncStatus,
	PurchaseKind,
	PurchaseStatus,
	StoreEventProcessingStatus,
	SubscriptionStatus,
} from "../../billing/types";

export interface BillingProjectRecord {
	id: string;
	key: string;
	name: string;
	active: boolean;
}

export interface BillingProjectRow {
	id: string;
	key: string;
	name: string;
	active: boolean;
}

export interface ProjectionSyncJobRow {
	id: string;
	project_id: string;
	project_key: string;
	customer_id: string;
	idempotency_key: string;
	reason: ProjectionSyncReason;
	payload: ProjectionJobPayload;
	status: ProjectionSyncStatus;
	attempts: number;
	last_error: string | null;
	reprojection_requested: boolean;
	next_attempt_at: string | null;
	locked_at: string | null;
	locked_by: string | null;
	created_at: string;
	updated_at: string;
}

export interface StoreEventReplayJobRow {
	id: string;
	project_id: string;
	project_key: string;
	provider: BillingProvider;
	channel: BillingChannel;
	external_event_id: string | null;
	event_fingerprint?: string | null;
	event_type: string;
	customer_id: string | null;
	store_product_id: string | null;
	transaction_id: string | null;
	purchase_kind: PurchaseKind | null;
	processing_status: StoreEventProcessingStatus;
	processing_error: string | null;
	attempts: number;
	next_attempt_at: string | null;
	raw_payload: Record<string, unknown>;
	processed_at: string | null;
	locked_at: string | null;
	locked_by: string | null;
	created_at: string;
	updated_at: string;
}

export interface ProviderSubscriptionReconciliationRow {
	id: string;
	project_id: string;
	project_key: string;
	provider: BillingProvider;
	channel: BillingChannel;
	external_subscription_id: string;
	external_product_id: string;
	external_price_id: string | null;
	latest_transaction_id: string | null;
	status: SubscriptionStatus;
	expires_at: string | null;
	provider_reconciliation_attempts: number;
}

export interface ExpiredSubscriptionReconciliationResult {
	expiredSubscriptions: number;
	affectedCustomers: number;
	projectionJobs: number;
}

export interface RecordPurchaseProjectionInput {
	billingAccountId: string;
	provider: BillingProvider;
	channel: BillingChannel;
	storeProductId: string;
	purchaseKind: PurchaseKind;
	transactionId: string;
	originalTransactionId: string | null;
	status: PurchaseStatus;
	purchasedAt: Date;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string | null;
	projectionReason: ProjectionSyncReason;
	projectionIdempotencyKey: string;
	replayStoreEventId?: string;
}

export interface RecordStoreKitTransactionProjectionInput {
	billingAccountId: string | null;
	appAccountToken: string | null;
	channel: BillingChannel;
	externalProductId: string;
	purchaseKind: PurchaseKind;
	transactionId: string;
	originalTransactionId: string | null;
	webOrderLineItemId: string | null;
	purchaseStatus: PurchaseStatus;
	subscriptionStatus: SubscriptionStatus | null;
	purchasedAt: Date;
	expiresAt: Date | null;
	autoRenew: boolean | null;
	invalidatedAt: Date | null;
	invalidationReason: string | null;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string | null;
	projectionReason: ProjectionSyncReason;
	projectionIdempotencyKey: string;
	replayStoreEventId?: string;
}

export interface RecordGooglePurchaseProjectionInput {
	billingAccountId: string | null;
	obfuscatedAccountId: string | null;
	externalProductId: string;
	externalPriceId: string | null;
	purchaseKind: PurchaseKind;
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
	projectionReason: ProjectionSyncReason;
	projectionIdempotencyKey: string;
	replayStoreEventId?: string;
}

export interface RecordGoogleVoidedPurchaseProjectionInput {
	purchaseToken: string;
	orderId: string | null;
	refundType: 1 | 2;
	quantity: number | null;
	refundableQuantity: number | null;
	eventTime: Date;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string;
	projectionReason: Extract<ProjectionSyncReason, "provider_webhook">;
	projectionIdempotencyKey: string;
	replayStoreEventId?: string;
}

export interface StripeWebStoreProductRow {
	storeProductId: string;
	productId: string;
	productKey: string;
	productType: PurchaseKind;
	creditAmount: number;
	externalProductId: string;
	externalPriceId: string;
	billingPeriod: string;
	currency: string | null;
	priceAmount: number | null;
	productName?: string | null;
	productDescription?: string | null;
	plan?: string | null;
}

export interface StripeCatalog {
	schemaVersion: 1;
	plans: Array<{
		key: string;
		name: string;
		version: number;
		kind: "base" | "addon";
		tierRank: number;
		trialDays: number | null;
		trialRequiresPaymentMethod: boolean;
		trialEndBehavior: "cancel" | "pause";
		upgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
		downgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
		components: Array<{
			key: string;
			kind: "base" | "licensed" | "metered_overage";
			featureKey: string | null;
			featureUnit: string | null;
			includedQuantity: string | null;
			currency: string;
			unitAmountMinor: number;
			pricingModel: "flat" | "graduated" | "volume";
			tiers: Array<{
				upToQuantity: string | null;
				unitAmountMinor: number;
				flatAmountMinor: number;
			}>;
			billingUnits: string;
			interval: "month" | "year";
			minimumQuantity: number;
			maximumQuantity: number | null;
			taxBehavior: "inclusive" | "exclusive" | "unspecified";
		}>;
	}>;
	oneTimePurchases: Array<{
		key: string;
		name: string;
		kind: "topup" | "one_time";
		currency: string;
		amountMinor: number;
		credits: number;
	}>;
}

export interface StripeBillingAccountSummary {
	schemaVersion: 1;
	customerExists: boolean;
	subscriptions: Array<{
		id: string;
		plan: string;
		status: "trialing" | "active" | "past_due" | "unpaid" | "cancelled";
		currentPeriodStart: string | null;
		currentPeriodEnd: string | null;
		cancelAtPeriodEnd: boolean;
	}>;
	recentInvoices: Array<{
		id: string;
		status: "draft" | "open" | "paid" | "uncollectible" | "void" | "unknown";
		amountPaidCents: number;
		currency: string;
		paidAt: string | null;
		createdAt: string;
	}>;
}

export interface PrepareStripeCheckoutRequestInput {
	billingAccountId: string;
	storeProductId: string | null;
	planVersionId?: string | null;
	requestedQuantities?: Record<string, number>;
	idempotencyKey: string;
	requestHash: string;
}

export interface StripeRecurringCheckoutPlan {
	planVersionId: string;
	planKey: string;
	name: string;
	kind: "base" | "addon";
	trialDays: number | null;
	trialRequiresPaymentMethod: boolean;
	trialEndBehavior: "cancel" | "pause";
	components: Array<{
		priceComponentId: string;
		priceKey: string;
		componentKind: "base" | "licensed" | "metered_overage";
		featureKey: string | null;
		externalProductId: string;
		externalPriceId: string;
		defaultQuantity: number;
		minimumQuantity: number;
		maximumQuantity: number | null;
		unitAmountMinor: number;
		pricingModel: "flat" | "graduated" | "volume";
		currency: string;
		billingInterval: "month" | "year";
	}>;
}

export interface StripeCheckoutRequestState {
	status: "creating" | "created";
	externalSessionId: string | null;
	sessionUrl: string | null;
}

export interface CompleteStripeCheckoutRequestInput {
	billingAccountId: string;
	idempotencyKey: string;
	requestHash: string;
	externalSessionId: string;
	sessionUrl: string;
}

export interface LinkStripeProviderCustomerInput {
	billingAccountId: string;
	stripeCustomerId: string;
	email: string | null;
}

export interface GetStripeProviderCustomerInput {
	billingAccountId: string;
	email: string | null;
}

export interface RecordStripeCreditPurchaseProjectionInput {
	purchaseKind: "consumable" | "non_consumable";
	billingAccountId: string | null;
	stripeCustomerId: string | null;
	externalProductId: string;
	externalPriceId: string;
	paymentIntentId: string;
	chargeId: string | null;
	checkoutSessionId?: string | null;
	amountPaidCents?: number | null;
	currency?: string | null;
	purchasedAt: Date;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string;
	projectionIdempotencyKey: string;
	projectionContract?: ProjectionContract;
	replayStoreEventId?: string;
}

export interface RecordStripeSubscriptionProjectionInput {
	billingAccountId: string | null;
	stripeCustomerId: string | null;
	stripeSubscriptionId: string;
	invoiceId: string | null;
	providerObjectIds?: string[];
	externalProductId: string;
	externalPriceId: string;
	items?: Array<{
		providerSubscriptionItemId: string;
		externalProductId: string;
		externalPriceId: string;
		quantity: number;
	}>;
	subscriptionStatus: SubscriptionStatus;
	providerStatus?: string;
	purchasedAt: Date;
	startsAt: Date | null;
	expiresAt: Date | null;
	currentPeriodStart?: Date | null;
	currentPeriodEnd?: Date | null;
	trialStart?: Date | null;
	trialEnd?: Date | null;
	cancelAtPeriodEnd?: boolean;
	providerEventCreated?: number;
	invoiceStatus?: string | null;
	invoiceAmountPaid?: number | null;
	invoiceCurrency?: string | null;
	invoicePaidAt?: Date | null;
	autoRenew: boolean | null;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string | null;
	projectionReason: Extract<ProjectionSyncReason, "provider_webhook" | "provider_reconciliation">;
	projectionIdempotencyKey: string;
	projectionContract?: ProjectionContract;
	replayStoreEventId?: string;
}

export interface RecordStripeCreditReversalProjectionInput {
	reversalReason: "refund" | "dispute";
	reversalId: string;
	reversalAmount: number;
	reversalCurrency: string;
	paymentIntentId: string;
	chargeId: string | null;
	reversedAt: Date;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string;
	projectionIdempotencyKey: string;
	projectionContract?: ProjectionContract;
	replayStoreEventId?: string;
}

export interface RecordStripeSkippedEventInput {
	eventType: string;
	externalEventId: string | null;
	transactionId: string | null;
	purchaseKind: PurchaseKind | null;
	processingError: string;
	rawPayload: Record<string, unknown>;
	replayStoreEventId?: string;
}

export interface StoreKitRecordingResult {
	processingStatus: "processed" | "skipped";
	billingAccountId: string | null;
	entitlements: EntitlementSnapshot | null;
}

export interface GooglePlayRecordingResult {
	processingStatus: "processed" | "skipped";
	billingAccountId: string | null;
	entitlements: EntitlementSnapshot | null;
}

export interface StripeRecordingResult {
	processingStatus: "processed" | "skipped" | "ignored";
	billingAccountId: string | null;
	entitlements: EntitlementSnapshot | null;
}

export interface QueryExecutor {
	execute<T = Record<string, unknown>>(query: DrizzleSQL): Promise<T[]>;
}

export interface TransactionalQueryExecutor extends QueryExecutor {
	transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}

export interface CustomerIdentityRow {
	id: string;
	billing_account_id: string;
}

export interface StoreProductIdentityRow {
	id: string;
	product_id: string;
	product_key: string;
	product_type: PurchaseKind;
	credit_amount: number;
}

export interface StoreEventProcessingResult {
	storeEventId: string | null;
	applied: boolean;
}

export interface StripeCreditReversalTargetRow {
	purchase_id: string;
	customer_id: string;
	billing_account_id: string;
	store_product_id: string;
	product_key: string;
	purchase_kind: "consumable" | "non_consumable";
	credit_amount: number;
	price_amount: number | string | null;
	currency: string | null;
	reversed_amount: number | string | null;
	reversed_credit_amount: number | string | null;
}
