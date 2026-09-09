import type {
	RecurringBillingRunResult,
	SubscriptionChangeOperation,
	UsageInvoiceJob,
} from "../billing/recurring";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import { resolveClaimedProjectInstance } from "./project-context";

export interface RecurringBillingWorkerRepository {
	claimSubscriptionChanges(workerId: string, limit: number): Promise<SubscriptionChangeOperation[]>;
	markSubscriptionChangeApplied(
		projectInstanceId: string,
		changeId: string,
		providerRequestId: string,
		workerId: string,
	): Promise<void>;
	markSubscriptionChangeFailed(
		projectInstanceId: string,
		changeId: string,
		error: string,
		workerId: string,
	): Promise<void>;
	materializeAndClaimUsageInvoicePeriods(
		workerId: string,
		limit: number,
	): Promise<{ materialized: number; jobs: UsageInvoiceJob[] }>;
	markUsageInvoiceSucceeded(
		projectInstanceId: string,
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		externalInvoiceId: string,
		workerId: string,
	): Promise<void>;
	markUsageInvoiceFailed(
		projectInstanceId: string,
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		error: string,
		workerId: string,
	): Promise<void>;
}

export interface RecurringBillingWorkerProvider {
	applySubscriptionChange(operation: SubscriptionChangeOperation): Promise<string>;
	createUsageInvoice(job: UsageInvoiceJob): Promise<string>;
}

export interface RecurringBillingWorkerLogger {
	error(message: string, error: unknown, context?: Record<string, unknown>): void;
}

export class RecurringBillingWorker {
	constructor(
		private readonly dependencies: {
			workerId: string;
			batchSize?: number;
			repository: RecurringBillingWorkerRepository;
			projectContextResolver: ProjectInstanceContextResolver;
			providerForProject(
				project: ProjectInstanceContext,
			): RecurringBillingWorkerProvider | Promise<RecurringBillingWorkerProvider>;
			logger: RecurringBillingWorkerLogger;
			metrics?: BillingMetrics;
		},
	) {}

	async runOnce(): Promise<RecurringBillingRunResult> {
		const limit = this.dependencies.batchSize ?? 25;
		let subscriptionChangesApplied = 0;
		let usageInvoicesCreated = 0;
		let usageAdjustmentsCreated = 0;
		let failed = 0;
		const changes = await this.dependencies.repository.claimSubscriptionChanges(
			this.dependencies.workerId,
			limit,
		);
		for (const change of changes) {
			try {
				const project = await resolveClaimedProjectInstance(
					this.dependencies.projectContextResolver,
					{
						projectInstanceId: change.projectInstanceId,
						projectInstanceKey: change.projectKey,
					},
				);
				const providerRequestId = await (
					await this.dependencies.providerForProject(project)
				).applySubscriptionChange(change);
				await this.dependencies.repository.markSubscriptionChangeApplied(
					change.projectInstanceId,
					change.changeId,
					providerRequestId,
					this.dependencies.workerId,
				);
				subscriptionChangesApplied += 1;
				this.recordJob("subscription_change", "succeeded");
			} catch (error) {
				failed += 1;
				this.recordJob("subscription_change", "failed");
				await this.dependencies.repository.markSubscriptionChangeFailed(
					change.projectInstanceId,
					change.changeId,
					errorMessage(error),
					this.dependencies.workerId,
				);
				this.dependencies.logger.error("Subscription change failed", error, {
					projectKey: change.projectKey,
					changeId: change.changeId,
				});
			}
		}

		const usage = await this.dependencies.repository.materializeAndClaimUsageInvoicePeriods(
			this.dependencies.workerId,
			limit,
		);
		for (const job of usage.jobs) {
			try {
				const project = await resolveClaimedProjectInstance(
					this.dependencies.projectContextResolver,
					{
						projectInstanceId: job.projectInstanceId,
						projectInstanceKey: job.projectKey,
					},
				);
				const externalInvoiceId = await (
					await this.dependencies.providerForProject(project)
				).createUsageInvoice(job);
				await this.dependencies.repository.markUsageInvoiceSucceeded(
					job.projectInstanceId,
					job.jobKind,
					job.jobId,
					externalInvoiceId,
					this.dependencies.workerId,
				);
				if (job.jobKind === "period") usageInvoicesCreated += 1;
				else usageAdjustmentsCreated += 1;
				this.recordJob(`usage_${job.jobKind}`, "succeeded");
			} catch (error) {
				failed += 1;
				this.recordJob(`usage_${job.jobKind}`, "failed");
				await this.dependencies.repository.markUsageInvoiceFailed(
					job.projectInstanceId,
					job.jobKind,
					job.jobId,
					errorMessage(error),
					this.dependencies.workerId,
				);
				this.dependencies.logger.error("Stripe usage invoice failed", error, {
					projectKey: job.projectKey,
					periodId: job.periodId,
				});
			}
		}
		return {
			materializedUsagePeriods: usage.materialized,
			subscriptionChangesApplied,
			usageInvoicesCreated,
			usageAdjustmentsCreated,
			failed,
		};
	}

	private recordJob(operation: string, result: "succeeded" | "failed"): void {
		safelyIncrementBillingMetric(
			this.dependencies.metrics ?? createNoopBillingMetrics(),
			"billing_worker_jobs_total",
			{ worker: "recurring_billing", operation, result },
		);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}
