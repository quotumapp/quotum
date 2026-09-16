import type {
	CommercialActionExecutionResult,
	CommercialActionPreview,
	CommercialPreviewDraft,
	StoredCommercialActionPreview,
} from "../../billing/commercial";
import type {
	CommercialPromotion,
	PromotionRedemptionStatus,
	PromotionStripeSyncJob,
	PromotionTarget,
	StripeCheckoutPromotionFacts,
} from "../../billing/promotions";
import type {
	SubscriptionChangeInput,
	SubscriptionChangeOperation,
	SubscriptionChangePreview,
} from "../../billing/recurring";
import type { BillingProvider, EntitlementSnapshot } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import type { StripeCatalog } from "../../providers/stripe/types";
import type { BillingRepository } from "../repository";
import type {
	CompleteStripeCheckoutRequestInput,
	GetStripeProviderCustomerInput,
	GooglePlayRecordingResult,
	LinkStripeProviderCustomerInput,
	PrepareStripeCheckoutRequestInput,
	RecordGooglePurchaseProjectionInput,
	RecordGoogleVoidedPurchaseProjectionInput,
	RecordPurchaseProjectionInput,
	RecordStoreKitTransactionProjectionInput,
	RecordStripeCreditPurchaseProjectionInput,
	RecordStripeCreditReversalProjectionInput,
	RecordStripeSkippedEventInput,
	RecordStripeSubscriptionProjectionInput,
	StoreKitRecordingResult,
	StripeBillingAccountSummary,
	StripeCheckoutRequestState,
	StripeRecordingResult,
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
} from "./types";

export class ProjectScopedBillingRepository {
	constructor(
		private readonly repository: BillingRepository,
		private readonly project: ProjectInstanceContext,
	) {}

	async getEntitlementSnapshot(billingAccountId: string): Promise<EntitlementSnapshot> {
		return await this.repository.getEntitlementSnapshot(this.project, billingAccountId);
	}

	async recomputeCustomerEntitlements(billingAccountId: string): Promise<EntitlementSnapshot> {
		return await this.repository.recomputeCustomerEntitlements(this.project, billingAccountId);
	}

	async recordPurchaseAndEnqueueProjection(
		input: RecordPurchaseProjectionInput,
	): Promise<EntitlementSnapshot> {
		return await this.repository.recordPurchaseAndEnqueueProjection(this.project, input);
	}

	async getOrCreateProviderCustomerToken(
		billingAccountId: string,
		provider: BillingProvider,
	): Promise<string> {
		return await this.repository.getOrCreateProviderCustomerToken(
			this.project,
			billingAccountId,
			provider,
		);
	}

	async getStripeWebStoreProductByKey(productKey: string): Promise<StripeWebStoreProductRow> {
		return await this.repository.getStripeWebStoreProductByKey(this.project, productKey);
	}

	async getStripeRecurringCheckoutPlanByKey(
		planKey: string,
		billingAccountId: string,
	): Promise<StripeRecurringCheckoutPlan> {
		return await this.repository.getStripeRecurringCheckoutPlanByKey(
			this.project,
			planKey,
			billingAccountId,
		);
	}

	async hasActiveBasePlan(billingAccountId: string): Promise<boolean> {
		return await this.repository.hasActiveBasePlan(this.project, billingAccountId);
	}

	async prepareSubscriptionChange(
		input: SubscriptionChangeInput,
	): Promise<SubscriptionChangeOperation> {
		return await this.repository.prepareSubscriptionChange(this.project, input);
	}

	async previewSubscriptionChange(
		input: Omit<SubscriptionChangeInput, "idempotencyKey" | "expectedStateFingerprint">,
	): Promise<SubscriptionChangePreview> {
		return await this.repository.previewSubscriptionChange(this.project, input);
	}

	async createCommercialActionPreview(
		draft: CommercialPreviewDraft,
	): Promise<CommercialActionPreview> {
		return await this.repository.createCommercialActionPreview(this.project, draft);
	}

	async resolveCommercialPromotion(input: {
		billingAccountId: string;
		code: string;
		target: PromotionTarget;
	}): Promise<CommercialPromotion> {
		return await this.repository.promotions.resolveCommercialPromotion(this.project, input);
	}

	async ensureSubscriptionDiscountAvailable(externalSubscriptionId: string): Promise<void> {
		await this.repository.promotions.ensureSubscriptionDiscountAvailable(
			this.project,
			externalSubscriptionId,
		);
	}

	async reserveCommercialPromotion(
		input: Parameters<BillingRepository["promotions"]["reserveCommercialPromotion"]>[1],
	): Promise<{ id: string; status: PromotionRedemptionStatus }> {
		return await this.repository.promotions.reserveCommercialPromotion(this.project, input);
	}

	async attachPromotionCheckoutSession(input: {
		redemptionId: string;
		checkoutSessionId: string;
		reservedUntil: Date;
	}): Promise<void> {
		await this.repository.promotions.attachPromotionCheckoutSession(this.project, input);
	}

	async recordStripeCheckoutPromotion(input: {
		billingAccountId: string;
		promotion: StripeCheckoutPromotionFacts;
	}): Promise<void> {
		await this.repository.promotions.recordStripeCheckoutPromotion(this.project, input);
	}

	async releaseStripeCheckoutPromotion(input: {
		checkoutSessionId: string;
		redemptionId: string | null;
	}): Promise<void> {
		await this.repository.promotions.releaseStripeCheckoutPromotion(this.project, input);
	}

	async prepareStripeCoupon(promotionId: string) {
		return await this.repository.promotionProviders.prepareStripeCoupon(this.project, promotionId);
	}

	async claimStripePromotionObject(
		objectId: string,
		workerId: string,
	): Promise<PromotionStripeSyncJob | null> {
		return await this.repository.promotionProviders.claimStripeObject(
			this.project,
			objectId,
			workerId,
		);
	}

	async markStripePromotionObjectOutcome(
		objectId: string,
		workerId: string,
		outcome: Parameters<BillingRepository["promotionProviders"]["markStripeObjectOutcome"]>[3],
	): Promise<void> {
		await this.repository.promotionProviders.markStripeObjectOutcome(
			this.project.projectInstanceId,
			objectId,
			workerId,
			outcome,
		);
	}

	async getCommercialActionPreview(
		billingAccountId: string,
		previewToken: string,
	): Promise<StoredCommercialActionPreview> {
		return await this.repository.getCommercialActionPreview(
			this.project,
			billingAccountId,
			previewToken,
		);
	}

	async beginCommercialActionExecution(input: {
		billingAccountId: string;
		previewToken: string;
		intentHash: string;
		stateFingerprint: string;
		idempotencyKey: string;
	}): Promise<StoredCommercialActionPreview> {
		return await this.repository.beginCommercialActionExecution(this.project, input);
	}

	async completeCommercialActionExecution(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
		result: CommercialActionExecutionResult;
	}): Promise<CommercialActionExecutionResult> {
		return await this.repository.completeCommercialActionExecution(this.project, input);
	}

	async markSubscriptionChangeApplied(
		changeId: string,
		providerRequestId: string,
		workerId: string,
	): Promise<void> {
		await this.repository.markSubscriptionChangeApplied(
			this.project.projectInstanceId,
			changeId,
			providerRequestId,
			workerId,
		);
	}

	async listStripeCatalog(): Promise<StripeCatalog> {
		return await this.repository.listStripeCatalog(this.project);
	}

	async getStripeBillingAccountSummary(
		billingAccountId: string,
	): Promise<StripeBillingAccountSummary> {
		return await this.repository.getStripeBillingAccountSummary(this.project, billingAccountId);
	}

	async prepareStripeCheckoutRequest(
		input: PrepareStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState> {
		return await this.repository.prepareStripeCheckoutRequest(this.project, input);
	}

	async completeStripeCheckoutRequest(
		input: CompleteStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState> {
		return await this.repository.completeStripeCheckoutRequest(this.project, input);
	}

	async getStripeProviderCustomer(input: GetStripeProviderCustomerInput): Promise<string | null> {
		return await this.repository.getStripeProviderCustomer(this.project, input);
	}

	async linkStripeProviderCustomer(input: LinkStripeProviderCustomerInput): Promise<string> {
		return await this.repository.linkStripeProviderCustomer(this.project, input);
	}

	async recordStripeCreditPurchaseAndEnqueueProjection(
		input: RecordStripeCreditPurchaseProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.repository.recordStripeCreditPurchaseAndEnqueueProjection(
			this.project,
			input,
		);
	}

	async recordStripeSubscriptionAndEnqueueProjection(
		input: RecordStripeSubscriptionProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.repository.recordStripeSubscriptionAndEnqueueProjection(this.project, input);
	}

	async recordStripeCreditReversalAndEnqueueProjection(
		input: RecordStripeCreditReversalProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.repository.recordStripeCreditReversalAndEnqueueProjection(
			this.project,
			input,
		);
	}

	async recordStripeSkippedEvent(
		input: RecordStripeSkippedEventInput,
	): Promise<StripeRecordingResult> {
		return await this.repository.recordStripeSkippedEvent(this.project, input);
	}

	async recordStoreKitTransactionAndEnqueueProjection(
		input: RecordStoreKitTransactionProjectionInput,
	): Promise<StoreKitRecordingResult> {
		return await this.repository.recordStoreKitTransactionAndEnqueueProjection(this.project, input);
	}

	async getOrCreateGoogleProviderCustomer(
		billingAccountId: string,
		obfuscatedAccountId: string,
	): Promise<string> {
		return await this.repository.getOrCreateGoogleProviderCustomer(
			this.project,
			billingAccountId,
			obfuscatedAccountId,
		);
	}

	async getGoogleAndroidProductKind(
		externalProductId: string,
	): Promise<"consumable" | "non_consumable"> {
		return await this.repository.getGoogleAndroidProductKind(this.project, externalProductId);
	}

	async recordGooglePurchaseAndEnqueueProjection(
		input: RecordGooglePurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult> {
		return await this.repository.recordGooglePurchaseAndEnqueueProjection(this.project, input);
	}

	async recordGoogleVoidedPurchaseAndEnqueueProjection(
		input: RecordGoogleVoidedPurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult> {
		return await this.repository.recordGoogleVoidedPurchaseAndEnqueueProjection(
			this.project,
			input,
		);
	}
}
