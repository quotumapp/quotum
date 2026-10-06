import { BillingError } from "../billing/errors";
import type { RecurringJobKind } from "../billing/recurring";
import type { ProjectInstanceContext } from "../projects/context";
import type { SubscriptionReconciliationRunResult } from "../workers/subscription-reconciliation";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Usage invoice adjustments are numbered; the pattern keeps the id inside bigint. */
const adjustmentIdPattern = /^[1-9][0-9]{0,17}$/;

export interface BillingAdminReplayWorker {
	runOne(
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<{
		eventId: string;
		status: "processed" | "ignored" | "retryable" | "deferred" | "failed";
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

export interface BillingAdminRecurringJobRepository {
	retryRecurringJob(
		project: ProjectInstanceContext,
		jobKind: RecurringJobKind,
		jobId: string,
	): Promise<{ jobKind: RecurringJobKind; jobId: string; status: "pending" }>;
}

export class BillingAdminOperations {
	private readonly replayWorker: BillingAdminReplayWorker;
	private readonly reconciliationWorker: BillingAdminReconciliationWorker;
	private readonly projectionRepository: BillingAdminProjectionRepository | null;
	private readonly recurringJobRepository: BillingAdminRecurringJobRepository | null;

	constructor({
		replayWorker,
		reconciliationWorker,
		projectionRepository = null,
		recurringJobRepository = null,
	}: {
		replayWorker: BillingAdminReplayWorker;
		reconciliationWorker: BillingAdminReconciliationWorker;
		projectionRepository?: BillingAdminProjectionRepository | null;
		recurringJobRepository?: BillingAdminRecurringJobRepository | null;
	}) {
		this.replayWorker = replayWorker;
		this.reconciliationWorker = reconciliationWorker;
		this.projectionRepository = projectionRepository;
		this.recurringJobRepository = recurringJobRepository;
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

	retryRecurringJob(project: ProjectInstanceContext, jobKind: RecurringJobKind, jobId: string) {
		const trimmedJobId = jobId.trim();
		if (
			!(jobKind === "usage-invoice-adjustment" ? adjustmentIdPattern : uuidPattern).test(
				trimmedJobId,
			)
		) {
			throw new BillingError("Invalid recurring billing job id", "INVALID_REQUEST", 400);
		}
		if (this.recurringJobRepository === null) {
			throw new BillingError(
				"Recurring billing recovery is not configured",
				"BILLING_ADMIN_NOT_CONFIGURED",
				501,
			);
		}

		return this.recurringJobRepository.retryRecurringJob(project, jobKind, trimmedJobId);
	}
}
