import type {
	AutoTopupChargeResult,
	AutoTopupChargeSucceeded,
	AutoTopupFailureResult,
	AutoTopupJob,
	AutoTopupRunResult,
} from "../billing/auto-topup";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import { calculateNextAttemptAt, normalizeWorkerError } from "./backoff";

export interface AutoTopupWorkerRepository {
	claimAutoTopupJobs(workerId: string, limit: number, staleBefore: Date): Promise<AutoTopupJob[]>;
	markAutoTopupSucceeded(
		projectId: string,
		jobId: string,
		workerId: string,
		charge: AutoTopupChargeSucceeded,
	): Promise<{ circuitOpened: boolean }>;
	markAutoTopupFailed(
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
	): Promise<AutoTopupFailureResult>;
}

export interface AutoTopupWorkerProvider {
	createAutoTopupCharge(job: AutoTopupJob): Promise<AutoTopupChargeResult>;
}

export interface AutoTopupWorkerLogger {
	error(message: string, error: unknown, context?: Record<string, unknown>): void;
}

export class AutoTopupWorker {
	constructor(
		private readonly dependencies: {
			workerId: string;
			batchSize?: number;
			staleAfterMs?: number;
			repository: AutoTopupWorkerRepository;
			providerForProject(projectKey: string): AutoTopupWorkerProvider;
			logger: AutoTopupWorkerLogger;
			metrics?: BillingMetrics;
		},
	) {}

	async runOnce(): Promise<AutoTopupRunResult> {
		const staleBefore = new Date(Date.now() - (this.dependencies.staleAfterMs ?? 5 * 60_000));
		const jobs = await this.dependencies.repository.claimAutoTopupJobs(
			this.dependencies.workerId,
			this.dependencies.batchSize ?? 25,
			staleBefore,
		);
		const result: AutoTopupRunResult = {
			claimed: jobs.length,
			succeeded: 0,
			retryScheduled: 0,
			actionRequired: 0,
			circuitOpened: 0,
			failed: 0,
		};
		for (const job of jobs) {
			try {
				const charge = await this.dependencies
					.providerForProject(job.projectKey)
					.createAutoTopupCharge(job);
				if (charge.status === "succeeded") {
					const completion = await this.dependencies.repository.markAutoTopupSucceeded(
						job.projectId,
						job.jobId,
						this.dependencies.workerId,
						charge,
					);
					result.succeeded += 1;
					if (completion.circuitOpened) result.circuitOpened += 1;
					this.recordJob("succeeded");
					continue;
				}
				const completion = await this.dependencies.repository.markAutoTopupFailed(
					job.projectId,
					job.jobId,
					this.dependencies.workerId,
					{
						kind: charge.status,
						error: charge.reason,
						nextAttemptAt: null,
						externalInvoiceId: charge.externalInvoiceId,
						externalPaymentId: charge.externalPaymentId,
					},
				);
				result.actionRequired += 1;
				if (completion.circuitOpened) result.circuitOpened += 1;
				this.recordJob(charge.status);
			} catch (error) {
				result.failed += 1;
				const nextAttemptAt = calculateNextAttemptAt({
					attempts: job.consecutiveFailures,
					maxAttempts: job.maxConsecutiveFailures,
				});
				const completion = await this.dependencies.repository.markAutoTopupFailed(
					job.projectId,
					job.jobId,
					this.dependencies.workerId,
					{
						kind: "retryable",
						error: normalizeWorkerError(error).slice(0, 2_000),
						nextAttemptAt,
					},
				);
				if (completion.retryScheduled) result.retryScheduled += 1;
				if (completion.circuitOpened) result.circuitOpened += 1;
				this.recordJob(completion.retryScheduled ? "retry_scheduled" : "failed");
				this.dependencies.logger.error("Automatic top-up failed", error, {
					projectKey: job.projectKey,
					jobId: job.jobId,
					policyId: job.policyId,
				});
			}
		}
		return result;
	}

	private recordJob(result: string): void {
		safelyIncrementBillingMetric(
			this.dependencies.metrics ?? createNoopBillingMetrics(),
			"billing_worker_jobs_total",
			{ worker: "auto_topup", operation: "charge", result },
		);
	}
}
