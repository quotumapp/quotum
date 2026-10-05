import type {
	AutoTopupChargeResult,
	AutoTopupChargeSucceeded,
	AutoTopupFailureResult,
	AutoTopupJob,
	AutoTopupRunResult,
} from "../billing/auto-topup";
import type { BillingProvider } from "../billing/types";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import type { ProviderAdapter } from "../providers/contract";
import { calculateNextAttemptAt, normalizeWorkerError } from "./backoff";
import { JobLeaseRenewalError, jobHeartbeatInterval, startJobLeases } from "./job-leases";
import type { LeaseHeartbeatTimers } from "./lease-heartbeat";
import { resolveClaimedProjectInstance } from "./project-context";

export interface AutoTopupWorkerRepository {
	renewAutoTopupJobLease(projectId: string, jobId: string, workerId: string): Promise<boolean>;
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

/** The adapter group an automatic top-up job needs from its own provider. */
export type AutoTopupWorkerAdapter = Pick<ProviderAdapter, "topups">;

export interface AutoTopupWorkerLogger {
	warn?(message: string, context?: Record<string, unknown>): void;
	error(message: string, error: unknown, context?: Record<string, unknown>): void;
}

export class AutoTopupWorker {
	private readonly heartbeatIntervalMs: number;
	constructor(
		private readonly dependencies: {
			workerId: string;
			batchSize?: number;
			staleAfterMs?: number;
			leaseHeartbeatIntervalMs?: number;
			leaseHeartbeatTimers?: LeaseHeartbeatTimers;
			repository: AutoTopupWorkerRepository;
			projectContextResolver: ProjectInstanceContextResolver;
			adapterForJob(
				project: ProjectInstanceContext,
				provider: BillingProvider,
			): AutoTopupWorkerAdapter | Promise<AutoTopupWorkerAdapter>;
			logger: AutoTopupWorkerLogger;
			metrics?: BillingMetrics;
		},
	) {
		this.heartbeatIntervalMs = jobHeartbeatInterval(
			dependencies.staleAfterMs ?? 5 * 60_000,
			dependencies.leaseHeartbeatIntervalMs,
		);
	}

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
		const leases = startJobLeases({
			jobs,
			intervalMs: this.heartbeatIntervalMs,
			timers: this.dependencies.leaseHeartbeatTimers,
			renew: (job) =>
				this.dependencies.repository.renewAutoTopupJobLease(
					job.projectId,
					job.jobId,
					this.dependencies.workerId,
				),
			onLost: (job) =>
				this.dependencies.logger.warn?.("Auto top-up lease lost", {
					projectKey: job.projectKey,
					jobId: job.jobId,
					workerId: this.dependencies.workerId,
				}),
			onError: (error, job) =>
				this.dependencies.logger.error("Auto top-up lease renewal failed", error, {
					projectKey: job.projectKey,
					jobId: job.jobId,
					workerId: this.dependencies.workerId,
				}),
		});
		try {
			for (const job of jobs) {
				try {
					const project = await resolveClaimedProjectInstance(
						this.dependencies.projectContextResolver,
						{
							projectInstanceId: job.projectId,
							projectInstanceKey: job.projectKey,
						},
					);
					const { topups } = await this.dependencies.adapterForJob(project, job.provider);
					if (topups === undefined) {
						throw new Error(`${job.provider} provider does not serve topup.automatic`);
					}
					if (!(await leases.owns(job))) continue;
					const { timing: _timing, ...charge } = await topups.chargeAutomatic(job);
					if (!(await leases.owns(job))) continue;
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
					if (error instanceof JobLeaseRenewalError) {
						result.failed += 1;
						continue;
					}
					if (!(await leases.owns(job).catch(() => false))) continue;
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
				} finally {
					leases.release(job);
				}
			}
		} finally {
			await leases.stop();
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
