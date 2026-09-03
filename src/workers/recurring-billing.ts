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

export interface RecurringBillingWorkerRepository {
	claimSubscriptionChanges(workerId: string, limit: number): Promise<SubscriptionChangeOperation[]>;
	markSubscriptionChangeApplied(
		project: { projectKey: string },
		changeId: string,
		providerRequestId: string,
	): Promise<void>;
	markSubscriptionChangeFailed(changeId: string, error: string): Promise<void>;
	materializeAndClaimUsageInvoicePeriods(
		workerId: string,
		limit: number,
	): Promise<{ materialized: number; jobs: UsageInvoiceJob[] }>;
	markUsageInvoiceSucceeded(
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		externalInvoiceId: string,
	): Promise<void>;
	markUsageInvoiceFailed(
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		error: string,
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
			providerForProject(projectKey: string): RecurringBillingWorkerProvider;
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
				const providerRequestId = await this.dependencies
					.providerForProject(change.projectKey)
					.applySubscriptionChange(change);
				await this.dependencies.repository.markSubscriptionChangeApplied(
					{ projectKey: change.projectKey },
					change.changeId,
					providerRequestId,
				);
				subscriptionChangesApplied += 1;
				this.recordJob("subscription_change", "succeeded");
			} catch (error) {
				failed += 1;
				this.recordJob("subscription_change", "failed");
				await this.dependencies.repository.markSubscriptionChangeFailed(
					change.changeId,
					errorMessage(error),
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
				const externalInvoiceId = await this.dependencies
					.providerForProject(job.projectKey)
					.createUsageInvoice(job);
				await this.dependencies.repository.markUsageInvoiceSucceeded(
					job.jobKind,
					job.jobId,
					externalInvoiceId,
				);
				if (job.jobKind === "period") usageInvoicesCreated += 1;
				else usageAdjustmentsCreated += 1;
				this.recordJob(`usage_${job.jobKind}`, "succeeded");
			} catch (error) {
				failed += 1;
				this.recordJob(`usage_${job.jobKind}`, "failed");
				await this.dependencies.repository.markUsageInvoiceFailed(
					job.jobKind,
					job.jobId,
					errorMessage(error),
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
