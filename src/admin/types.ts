import type {
	BillingChannel,
	BillingProvider,
	ProductType,
	ProjectionPayload,
	ProjectionSyncReason,
	ProjectionSyncStatus,
	PurchaseStatus,
	StoreEventProcessingStatus,
	SubscriptionStatus,
} from "../billing/types";
import type { ProjectInstanceContext } from "../projects/context";

export interface AdminPagination {
	limit: number;
	cursor: string | null;
}

export interface AdminCursor {
	createdAt: string;
	id: string;
}

export interface AdminListResult<T> {
	items: T[];
	nextCursor: string | null;
}

export interface AdminListMeta {
	nextCursor: string | null;
}

export interface AdminListResponse<T> {
	success: true;
	data: T[];
	pagination: AdminListMeta;
}

export interface AdminCustomer {
	id: string;
	projectKey: string;
	billingAccountId: string;
	email: string | null;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface AdminProviderCustomer {
	provider: BillingProvider;
	externalCustomerId: string;
	createdAt: string;
}

export interface AdminEntitlementSnapshotItem {
	key: string;
	active: boolean;
	expiresAt: string | null;
	metadata: Record<string, unknown>;
}

export type AdminEntitlement = AdminEntitlementSnapshotItem;

export interface AdminEntitlementSnapshot {
	billingAccountId: string;
	entitlements: AdminEntitlementSnapshotItem[];
	generatedAt: string;
}

export interface AdminPurchase {
	id: string;
	customerId: string;
	billingAccountId: string;
	provider: BillingProvider;
	channel: BillingChannel;
	purchaseKind: ProductType;
	status: PurchaseStatus;
	transactionId: string;
	originalTransactionId: string | null;
	productKey: string;
	entitlementKey: string;
	externalProductId: string;
	externalPriceId: string | null;
	purchasedAt: string;
	invalidatedAt: string | null;
	invalidationReason: string | null;
	createdAt: string;
}

export interface AdminSubscription {
	id: string;
	customerId: string;
	billingAccountId: string;
	provider: BillingProvider;
	channel: BillingChannel;
	status: SubscriptionStatus;
	externalSubscriptionId: string;
	externalProductId: string;
	externalPriceId: string | null;
	productKey: string;
	entitlementKey: string;
	startsAt: string;
	expiresAt: string | null;
	autoRenew: boolean;
	latestTransactionId: string | null;
	providerReconciliationAttempts: number;
	providerReconciliationError: string | null;
	providerReconciliationNextAttemptAt: string | null;
	providerReconciledAt: string | null;
	needsAttention: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface AdminStoreEvent {
	id: string;
	provider: BillingProvider;
	channel: BillingChannel;
	externalEventId: string | null;
	eventType: string;
	customerId: string | null;
	billingAccountId: string | null;
	storeProductId: string | null;
	transactionId: string | null;
	purchaseKind: ProductType | null;
	// The "processing" status is used by the replay worker while it owns a lock.
	processingStatus: StoreEventProcessingStatus;
	processingError: string | null;
	attempts: number;
	nextAttemptAt: string | null;
	processedAt: string | null;
	createdAt: string;
	updatedAt: string;
	rawPayload?: Record<string, unknown>;
}

export interface AdminProjectionJob {
	// Client-facing /projection-jobs routes map to the projection_sync_jobs table.
	id: string;
	customerId: string;
	billingAccountId: string;
	idempotencyKey: string;
	reason: ProjectionSyncReason;
	status: ProjectionSyncStatus;
	attempts: number;
	lastError: string | null;
	nextAttemptAt: string | null;
	lockedAt: string | null;
	lockedBy: string | null;
	payload: ProjectionPayload | null;
	createdAt: string;
	updatedAt: string;
}

export interface AdminCatalogProduct {
	id: string;
	key: string;
	entitlementKey: string;
	creditAmount: number;
	name: string | null;
	description: string | null;
	type: ProductType;
	active: boolean;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface AdminCatalogStoreProductPrice {
	externalPriceId: string | null;
	billingPeriod: string;
	currency: string | null;
	priceAmount: number | null;
}

export interface AdminCatalogStoreProduct extends AdminCatalogStoreProductPrice {
	id: string;
	productId: string;
	productKey: string;
	provider: BillingProvider;
	channel: BillingChannel;
	externalProductId: string;
	active: boolean;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface AdminCustomerDetail {
	customer: AdminCustomer;
	entitlementSnapshot: AdminEntitlementSnapshot;
	providerCustomers: AdminProviderCustomer[];
	activeSubscriptions: AdminSubscription[];
	recentPurchases: AdminPurchase[];
	recentStoreEvents: AdminStoreEvent[];
	recentProjectionJobs: AdminProjectionJob[];
}

export interface AdminCustomerSearchResult {
	customer: AdminCustomer;
	matchType:
		| "billing_account_id"
		| "customer_id"
		| "provider_customer"
		| "transaction_id"
		| "original_transaction_id"
		| "order_id"
		| "entitlement_key";
	matchedValue: string;
}

export interface AdminBillingReader {
	getCustomerByBillingAccountId(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<AdminCustomerDetail>;
	getCustomerById(
		project: ProjectInstanceContext,
		customerId: string,
	): Promise<AdminCustomerDetail>;
	searchCustomers(
		project: ProjectInstanceContext,
		input: AdminCustomerSearchInput,
	): Promise<AdminListResult<AdminCustomerSearchResult>>;
	listPurchases(
		project: ProjectInstanceContext,
		input: AdminPurchaseListInput,
	): Promise<AdminListResult<AdminPurchase>>;
	listSubscriptions(
		project: ProjectInstanceContext,
		input: AdminSubscriptionListInput,
	): Promise<AdminListResult<AdminSubscription>>;
	listStoreEvents(
		project: ProjectInstanceContext,
		input: AdminStoreEventListInput,
	): Promise<AdminListResult<AdminStoreEvent>>;
	getStoreEvent(
		project: ProjectInstanceContext,
		input: AdminStoreEventDetailInput,
	): Promise<AdminStoreEvent>;
	listProjectionJobs(
		project: ProjectInstanceContext,
		input: AdminProjectionJobListInput,
	): Promise<AdminListResult<AdminProjectionJob>>;
	listCatalogProducts(
		project: ProjectInstanceContext,
		input: AdminCatalogProductListInput,
	): Promise<AdminListResult<AdminCatalogProduct>>;
	listCatalogStoreProducts(
		project: ProjectInstanceContext,
		input: AdminCatalogStoreProductListInput,
	): Promise<AdminListResult<AdminCatalogStoreProduct>>;
	getStatsSummary(
		project: ProjectInstanceContext,
		input: AdminStatsSummaryInput,
	): Promise<AdminStatsSummary>;
}

export interface AdminStatsSummaryInput {
	provider?: BillingProvider;
	channel?: BillingChannel;
	from?: string;
	to?: string;
}

export interface AdminStatsSummary {
	storeEvents: Record<StoreEventProcessingStatus, number>;
	projectionJobs: Record<ProjectionSyncStatus, number>;
	subscriptions: {
		active: number;
		gracePeriod: number;
		needsAttention: number;
	};
	providers: Partial<Record<BillingProvider, { lastEventAt: string | null }>>;
	recentStoreEvents: AdminStoreEvent[];
}

export interface AdminCustomerSearchInput extends AdminPagination {
	query: string;
}

export interface AdminCommonListInput extends AdminPagination {
	provider?: BillingProvider;
	channel?: BillingChannel;
	billingAccountId?: string;
	customerId?: string;
	productKey?: string;
	entitlementKey?: string;
	from?: string;
	to?: string;
}

export interface AdminPurchaseListInput extends AdminCommonListInput {
	purchaseKind?: ProductType;
	status?: PurchaseStatus;
	transactionId?: string;
	orderId?: string;
}

export interface AdminSubscriptionListInput extends AdminCommonListInput {
	status?: SubscriptionStatus;
	needsAttention?: boolean;
	staleBefore?: string;
}

export interface AdminStoreEventListInput extends AdminCommonListInput {
	processingStatus?: StoreEventProcessingStatus;
	eventType?: string;
	externalEventId?: string;
}

export interface AdminStoreEventDetailInput {
	eventId: string;
	includeRawPayload: boolean;
}

export interface AdminProjectionJobListInput extends AdminCommonListInput {
	status?: ProjectionSyncStatus;
	reason?: ProjectionSyncReason;
}

export type AdminCatalogProductListInput = AdminPagination;

export interface AdminCatalogStoreProductListInput extends AdminPagination {
	provider?: BillingProvider;
	channel?: BillingChannel;
	productKey?: string;
}
