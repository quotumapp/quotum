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
	AvailableActionFacts,
	CustomerBillingSummary,
	ProjectUsageEventListInput,
	ProjectUsageEventPage,
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
import type { PaymentSetupCard, PaymentSetupSession } from "../billing/payment-setup";
import type {
	SubscriptionCancellationContext,
	SubscriptionChangeInput,
	SubscriptionChangeOperation,
	SubscriptionChangePreview,
	UsageInvoiceJob,
} from "../billing/recurring";
import type {
	BillingChannel,
	BillingProvider,
	EntitlementSnapshot,
	ProjectionJobPayload,
} from "../billing/types";
import type {
	UsageOperationLookupInput,
	UsageOperationLookupResult,
} from "../billing/usage-operations";
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
import {
	PaymentSetupRepository,
	type PaymentSetupReservation,
	type PaymentSetupRow,
	type RecordPaymentSetupPlanOutcomeInput,
	type ReservePaymentSetupInput,
} from "./repository/payment-setup";
import { PlanGrantRepository } from "./repository/plan-grants";
import { ProjectScopedBillingRepository } from "./repository/project-scoped";
import { ProjectionJobBillingRepository } from "./repository/projection-jobs";
import { PromotionProviderObjectRepository } from "./repository/promotion-provider-objects";
import { PromotionRepository } from "./repository/promotions";
import {
	type ClaimedSubscriptionChange,
	type ClaimedUsageInvoiceJob,
	RecurringPricingRepository,
	type SubscriptionChangeClaimOptions,
	type UsageInvoiceClaimOptions,
} from "./repository/recurring-pricing";
import { StoreEventReplayBillingRepository } from "./repository/store-event-replay";
import {
	enqueueStoreEventForReplay,
	schedulePaymentSetupReconciliation,
} from "./repository/store-events";
import { StripeBillingRepository } from "./repository/stripe";
import { SubscriptionReconciliationBillingRepository } from "./repository/subscription-reconciliation";
import type {
	CompleteStripeCheckoutRequestInput,
	ExpiredSubscriptionReconciliationResult,
	GetStripeProviderCustomerInput,
	GooglePlayRecordingResult,
	LinkStripeProviderCustomerInput,
	PlanGrantReconciliationResult,
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
	TrialEndingNoticeResult,
} from "./repository/types";
import {
	ensureUsageEventPartitions,
	type UsagePartitionUpkeepOptions,
	type UsagePartitionUpkeepResult,
} from "./repository/usage-partitions";

export type { GrantAllocationInput } from "./repository/metering";
export type {
	PaymentSetupReservation,
	PaymentSetupRow,
	RecordPaymentSetupPlanOutcomeInput,
	ReservePaymentSetupInput,
} from "./repository/payment-setup";
export { ProjectScopedBillingRepository } from "./repository/project-scoped";
export type {
	ClaimedSubscriptionChange,
	ClaimedUsageInvoiceJob,
	SubscriptionChangeClaimOptions,
	UsageInvoiceClaimOptions,
} from "./repository/recurring-pricing";
export type {
	CompleteStripeCheckoutRequestInput,
	ExpiredSubscriptionReconciliationResult,
	GetStripeProviderCustomerInput,
	GooglePlayRecordingResult,
	LinkStripeProviderCustomerInput,
	PlanGrantReconciliationResult,
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
	TrialEndingNoticeResult,
} from "./repository/types";

export class BillingRepository {
	private readonly core: CoreBillingRepository;
	private readonly projectionJobs: ProjectionJobBillingRepository;
	private readonly storeEventReplay: StoreEventReplayBillingRepository;
	private readonly subscriptionReconciliation: SubscriptionReconciliationBillingRepository;
	private readonly apple: AppleBillingRepository;
	private readonly autoTopupJobs: AutoTopupJobRepository;
	private readonly commercialActions: CommercialActionRepository;
	private readonly paymentSetups: PaymentSetupRepository;
	private readonly google: GoogleBillingRepository;
	private readonly insights: BillingInsightsRepository;
	private readonly stripe: StripeBillingRepository;
	private readonly recurringPricing: RecurringPricingRepository;
	private readonly metering: MeteringBillingRepository;
	private readonly catalog: CatalogControlPlane;
	readonly controlsEnterprise: ControlsEnterpriseRepository;
	readonly promotions: PromotionRepository;
	readonly planGrants: PlanGrantRepository;
	readonly promotionProviders: PromotionProviderObjectRepository;

	private readonly database: TransactionalQueryExecutor;

	constructor(
		database: TransactionalQueryExecutor = defaultDb as unknown as TransactionalQueryExecutor,
	) {
		this.database = database;
		this.core = new CoreBillingRepository(database);
		this.projectionJobs = new ProjectionJobBillingRepository(database);
		this.storeEventReplay = new StoreEventReplayBillingRepository(database);
		this.subscriptionReconciliation = new SubscriptionReconciliationBillingRepository(database);
		this.apple = new AppleBillingRepository(database);
		this.autoTopupJobs = new AutoTopupJobRepository(database);
		this.commercialActions = new CommercialActionRepository(database);
		this.paymentSetups = new PaymentSetupRepository(database);
		this.google = new GoogleBillingRepository(database);
		this.insights = new BillingInsightsRepository(database);
		this.stripe = new StripeBillingRepository(database);
		this.recurringPricing = new RecurringPricingRepository(database);
		this.metering = new MeteringBillingRepository(database);
		this.catalog = new CatalogControlPlane(database);
		this.controlsEnterprise = new ControlsEnterpriseRepository(database);
		this.promotions = new PromotionRepository(database);
		this.planGrants = new PlanGrantRepository(database);
		this.promotionProviders = new PromotionProviderObjectRepository(database);
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

	async buildUsageProjection(projectId: string, customerId: string): Promise<ProjectionJobPayload> {
		return await this.projectionJobs.buildUsageProjection(projectId, customerId);
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

	/** Ending notices for provider trials that send none, then for trials Quotum runs itself. */
	async enqueueTrialEndingNotices(limit: number): Promise<TrialEndingNoticeResult> {
		const subscriptions = await this.subscriptionReconciliation.enqueueTrialEndingNotices(limit);
		const grants = await this.planGrants.enqueuePlanGrantEndingNotices(limit);
		return {
			noticedTrials: subscriptions.noticedTrials + grants.noticedTrials,
			affectedCustomers: subscriptions.affectedCustomers + grants.affectedCustomers,
			projectionJobs: subscriptions.projectionJobs + grants.projectionJobs,
		};
	}

	async reconcilePlanGrants(limit: number): Promise<PlanGrantReconciliationResult> {
		return await this.planGrants.reconcilePlanGrants(limit);
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

	async previewSubscriptionCancellation(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; externalSubscriptionId: string },
	): Promise<SubscriptionCancellationContext> {
		return await this.recurringPricing.previewSubscriptionCancellation(project, input);
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

	async listProjectUsageEvents(
		project: ProjectInstanceContext,
		input: ProjectUsageEventListInput,
	): Promise<ProjectUsageEventPage> {
		return await this.insights.listProjectUsageEvents(project, input);
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

	async getAvailableActionFacts(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<AvailableActionFacts> {
		return await this.insights.getAvailableActionFacts(project, billingAccountId);
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

	async completeSubscriptionCancellation(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			previewToken: string;
			idempotencyKey: string;
			externalSubscriptionId: string;
			supersedeReason: string;
			supersedesPendingChange: boolean;
			result: Omit<
				Extract<CommercialActionExecutionResult, { kind: "subscription_cancellation" }>,
				"supersededChangeId"
			>;
		},
	): Promise<CommercialActionExecutionResult> {
		return await this.commercialActions.completeSubscriptionCancellation(project, input);
	}

	async claimSubscriptionChanges(
		workerId: string,
		limit: number,
		options?: SubscriptionChangeClaimOptions,
	): Promise<ClaimedSubscriptionChange[]> {
		return await this.recurringPricing.claimSubscriptionChanges(workerId, limit, options);
	}

	async loadClaimedSubscriptionChange(
		projectInstanceId: string,
		changeId: string,
		workerId: string,
	): Promise<SubscriptionChangeOperation | null> {
		return await this.recurringPricing.loadClaimedSubscriptionChange(
			projectInstanceId,
			changeId,
			workerId,
		);
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

	async markSubscriptionChangeCancelled(
		projectInstanceId: string,
		changeId: string,
		reason: string,
		workerId: string,
	): Promise<void> {
		await this.recurringPricing.markSubscriptionChangeCancelled(
			projectInstanceId,
			changeId,
			reason,
			workerId,
		);
	}

	async materializeAndClaimUsageInvoicePeriods(
		workerId: string,
		limit: number,
		options?: UsageInvoiceClaimOptions,
	): Promise<{ materialized: number; jobs: ClaimedUsageInvoiceJob[] }> {
		return await this.recurringPricing.materializeAndClaimUsageInvoicePeriods(
			workerId,
			limit,
			options,
		);
	}

	async loadClaimedUsageInvoiceJob(
		projectInstanceId: string,
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		workerId: string,
	): Promise<UsageInvoiceJob | null> {
		return await this.recurringPricing.loadClaimedUsageInvoiceJob(
			projectInstanceId,
			jobKind,
			jobId,
			workerId,
		);
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

	async getUsageOperation(
		project: ProjectInstanceContext,
		input: UsageOperationLookupInput,
	): Promise<UsageOperationLookupResult> {
		return await this.metering.getOperation(project, input);
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

	async ensureUsageEventPartitions(
		options?: UsagePartitionUpkeepOptions,
	): Promise<UsagePartitionUpkeepResult> {
		return await ensureUsageEventPartitions(this.database, options);
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

	async findActivePaymentSetup(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; providerAccountId: string | null },
	): Promise<PaymentSetupRow | null> {
		return await this.paymentSetups.findActivePaymentSetup(project, input);
	}

	async reservePaymentSetup(
		project: ProjectInstanceContext,
		input: ReservePaymentSetupInput,
	): Promise<PaymentSetupReservation> {
		return await this.paymentSetups.reservePaymentSetup(project, input);
	}

	async recordPaymentSetupLink(
		project: ProjectInstanceContext,
		input: {
			setupId: string;
			externalSessionId: string;
			sessionUrl: string;
			externalSetupIntentId: string | null;
			expiresAt: Date;
		},
	): Promise<PaymentSetupRow> {
		return await this.paymentSetups.recordPaymentSetupLink(project, input);
	}

	async claimPaymentSetup(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string },
	): Promise<PaymentSetupRow | null> {
		return await this.paymentSetups.claimPaymentSetup(project, input);
	}

	async releasePaymentSetupClaim(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string },
	): Promise<void> {
		await this.paymentSetups.releasePaymentSetupClaim(project, input);
	}

	async recordPaymentSetupIntent(
		project: ProjectInstanceContext,
		input: {
			setupId: string;
			workerId: string;
			externalSetupIntentId: string;
			paymentMethodId: string;
			externalSessionId: string | null;
		},
	): Promise<PaymentSetupRow> {
		return await this.paymentSetups.recordPaymentSetupIntent(project, input);
	}

	async completePaymentSetup(
		project: ProjectInstanceContext,
		input: {
			setupId: string;
			workerId: string;
			paymentMethodId: string;
			card: PaymentSetupCard | null;
		},
	): Promise<PaymentSetupRow> {
		return await this.paymentSetups.completePaymentSetup(project, input);
	}

	async recordPaymentSetupSubscriptionId(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string; externalSubscriptionId: string },
	): Promise<PaymentSetupRow> {
		return await this.paymentSetups.recordPaymentSetupSubscriptionId(project, input);
	}

	async recordPaymentSetupPlanOutcome(
		project: ProjectInstanceContext,
		input: RecordPaymentSetupPlanOutcomeInput,
	): Promise<PaymentSetupRow> {
		return await this.paymentSetups.recordPaymentSetupPlanOutcome(project, input);
	}

	async expirePaymentSetup(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string },
	): Promise<PaymentSetupRow> {
		return await this.paymentSetups.expirePaymentSetup(project, input);
	}

	async flagPaymentSetupAttention(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string; reason: string },
	): Promise<PaymentSetupRow | null> {
		return await this.paymentSetups.flagPaymentSetupAttention(project, input);
	}

	async getPaymentSetupSession(
		project: ProjectInstanceContext,
		billingAccountId: string,
		sessionId: string,
	): Promise<PaymentSetupSession> {
		return await this.paymentSetups.getPaymentSetupSession(project, billingAccountId, sessionId);
	}

	async findPaymentSetupById(
		project: ProjectInstanceContext,
		setupId: string,
	): Promise<PaymentSetupRow | null> {
		return await this.paymentSetups.findPaymentSetupById(project, setupId);
	}

	async schedulePaymentSetupReconciliation(
		project: ProjectInstanceContext,
		input: { setupId: string; nextAttemptAt: Date },
	): Promise<string> {
		return await schedulePaymentSetupReconciliation(
			this.database,
			project.projectInstanceId,
			input,
		);
	}

	async enqueueProviderStoreEvent(
		project: ProjectInstanceContext,
		input: {
			provider: BillingProvider;
			channel: BillingChannel;
			externalEventId: string | null;
			eventType: string;
			transactionId: string | null;
			rawPayload: Record<string, unknown>;
		},
	): Promise<{ storeEventId: string; enqueued: boolean }> {
		return await enqueueStoreEventForReplay(this.database, project.projectInstanceId, input);
	}
}
