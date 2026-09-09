import type { ProjectionJobPayload } from "../billing/types";
import type { ProjectionSyncJobRow } from "../db/repository";
import {
	type BillingLogger,
	createNoopBillingLogger,
	safelyLogError,
	safelyLogInfo,
} from "../observability/logger";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectionDelivery } from "../projections/delivery";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import { calculateNextAttemptAt, normalizeWorkerError } from "./backoff";
import { resolveClaimedProjectInstance } from "./project-context";

export interface ProjectionSyncRepository {
	claimProjectionSyncJobs(workerId: string, limit: number): Promise<ProjectionSyncJobRow[]>;
	buildUsageProjection(projectId: string, customerId: string): Promise<ProjectionJobPayload>;
	markProjectionSyncJobSucceeded(projectId: string, jobId: string, workerId: string): Promise<void>;
	markProjectionSyncJobFailed(
		projectId: string,
		jobId: string,
		lastError: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void>;
}

export interface ProjectionSyncWorkerOptions {
	workerId: string;
	maxAttempts: number;
	batchSize: number;
	concurrency?: number;
	repository: ProjectionSyncRepository;
	delivery: ProjectionDelivery;
	projectContextResolver: ProjectInstanceContextResolver;
	now?: () => Date;
	jitterMs?: () => number;
	logger?: BillingLogger;
	metrics?: BillingMetrics;
}

export interface ProjectionSyncRunResult {
	claimed: number;
	succeeded: number;
	failed: number;
}

export class ProjectionSyncWorker {
	private readonly workerId: string;
	private readonly maxAttempts: number;
	private readonly batchSize: number;
	private readonly concurrency: number;
	private readonly repository: ProjectionSyncRepository;
	private readonly delivery: ProjectionDelivery;
	private readonly projectContextResolver: ProjectInstanceContextResolver;
	private readonly now: () => Date;
	private readonly jitterMs: () => number;
	private readonly logger: BillingLogger;
	private readonly metrics: BillingMetrics;

	constructor({
		workerId,
		maxAttempts,
		batchSize,
		concurrency,
		repository,
		delivery,
		projectContextResolver,
		now = () => new Date(),
		jitterMs = () => Math.floor(Math.random() * 1000),
		logger = createNoopBillingLogger(),
		metrics = createNoopBillingMetrics(),
	}: ProjectionSyncWorkerOptions) {
		this.workerId = workerId;
		this.maxAttempts = maxAttempts;
		this.batchSize = batchSize;
		this.concurrency = positiveIntegerOrDefault(concurrency, batchSize);
		this.repository = repository;
		this.delivery = delivery;
		this.projectContextResolver = projectContextResolver;
		this.now = now;
		this.jitterMs = jitterMs;
		this.logger = logger;
		this.metrics = metrics;
	}

	async runOnce(): Promise<ProjectionSyncRunResult> {
		try {
			const jobs = await this.repository.claimProjectionSyncJobs(this.workerId, this.batchSize);
			const counts = await this.syncClaimedJobs(jobs);

			const result = { claimed: jobs.length, ...counts };
			safelyLogInfo(this.logger, "Projection sync run completed", {
				...result,
				workerId: this.workerId,
			});
			return result;
		} catch (error) {
			safelyIncrementBillingMetric(this.metrics, "billing_projection_sync_jobs_total", {
				result: "failed",
			});
			safelyLogError(this.logger, "Projection sync run failed", error, {
				workerId: this.workerId,
				result: "failed",
			});
			throw error;
		}
	}

	private async syncJob(
		job: ProjectionSyncJobRow,
		project: ProjectInstanceContext,
	): Promise<"delivered" | "skipped"> {
		let payload: ProjectionJobPayload | null = job.payload;
		if (payload === null) {
			// Usage-driven jobs carry no stored payload: the receiver may have turned them off, and
			// otherwise the state is read at delivery so one delivery covers every usage since the last.
			const mode =
				(await this.delivery.usageDeliveryMode?.(project.projectInstanceKey)) ?? "coalesced";
			if (mode === "off") return "skipped";
			payload = await this.repository.buildUsageProjection(job.project_id, job.customer_id);
		}
		const {
			billingAccountId,
			generatedAt,
			entitlements,
			balances,
			reason,
			purchase,
			reversal,
			sequence,
		} = payload;
		await this.delivery.deliver({
			schemaVersion: 1,
			projectKey: project.projectInstanceKey,
			jobId: job.id,
			idempotencyKey: job.idempotency_key,
			billingAccountId,
			generatedAt,
			entitlements,
			balances,
			reason,
			...(purchase ? { purchase } : {}),
			...(reversal ? { reversal } : {}),
			...(sequence === undefined ? {} : { sequence }),
		});
		return "delivered";
	}

	private async syncClaimedJobs(
		jobs: ProjectionSyncJobRow[],
	): Promise<{ succeeded: number; failed: number }> {
		let nextIndex = 0;
		let succeeded = 0;
		let failed = 0;
		const workerCount = Math.min(this.concurrency, jobs.length);

		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				for (;;) {
					const job = jobs[nextIndex];
					nextIndex += 1;
					if (job === undefined) {
						return;
					}

					const status = await this.syncClaimedJob(job);
					if (status === "succeeded") {
						succeeded += 1;
					} else {
						failed += 1;
					}
				}
			}),
		);

		return { succeeded, failed };
	}

	private async syncClaimedJob(job: ProjectionSyncJobRow): Promise<"succeeded" | "failed"> {
		try {
			const project = await resolveClaimedProjectInstance(this.projectContextResolver, {
				projectInstanceId: job.project_id,
				projectInstanceKey: job.project_key,
			});
			await this.syncJob(job, project);
		} catch (error) {
			await this.markFailedSafely(job, error);
			safelyIncrementBillingMetric(this.metrics, "billing_projection_sync_jobs_total", {
				result: "failed",
			});
			this.recordWorkerJobMetric(job, "failed");
			safelyLogError(this.logger, "Projection sync job failed", error, {
				jobId: job.id,
				workerId: this.workerId,
				result: "failed",
			});
			return "failed";
		}

		await this.repository.markProjectionSyncJobSucceeded(job.project_id, job.id, this.workerId);
		safelyIncrementBillingMetric(this.metrics, "billing_projection_sync_jobs_total", {
			result: "succeeded",
		});
		this.recordWorkerJobMetric(job, "succeeded");
		return "succeeded";
	}

	private recordWorkerJobMetric(job: ProjectionSyncJobRow, result: "succeeded" | "failed"): void {
		safelyIncrementBillingMetric(this.metrics, "billing_worker_jobs_total", {
			worker: "projection_sync",
			project: job.project_key,
			result,
		});
	}

	private async markFailed(job: ProjectionSyncJobRow, error: unknown): Promise<void> {
		const nextAttemptAt = calculateNextAttemptAt({
			attempts: job.attempts,
			maxAttempts: this.maxAttempts,
			now: this.now(),
			jitterMs: this.jitterMs(),
		});

		await this.repository.markProjectionSyncJobFailed(
			job.project_id,
			job.id,
			normalizeWorkerError(error),
			nextAttemptAt,
			this.workerId,
		);
	}

	private async markFailedSafely(job: ProjectionSyncJobRow, error: unknown): Promise<void> {
		try {
			await this.markFailed(job, error);
		} catch (markerError) {
			safelyLogError(this.logger, "Projection sync job failure marker failed", markerError, {
				jobId: job.id,
				workerId: this.workerId,
				result: "failed",
			});
		}
	}
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	if (value === undefined) {
		return Math.max(1, fallback);
	}
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error("projection sync concurrency must be greater than zero");
	}
	return value;
}
