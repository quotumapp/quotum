import type {
	AutoTopupChargeSucceeded,
	AutoTopupFailureResult,
	AutoTopupJob,
} from "../billing/auto-topup";
import type {
	CommercialActionExecutionResult,
	CommercialActionPreview,
	CommercialPreviewDraft,
	StoredCommercialActionPreview,
} from "../billing/commercial";
import type {
	CustomerBillingSummary,
	UsageEventListInput,
	UsageEventPage,
	UsageSeriesInput,
	UsageSeriesPoint,
} from "../billing/insights";
import type {
	ConfirmReservationInput,
	ConsumeUsageResult,
	CorrectUsageInput,
	FinalizeReservationResult,
	MeteringBalance,
	MeteringDecision,
	MeteringMutationInput,
	MeteringSubjectInput,
	ReleaseReservationInput,
	ReservationResult,
	ReserveUsageInput,
	UsageCorrectionResult,
	WorkerConsumeUsageResult,
	WorkerMeteringMutationInput,
} from "../billing/metering";
import type {
	SubscriptionChangeInput,
	SubscriptionChangeOperation,
	SubscriptionChangePreview,
	UsageInvoiceJob,
} from "../billing/recurring";
import type { BillingProvider, EntitlementSnapshot } from "../billing/types";
import { CatalogControlPlane } from "../catalog/control-plane";
import type {
	CatalogPreview,
	CatalogPreviewInput,
	CatalogPublishInput,
	CatalogPublishResult,
	PublishedCatalog,
} from "../catalog/types";
import type { ProjectInstanceContext } from "../projects/context";
import type { StripeCatalog } from "../providers/stripe/types";
import { db as defaultDb } from "./client";
import { AppleBillingRepository } from "./repository/apple";
import { AutoTopupJobRepository } from "./repository/auto-topup-jobs";
import { CommercialActionRepository } from "./repository/commercial-actions";
import { ControlsEnterpriseRepository } from "./repository/controls-enterprise";
import { CoreBillingRepository } from "./repository/core";
import { GoogleBillingRepository } from "./repository/google";
import { BillingInsightsRepository } from "./repository/insights";
import { type GrantAllocationInput, MeteringBillingRepository } from "./repository/metering";
import { ProjectScopedBillingRepository } from "./repository/project-scoped";
import { ProjectionJobBillingRepository } from "./repository/projection-jobs";
import { RecurringPricingRepository } from "./repository/recurring-pricing";
import { StoreEventReplayBillingRepository } from "./repository/store-event-replay";
import { StripeBillingRepository } from "./repository/stripe";
import { SubscriptionReconciliationBillingRepository } from "./repository/subscription-reconciliation";
import type {
	CompleteStripeCheckoutRequestInput,
	ExpiredSubscriptionReconciliationResult,
	GetStripeProviderCustomerInput,
	GooglePlayRecordingResult,
	LinkStripeProviderCustomerInput,
	PrepareStripeCheckoutRequestInput,
	ProjectionSyncJobRow,
	ProviderSubscriptionReconciliationRow,
	RecordGooglePurchaseProjectionInput,
	RecordGoogleVoidedPurchaseProjectionInput,
	RecordPurchaseProjectionInput,
	RecordStoreKitTransactionProjectionInput,
	RecordStripeCreditPurchaseProjectionInput,
	RecordStripeCreditReversalProjectionInput,
	RecordStripeSkippedEventInput,
	RecordStripeSubscriptionProjectionInput,
	StoreEventReplayJobRow,
	StoreKitRecordingResult,
	StripeBillingAccountSummary,
	StripeCheckoutRequestState,
	StripeRecordingResult,
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
	TransactionalQueryExecutor,
} from "./repository/types";

export type { GrantAllocationInput } from "./repository/metering";
export { ProjectScopedBillingRepository } from "./repository/project-scoped";
export type {
	CompleteStripeCheckoutRequestInput,
	ExpiredSubscriptionReconciliationResult,
	GetStripeProviderCustomerInput,
	GooglePlayRecordingResult,
	LinkStripeProviderCustomerInput,
	PrepareStripeCheckoutRequestInput,
	ProjectionSyncJobRow,
	ProviderSubscriptionReconciliationRow,
	RecordGooglePurchaseProjectionInput,
	RecordGoogleVoidedPurchaseProjectionInput,
	RecordPurchaseProjectionInput,
	RecordStoreKitTransactionProjectionInput,
	RecordStripeCreditPurchaseProjectionInput,
	RecordStripeCreditReversalProjectionInput,
	RecordStripeSkippedEventInput,
	RecordStripeSubscriptionProjectionInput,
	StoreEventReplayJobRow,
	StoreKitRecordingResult,
	StripeBillingAccountSummary,
	StripeCheckoutRequestState,
	StripeRecordingResult,
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
} from "./repository/types";

export class BillingRepository {
	private readonly core: CoreBillingRepository;
	private readonly projectionJobs: ProjectionJobBillingRepository;
	private readonly storeEventReplay: StoreEventReplayBillingRepository;
	private readonly subscriptionReconciliation: SubscriptionReconciliationBillingRepository;
	private readonly apple: AppleBillingRepository;
	private readonly autoTopupJobs: AutoTopupJobRepository;
	private readonly commercialActions: CommercialActionRepository;
	private readonly google: GoogleBillingRepository;
	private readonly insights: BillingInsightsRepository;
	private readonly stripe: StripeBillingRepository;
	private readonly recurringPricing: RecurringPricingRepository;
	private readonly metering: MeteringBillingRepository;
	private readonly catalog: CatalogControlPlane;
	readonly controlsEnterprise: ControlsEnterpriseRepository;

	constructor(
		database: TransactionalQueryExecutor = defaultDb as unknown as TransactionalQueryExecutor,
	) {
		this.core = new CoreBillingRepository(database);
		this.projectionJobs = new ProjectionJobBillingRepository(database);
		this.storeEventReplay = new StoreEventReplayBillingRepository(database);
		this.subscriptionReconciliation = new SubscriptionReconciliationBillingRepository(database);
		this.apple = new AppleBillingRepository(database);
		this.autoTopupJobs = new AutoTopupJobRepository(database);
		this.commercialActions = new CommercialActionRepository(database);
		this.google = new GoogleBillingRepository(database);
		this.insights = new BillingInsightsRepository(database);
		this.stripe = new StripeBillingRepository(database);
		this.recurringPricing = new RecurringPricingRepository(database);
		this.metering = new MeteringBillingRepository(database);
		this.catalog = new CatalogControlPlane(database);
		this.controlsEnterprise = new ControlsEnterpriseRepository(database);
	}

	async claimAutoTopupJobs(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<AutoTopupJob[]> {
		return await this.autoTopupJobs.claimAutoTopupJobs(workerId, limit, staleBefore);
	}

	async markAutoTopupSucceeded(
		projectId: string,
		jobId: string,
		workerId: string,
		charge: AutoTopupChargeSucceeded,
	): Promise<{ circuitOpened: boolean }> {
		return await this.autoTopupJobs.markAutoTopupSucceeded(projectId, jobId, workerId, charge);
	}

	async markAutoTopupFailed(
		projectId: string,
		jobId: string,
		workerId: string,
		input: {
			kind: "retryable" | "action_required" | "safety_limit_exceeded";
			error: string;
			nextAttemptAt: Date | null;
			externalInvoiceId?: string | null;
			externalPaymentId?: string | null;
		},
	): Promise<AutoTopupFailureResult> {
		return await this.autoTopupJobs.markAutoTopupFailed(projectId, jobId, workerId, input);
	}

	forProject(project: ProjectInstanceContext): ProjectScopedBillingRepository {
		return new ProjectScopedBillingRepository(this, project);
	}

	async getEntitlementSnapshot(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<EntitlementSnapshot> {
		return await this.core.getEntitlementSnapshot(project, billingAccountId);
	}

	async recomputeCustomerEntitlements(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<EntitlementSnapshot> {
		return await this.core.recomputeCustomerEntitlements(project, billingAccountId);
	}

	async claimProjectionSyncJobs(workerId: string, limit: number): Promise<ProjectionSyncJobRow[]> {
		return await this.projectionJobs.claimProjectionSyncJobs(workerId, limit);
	}

	async markProjectionSyncJobSucceeded(
		projectId: string,
		jobId: string,
		workerId: string,
	): Promise<void> {
		await this.projectionJobs.markProjectionSyncJobSucceeded(projectId, jobId, workerId);
	}

	async markProjectionSyncJobFailed(
		projectId: string,
		jobId: string,
		lastError: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		await this.projectionJobs.markProjectionSyncJobFailed(
			projectId,
			jobId,
			lastError,
			nextAttemptAt,
			workerId,
		);
	}

	async retryProjectionSyncJob(
		project: ProjectInstanceContext,
		jobId: string,
	): Promise<{ jobId: string; status: "pending" }> {
		return await this.projectionJobs.retryProjectionSyncJob(project, jobId);
	}

	async claimStoreEventReplayJobs(
		workerId: string,
		limit: number,
	): Promise<StoreEventReplayJobRow[]> {
		return await this.storeEventReplay.claimStoreEventReplayJobs(workerId, limit);
	}

	async claimStoreEventReplayJobById(
		workerId: string,
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<StoreEventReplayJobRow> {
		return await this.storeEventReplay.claimStoreEventReplayJobById(workerId, project, eventId);
	}

	async markStoreEventReplayJobSucceeded(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void> {
		await this.storeEventReplay.markStoreEventReplayJobSucceeded(projectId, eventId, workerId);
	}

	async renewStoreEventReplayJobLease(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void> {
		await this.storeEventReplay.renewStoreEventReplayJobLease(projectId, eventId, workerId);
	}

	async markStoreEventReplayJobFailed(
		projectId: string,
		eventId: string,
		errorMessage: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		await this.storeEventReplay.markStoreEventReplayJobFailed(
			projectId,
			eventId,
			errorMessage,
			nextAttemptAt,
			workerId,
		);
	}

	async reconcileExpiredSubscriptions(
		limit: number,
	): Promise<ExpiredSubscriptionReconciliationResult> {
		return await this.subscriptionReconciliation.reconcileExpiredSubscriptions(limit);
	}

	async claimProviderSubscriptionReconciliations(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<ProviderSubscriptionReconciliationRow[]> {
		return await this.subscriptionReconciliation.claimProviderSubscriptionReconciliations(
			workerId,
			limit,
			staleBefore,
		);
	}

	async markProviderSubscriptionReconciliationSucceeded(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void> {
		await this.subscriptionReconciliation.markProviderSubscriptionReconciliationSucceeded(
			projectId,
			subscriptionId,
			workerId,
		);
	}

	async renewProviderSubscriptionReconciliationLease(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void> {
		await this.subscriptionReconciliation.renewProviderSubscriptionReconciliationLease(
			projectId,
			subscriptionId,
			workerId,
		);
	}

	async markProviderSubscriptionReconciliationFailed(
		projectId: string,
		subscriptionId: string,
		errorMessage: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		await this.subscriptionReconciliation.markProviderSubscriptionReconciliationFailed(
			projectId,
			subscriptionId,
			errorMessage,
			nextAttemptAt,
			workerId,
		);
	}

	async recordPurchaseAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordPurchaseProjectionInput,
	): Promise<EntitlementSnapshot> {
		return await this.core.recordPurchaseAndEnqueueProjection(project, input);
	}

	async getOrCreateProviderCustomerToken(
		project: ProjectInstanceContext,
		billingAccountId: string,
		provider: BillingProvider,
	): Promise<string> {
		return await this.core.getOrCreateProviderCustomerToken(project, billingAccountId, provider);
	}

	async getStripeWebStoreProductByKey(
		project: ProjectInstanceContext,
		productKey: string,
	): Promise<StripeWebStoreProductRow> {
		return await this.stripe.getStripeWebStoreProductByKey(project, productKey);
	}

	async getStripeRecurringCheckoutPlanByKey(
		project: ProjectInstanceContext,
		planKey: string,
		billingAccountId: string,
	): Promise<StripeRecurringCheckoutPlan> {
		return await this.stripe.getStripeRecurringCheckoutPlanByKey(
			project,
			planKey,
			billingAccountId,
		);
	}

	async hasActiveBasePlan(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<boolean> {
		return await this.stripe.hasActiveBasePlan(project, billingAccountId);
	}

	async prepareSubscriptionChange(
		project: ProjectInstanceContext,
		input: SubscriptionChangeInput,
	): Promise<SubscriptionChangeOperation> {
		return await this.recurringPricing.prepareSubscriptionChange(project, input);
	}

	async previewSubscriptionChange(
		project: ProjectInstanceContext,
		input: Omit<SubscriptionChangeInput, "idempotencyKey" | "expectedStateFingerprint">,
	): Promise<SubscriptionChangePreview> {
		return await this.recurringPricing.previewSubscriptionChange(project, input);
	}

	async createCommercialActionPreview(
		project: ProjectInstanceContext,
		draft: CommercialPreviewDraft,
	): Promise<CommercialActionPreview> {
		return await this.commercialActions.createCommercialActionPreview(project, draft);
	}

	async listUsageEvents(
		project: ProjectInstanceContext,
		input: UsageEventListInput,
	): Promise<UsageEventPage> {
		return await this.insights.listUsageEvents(project, input);
	}

	async getUsageSeries(
		project: ProjectInstanceContext,
		input: UsageSeriesInput,
	): Promise<UsageSeriesPoint[]> {
		return await this.insights.getUsageSeries(project, input);
	}

	async getCustomerBillingSummary(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<CustomerBillingSummary> {
		return await this.insights.getCustomerBillingSummary(project, billingAccountId);
	}

	async getCommercialActionPreview(
		project: ProjectInstanceContext,
		billingAccountId: string,
		previewToken: string,
	): Promise<StoredCommercialActionPreview> {
		return await this.commercialActions.getCommercialActionPreview(
			project,
			billingAccountId,
			previewToken,
		);
	}

	async beginCommercialActionExecution(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			previewToken: string;
			intentHash: string;
			stateFingerprint: string;
			idempotencyKey: string;
		},
	): Promise<StoredCommercialActionPreview> {
		return await this.commercialActions.beginCommercialActionExecution(project, input);
	}

	async completeCommercialActionExecution(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			previewToken: string;
			idempotencyKey: string;
			result: CommercialActionExecutionResult;
		},
	): Promise<CommercialActionExecutionResult> {
		return await this.commercialActions.completeCommercialActionExecution(project, input);
	}

	async claimSubscriptionChanges(
		workerId: string,
		limit: number,
	): Promise<SubscriptionChangeOperation[]> {
		return await this.recurringPricing.claimSubscriptionChanges(workerId, limit);
	}

	async markSubscriptionChangeApplied(
		projectInstanceId: string,
		changeId: string,
		providerRequestId: string,
		workerId: string,
	): Promise<void> {
		await this.recurringPricing.markSubscriptionChangeApplied(
			projectInstanceId,
			changeId,
			providerRequestId,
			workerId,
		);
	}

	async markSubscriptionChangeFailed(
		projectInstanceId: string,
		changeId: string,
		error: string,
		workerId: string,
	): Promise<void> {
		await this.recurringPricing.markSubscriptionChangeFailed(
			projectInstanceId,
			changeId,
			error,
			workerId,
		);
	}

	async materializeAndClaimUsageInvoicePeriods(
		workerId: string,
		limit: number,
	): Promise<{ materialized: number; jobs: UsageInvoiceJob[] }> {
		return await this.recurringPricing.materializeAndClaimUsageInvoicePeriods(workerId, limit);
	}

	async markUsageInvoiceSucceeded(
		projectInstanceId: string,
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		externalInvoiceId: string,
		workerId: string,
	): Promise<void> {
		await this.recurringPricing.markUsageInvoiceSucceeded(
			projectInstanceId,
			jobKind,
			jobId,
			externalInvoiceId,
			workerId,
		);
	}

	async markUsageInvoiceFailed(
		projectInstanceId: string,
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		error: string,
		workerId: string,
	): Promise<void> {
		await this.recurringPricing.markUsageInvoiceFailed(
			projectInstanceId,
			jobKind,
			jobId,
			error,
			workerId,
		);
	}

	async listStripeCatalog(project: ProjectInstanceContext): Promise<StripeCatalog> {
		return await this.stripe.listStripeCatalog(project);
	}

	async getStripeBillingAccountSummary(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<StripeBillingAccountSummary> {
		return await this.stripe.getStripeBillingAccountSummary(project, billingAccountId);
	}

	async prepareStripeCheckoutRequest(
		project: ProjectInstanceContext,
		input: PrepareStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState> {
		return await this.stripe.prepareStripeCheckoutRequest(project, input);
	}

	async completeStripeCheckoutRequest(
		project: ProjectInstanceContext,
		input: CompleteStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState> {
		return await this.stripe.completeStripeCheckoutRequest(project, input);
	}

	async getStripeProviderCustomer(
		project: ProjectInstanceContext,
		input: GetStripeProviderCustomerInput,
	): Promise<string | null> {
		return await this.stripe.getStripeProviderCustomer(project, input);
	}

	async linkStripeProviderCustomer(
		project: ProjectInstanceContext,
		input: LinkStripeProviderCustomerInput,
	): Promise<string> {
		return await this.stripe.linkStripeProviderCustomer(project, input);
	}

	async recordStripeCreditPurchaseAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStripeCreditPurchaseProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.stripe.recordStripeCreditPurchaseAndEnqueueProjection(project, input);
	}

	async recordStripeSubscriptionAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStripeSubscriptionProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.stripe.recordStripeSubscriptionAndEnqueueProjection(project, input);
	}

	async recordStripeCreditReversalAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStripeCreditReversalProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.stripe.recordStripeCreditReversalAndEnqueueProjection(project, input);
	}

	async recordStripeSkippedEvent(
		project: ProjectInstanceContext,
		input: RecordStripeSkippedEventInput,
	): Promise<StripeRecordingResult> {
		return await this.stripe.recordStripeSkippedEvent(project, input);
	}

	async recordStoreKitTransactionAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStoreKitTransactionProjectionInput,
	): Promise<StoreKitRecordingResult> {
		return await this.apple.recordStoreKitTransactionAndEnqueueProjection(project, input);
	}

	async getOrCreateGoogleProviderCustomer(
		project: ProjectInstanceContext,
		billingAccountId: string,
		obfuscatedAccountId: string,
	): Promise<string> {
		return await this.google.getOrCreateGoogleProviderCustomer(
			project,
			billingAccountId,
			obfuscatedAccountId,
		);
	}

	async getGoogleAndroidProductKind(
		project: ProjectInstanceContext,
		externalProductId: string,
	): Promise<"consumable" | "non_consumable"> {
		return await this.google.getGoogleAndroidProductKind(project, externalProductId);
	}

	async recordGooglePurchaseAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordGooglePurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult> {
		return await this.google.recordGooglePurchaseAndEnqueueProjection(project, input);
	}

	async recordGoogleVoidedPurchaseAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordGoogleVoidedPurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult> {
		return await this.google.recordGoogleVoidedPurchaseAndEnqueueProjection(project, input);
	}

	async getMeteringBalance(
		project: ProjectInstanceContext,
		billingAccountId: string,
		featureKey: string,
		entityId?: string | null,
	): Promise<MeteringBalance> {
		return await this.metering.getBalance(project, billingAccountId, featureKey, entityId);
	}

	async checkUsage(
		project: ProjectInstanceContext,
		input: MeteringSubjectInput,
	): Promise<MeteringDecision> {
		return await this.metering.check(project, input);
	}

	async consumeUsage(
		project: ProjectInstanceContext,
		input: MeteringMutationInput,
	): Promise<ConsumeUsageResult> {
		return await this.metering.consume(project, input);
	}

	async consumeWorkerUsage(
		project: ProjectInstanceContext,
		input: WorkerMeteringMutationInput,
	): Promise<WorkerConsumeUsageResult> {
		return await this.metering.consumeWorkerDelivery(project, input);
	}

	async reserveUsage(
		project: ProjectInstanceContext,
		input: ReserveUsageInput,
	): Promise<ReservationResult> {
		return await this.metering.reserve(project, input);
	}

	async confirmUsageReservation(
		project: ProjectInstanceContext,
		input: ConfirmReservationInput,
	): Promise<FinalizeReservationResult> {
		return await this.metering.confirm(project, input);
	}

	async releaseUsageReservation(
		project: ProjectInstanceContext,
		input: ReleaseReservationInput,
	): Promise<FinalizeReservationResult> {
		return await this.metering.release(project, input);
	}

	async correctUsage(
		project: ProjectInstanceContext,
		input: CorrectUsageInput,
	): Promise<UsageCorrectionResult> {
		return await this.metering.correct(project, input);
	}

	async grantAllocation(
		project: ProjectInstanceContext,
		input: GrantAllocationInput,
	): Promise<{ allocationId: string; duplicate: boolean; balance: MeteringBalance }> {
		return await this.metering.grantAllocation(project, input);
	}

	async expireUsageReservations(limit: number): Promise<number> {
		return await this.metering.expireReservations(limit);
	}

	async runMeteringMaintenance(limit: number) {
		return await this.metering.runMaintenance(limit);
	}

	async previewCatalog(
		project: ProjectInstanceContext,
		input: CatalogPreviewInput,
	): Promise<CatalogPreview> {
		return await this.catalog.preview(project, input);
	}

	async getPublishedCatalog(project: ProjectInstanceContext): Promise<PublishedCatalog> {
		return await this.catalog.getPublished(project);
	}

	async publishCatalog(
		project: ProjectInstanceContext,
		input: CatalogPublishInput,
	): Promise<CatalogPublishResult> {
		return await this.catalog.publish(project, input);
	}
}
