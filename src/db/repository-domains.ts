import type { ProjectInstanceContext } from "../projects/context";
import type {
	ExpiredSubscriptionReconciliationResult,
	ProjectionSyncJobRow,
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
} from "./repository";

export interface ProjectionSyncJobRepositorySource {
	claimProjectionSyncJobs(workerId: string, limit: number): Promise<ProjectionSyncJobRow[]>;
	markProjectionSyncJobSucceeded(projectId: string, jobId: string, workerId: string): Promise<void>;
	markProjectionSyncJobFailed(
		projectId: string,
		jobId: string,
		lastError: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void>;
}

export class ProjectionSyncJobRepository implements ProjectionSyncJobRepositorySource {
	constructor(private readonly source: ProjectionSyncJobRepositorySource) {}

	async claimProjectionSyncJobs(workerId: string, limit: number): Promise<ProjectionSyncJobRow[]> {
		return await this.source.claimProjectionSyncJobs(workerId, limit);
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
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		await this.source.markProjectionSyncJobFailed(
			projectId,
			jobId,
			lastError,
			nextAttemptAt,
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
	markStoreEventReplayJobFailed(
		projectId: string,
		eventId: string,
		errorMessage: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void>;
	renewStoreEventReplayJobLease?(
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
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		await this.source.markStoreEventReplayJobFailed(
			projectId,
			eventId,
			errorMessage,
			nextAttemptAt,
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
}

export interface ProviderSubscriptionReconciliationRepositorySource {
	reconcileExpiredSubscriptions(limit: number): Promise<ExpiredSubscriptionReconciliationResult>;
	claimProviderSubscriptionReconciliations(
		workerId: string,
		limit: number,
		staleBefore: Date,
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
		nextAttemptAt: Date | null,
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

	async claimProviderSubscriptionReconciliations(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<ProviderSubscriptionReconciliationRow[]> {
		return await this.source.claimProviderSubscriptionReconciliations(workerId, limit, staleBefore);
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
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		await this.source.markProviderSubscriptionReconciliationFailed(
			projectId,
			subscriptionId,
			errorMessage,
			nextAttemptAt,
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
