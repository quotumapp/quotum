import { BillingError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";
import type { SubscriptionReconciliationRunResult } from "../workers/subscription-reconciliation";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BillingAdminReplayWorker {
	runOne(
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<{
		eventId: string;
		status: "processed" | "ignored" | "retryable" | "failed";
	}>;
}

export interface BillingAdminReconciliationWorker {
	runOnce(): Promise<SubscriptionReconciliationRunResult>;
}

export interface BillingAdminProjectionRepository {
	retryProjectionSyncJob(
		project: ProjectInstanceContext,
		jobId: string,
	): Promise<{ jobId: string; status: "pending" }>;
}

export class BillingAdminOperations {
	private readonly replayWorker: BillingAdminReplayWorker;
	private readonly reconciliationWorker: BillingAdminReconciliationWorker;
	private readonly projectionRepository: BillingAdminProjectionRepository | null;

	constructor({
		replayWorker,
		reconciliationWorker,
		projectionRepository = null,
	}: {
		replayWorker: BillingAdminReplayWorker;
		reconciliationWorker: BillingAdminReconciliationWorker;
		projectionRepository?: BillingAdminProjectionRepository | null;
	}) {
		this.replayWorker = replayWorker;
		this.reconciliationWorker = reconciliationWorker;
		this.projectionRepository = projectionRepository;
	}

	async replayStoreEvent(project: ProjectInstanceContext, eventId: string) {
		const trimmedEventId = eventId.trim();
		if (!uuidPattern.test(trimmedEventId)) {
			throw new BillingError("Invalid store event id", "INVALID_REQUEST", 400);
		}

		return this.replayWorker.runOne(project, trimmedEventId);
	}

	runSubscriptionReconciliation() {
		return this.reconciliationWorker.runOnce();
	}

	retryProjectionSyncJob(project: ProjectInstanceContext, jobId: string) {
		const trimmedJobId = jobId.trim();
		if (!uuidPattern.test(trimmedJobId)) {
			throw new BillingError("Invalid projection job id", "INVALID_REQUEST", 400);
		}
		if (this.projectionRepository === null) {
			throw new BillingError(
				"Projection recovery is not configured",
				"BILLING_ADMIN_NOT_CONFIGURED",
				501,
			);
		}

		return this.projectionRepository.retryProjectionSyncJob(project, trimmedJobId);
	}
}
