import type { ProjectionJobPayload } from "../billing/types";
import type { ProjectInstanceContext } from "../projects/context";
import type {
	ExpiredSubscriptionReconciliationResult,
	PlanGrantReconciliationOptions,
	PlanGrantReconciliationResult,
	ProjectionSyncJobRow,
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
	TrialEndingNoticeResult,
} from "./repository";

export interface ProjectionSyncJobRepositorySource {
	claimProjectionSyncJobs(workerId: string, limit: number): Promise<ProjectionSyncJobRow[]>;
	prepareProjectionSyncJobDelivery(
		projectId: string,
		jobId: string,
		workerId: string,
	): Promise<"ready" | "skipped">;
	buildUsageProjection(
		projectId: string,
		customerId: string,
		claim?: { jobId: string; workerId: string },
	): Promise<ProjectionJobPayload>;
	markProjectionSyncJobSucceeded(projectId: string, jobId: string, workerId: string): Promise<void>;
	markProjectionSyncJobFailed(
		projectId: string,
		jobId: string,
		lastError: string,
		retryDelayMs: number | null,
		workerId: string,
	): Promise<void>;
}

export class ProjectionSyncJobRepository implements ProjectionSyncJobRepositorySource {
	constructor(private readonly source: ProjectionSyncJobRepositorySource) {}

	async claimProjectionSyncJobs(workerId: string, limit: number): Promise<ProjectionSyncJobRow[]> {
		return await this.source.claimProjectionSyncJobs(workerId, limit);
	}

	async prepareProjectionSyncJobDelivery(
		projectId: string,
		jobId: string,
		workerId: string,
	): Promise<"ready" | "skipped"> {
		return await this.source.prepareProjectionSyncJobDelivery(projectId, jobId, workerId);
	}

	async buildUsageProjection(
		projectId: string,
		customerId: string,
		claim?: { jobId: string; workerId: string },
	): Promise<ProjectionJobPayload> {
		return await this.source.buildUsageProjection(projectId, customerId, claim);
	}

	async markProjectionSyncJobSucceeded(
		projectId: string,
		jobId: string,
		workerId: string,
	): Promise<void> {
		await this.source.markProjectionSyncJobSucceeded(projectId, jobId, workerId);
	}

	async markProjectionSyncJobFailed(
		projectId: string,
		jobId: string,
		lastError: string,
		retryDelayMs: number | null,
		workerId: string,
	): Promise<void> {
		await this.source.markProjectionSyncJobFailed(
			projectId,
			jobId,
			lastError,
			retryDelayMs,
			workerId,
		);
	}
}

export interface StoreEventReplayJobRepositorySource {
	claimStoreEventReplayJobs(workerId: string, limit: number): Promise<StoreEventReplayJobRow[]>;
	claimStoreEventReplayJobById(
		workerId: string,
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<StoreEventReplayJobRow>;
	markStoreEventReplayJobSucceeded(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void>;
	markStoreEventReplayJobDeferred?(
		projectId: string,
		eventId: string,
		reason: string,
		retryDelayMs: number,
		workerId: string,
	): Promise<void>;

	markStoreEventReplayJobFailed(
		projectId: string,
		eventId: string,
		errorMessage: string,
		retryDelayMs: number | null,
		workerId: string,
	): Promise<void>;
	renewStoreEventReplayJobLease?(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void>;
	markStoreEventReplayJobErased?(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void>;
}

export class StoreEventReplayJobRepository implements StoreEventReplayJobRepositorySource {
	constructor(private readonly source: StoreEventReplayJobRepositorySource) {}

	async claimStoreEventReplayJobs(
		workerId: string,
		limit: number,
	): Promise<StoreEventReplayJobRow[]> {
		return await this.source.claimStoreEventReplayJobs(workerId, limit);
	}

	async claimStoreEventReplayJobById(
		workerId: string,
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<StoreEventReplayJobRow> {
		return await this.source.claimStoreEventReplayJobById(workerId, project, eventId);
	}

	async markStoreEventReplayJobSucceeded(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void> {
		await this.source.markStoreEventReplayJobSucceeded(projectId, eventId, workerId);
	}

	async markStoreEventReplayJobFailed(
		projectId: string,
		eventId: string,
		errorMessage: string,
		retryDelayMs: number | null,
		workerId: string,
	): Promise<void> {
		await this.source.markStoreEventReplayJobFailed(
			projectId,
			eventId,
			errorMessage,
			retryDelayMs,
			workerId,
		);
	}

	async markStoreEventReplayJobDeferred(
		projectId: string,
		eventId: string,
		reason: string,
		retryDelayMs: number,
		workerId: string,
	): Promise<void> {
		if (!this.source.markStoreEventReplayJobDeferred)
			throw new Error("Store event deferral is unavailable");
		await this.source.markStoreEventReplayJobDeferred(
			projectId,
			eventId,
			reason,
			retryDelayMs,
			workerId,
		);
	}

	async renewStoreEventReplayJobLease(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void> {
		await this.source.renewStoreEventReplayJobLease?.(projectId, eventId, workerId);
	}

	async markStoreEventReplayJobErased(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void> {
		await this.source.markStoreEventReplayJobErased?.(projectId, eventId, workerId);
	}
}

export interface ProviderSubscriptionReconciliationRepositorySource {
	reconcileExpiredSubscriptions(limit: number): Promise<ExpiredSubscriptionReconciliationResult>;
	enqueueTrialEndingNotices(limit: number): Promise<TrialEndingNoticeResult>;
	reconcilePlanGrants(
		limit: number,
		options?: PlanGrantReconciliationOptions,
	): Promise<PlanGrantReconciliationResult>;
	claimProviderSubscriptionReconciliations(
		workerId: string,
		limit: number,
		staleAfterMs: number,
	): Promise<ProviderSubscriptionReconciliationRow[]>;
	markProviderSubscriptionReconciliationSucceeded(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void>;
	markProviderSubscriptionReconciliationFailed(
		projectId: string,
		subscriptionId: string,
		errorMessage: string,
		retryDelayMs: number,
		workerId: string,
	): Promise<void>;
	renewProviderSubscriptionReconciliationLease?(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void>;
}

export class ProviderSubscriptionReconciliationRepository
	implements ProviderSubscriptionReconciliationRepositorySource
{
	constructor(private readonly source: ProviderSubscriptionReconciliationRepositorySource) {}

	async reconcileExpiredSubscriptions(
		limit: number,
	): Promise<ExpiredSubscriptionReconciliationResult> {
		return await this.source.reconcileExpiredSubscriptions(limit);
	}

	async enqueueTrialEndingNotices(limit: number): Promise<TrialEndingNoticeResult> {
		return await this.source.enqueueTrialEndingNotices(limit);
	}

	async reconcilePlanGrants(
		limit: number,
		options?: PlanGrantReconciliationOptions,
	): Promise<PlanGrantReconciliationResult> {
		return options === undefined
			? await this.source.reconcilePlanGrants(limit)
			: await this.source.reconcilePlanGrants(limit, options);
	}

	async claimProviderSubscriptionReconciliations(
		workerId: string,
		limit: number,
		staleAfterMs: number,
	): Promise<ProviderSubscriptionReconciliationRow[]> {
		return await this.source.claimProviderSubscriptionReconciliations(
			workerId,
			limit,
			staleAfterMs,
		);
	}

	async markProviderSubscriptionReconciliationSucceeded(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void> {
		await this.source.markProviderSubscriptionReconciliationSucceeded(
			projectId,
			subscriptionId,
			workerId,
		);
	}

	async markProviderSubscriptionReconciliationFailed(
		projectId: string,
		subscriptionId: string,
		errorMessage: string,
		retryDelayMs: number,
		workerId: string,
	): Promise<void> {
		await this.source.markProviderSubscriptionReconciliationFailed(
			projectId,
			subscriptionId,
			errorMessage,
			retryDelayMs,
			workerId,
		);
	}

	async renewProviderSubscriptionReconciliationLease(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void> {
		await this.source.renewProviderSubscriptionReconciliationLease?.(
			projectId,
			subscriptionId,
			workerId,
		);
	}
}
