import type {
	RecurringBillingRunResult,
	SubscriptionChangeOperation,
	UsageInvoiceJob,
} from "../billing/recurring";
import type { BillingProvider } from "../billing/types";
import type {
	ClaimedSubscriptionChange,
	ClaimedUsageInvoiceJob,
	SubscriptionChangeClaimOptions,
	UsageInvoiceClaimOptions,
} from "../db/repository";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import type { ProviderAdapter } from "../providers/contract";
import type { ProviderOperation } from "../shared/provider-capabilities";
import { resolveClaimedProjectInstance } from "./project-context";

export interface RecurringBillingWorkerRepository {
	claimSubscriptionChanges(
		workerId: string,
		limit: number,
		options?: SubscriptionChangeClaimOptions,
	): Promise<ClaimedSubscriptionChange[]>;
	loadClaimedSubscriptionChange(
		projectInstanceId: string,
		changeId: string,
		workerId: string,
	): Promise<SubscriptionChangeOperation | null>;
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
		options?: UsageInvoiceClaimOptions,
	): Promise<{ materialized: number; jobs: ClaimedUsageInvoiceJob[] }>;
	loadClaimedUsageInvoiceJob(
		projectInstanceId: string,
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		workerId: string,
	): Promise<UsageInvoiceJob | null>;
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

/** The adapter groups a recurring billing job needs from its own provider. */
export type RecurringBillingWorkerAdapter = Pick<ProviderAdapter, "changes" | "settlement">;

export interface RecurringBillingWorkerLogger {
	error(message: string, error: unknown, context?: Record<string, unknown>): void;
	/** A lost lease is normal concurrency, not a failure, so it is reported below error level. */
	warn?(message: string, context?: Record<string, unknown>): void;
}

export class RecurringBillingWorker {
	constructor(
		private readonly dependencies: {
			workerId: string;
			batchSize?: number;
			repository: RecurringBillingWorkerRepository;
			projectContextResolver: ProjectInstanceContextResolver;
			adapterForJob(
				project: ProjectInstanceContext,
				provider: BillingProvider,
			): RecurringBillingWorkerAdapter | Promise<RecurringBillingWorkerAdapter>;
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

		// Each claim is guarded on its own, so a failing change claim still invoices usage.
		let claimedChanges: ClaimedSubscriptionChange[] = [];
		try {
			claimedChanges = await this.dependencies.repository.claimSubscriptionChanges(
				this.dependencies.workerId,
				limit,
				{
					onStagingError: (error) =>
						this.logError("Catalog migration staging failed", error, {
							workerId: this.dependencies.workerId,
						}),
				},
			);
		} catch (error) {
			failed += 1;
			this.logError("Subscription change claim failed", error, {
				workerId: this.dependencies.workerId,
			});
		}

		for (const claimed of claimedChanges) {
			try {
				const change = await this.dependencies.repository.loadClaimedSubscriptionChange(
					claimed.projectInstanceId,
					claimed.changeId,
					this.dependencies.workerId,
				);
				if (change === null) {
					this.logWarn("Subscription change lease lost", {
						projectKey: claimed.projectKey,
						changeId: claimed.changeId,
						workerId: this.dependencies.workerId,
					});
					continue;
				}
				const project = await resolveClaimedProjectInstance(
					this.dependencies.projectContextResolver,
					{
						projectInstanceId: claimed.projectInstanceId,
						projectInstanceKey: claimed.projectKey,
					},
				);
				const { changes } = await this.dependencies.adapterForJob(project, change.provider);
				if (changes === undefined) {
					throw unservedOperation(
						change.provider,
						change.effectiveMode === "period_end"
							? "subscription.change.period_end"
							: "subscription.change.apply",
					);
				}
				const applied = await changes.apply(change);
				if (applied.outcome === "uncertain") {
					throw new UncertainProviderWriteError(applied.correlation);
				}
				await this.dependencies.repository.markSubscriptionChangeApplied(
					claimed.projectInstanceId,
					claimed.changeId,
					applied.providerRequestId,
					this.dependencies.workerId,
				);
				subscriptionChangesApplied += 1;
				this.recordJob("subscription_change", "succeeded");
			} catch (error) {
				failed += 1;
				this.recordJob("subscription_change", "failed");
				// Log first: an uncertain write's correlation must survive a failing mark.
				this.logError("Subscription change failed", error, {
					projectKey: claimed.projectKey,
					changeId: claimed.changeId,
					...uncertainWriteContext(error),
				});
				await this.markSubscriptionChangeFailedSafely(claimed, error);
			}
		}

		let usage: { materialized: number; jobs: ClaimedUsageInvoiceJob[] } = {
			materialized: 0,
			jobs: [],
		};
		try {
			usage = await this.dependencies.repository.materializeAndClaimUsageInvoicePeriods(
				this.dependencies.workerId,
				limit,
				{
					onMaterializationError: (error, context) =>
						this.logError("Usage invoice materialization failed", error, {
							...context,
							workerId: this.dependencies.workerId,
						}),
				},
			);
		} catch (error) {
			failed += 1;
			this.logError("Usage invoice claim failed", error, {
				workerId: this.dependencies.workerId,
			});
		}

		for (const claimed of usage.jobs) {
			let job: UsageInvoiceJob | null = null;
			try {
				job = await this.dependencies.repository.loadClaimedUsageInvoiceJob(
					claimed.projectInstanceId,
					claimed.jobKind,
					claimed.jobId,
					this.dependencies.workerId,
				);
				if (job === null) {
					this.logWarn("Usage invoice lease lost", {
						projectKey: claimed.projectKey,
						jobKind: claimed.jobKind,
						jobId: claimed.jobId,
						workerId: this.dependencies.workerId,
					});
					continue;
				}
				const project = await resolveClaimedProjectInstance(
					this.dependencies.projectContextResolver,
					{
						projectInstanceId: claimed.projectInstanceId,
						projectInstanceKey: claimed.projectKey,
					},
				);
				const { settlement } = await this.dependencies.adapterForJob(project, job.provider);
				if (settlement === undefined) {
					throw unservedOperation(
						job.provider,
						job.jobKind === "adjustment"
							? "adjustment.issue"
							: "settlement.collect_finalized_charge",
					);
				}
				const charged = await settlement.collectFinalizedCharge(job);
				if (charged.outcome === "uncertain") {
					throw new UncertainProviderWriteError(charged.correlation);
				}
				await this.dependencies.repository.markUsageInvoiceSucceeded(
					claimed.projectInstanceId,
					claimed.jobKind,
					claimed.jobId,
					charged.externalChargeId,
					this.dependencies.workerId,
				);
				if (claimed.jobKind === "period") usageInvoicesCreated += 1;
				else usageAdjustmentsCreated += 1;
				this.recordJob(`usage_${claimed.jobKind}`, "succeeded");
			} catch (error) {
				failed += 1;
				this.recordJob(`usage_${claimed.jobKind}`, "failed");
				this.logError("Usage invoice failed", error, {
					projectKey: claimed.projectKey,
					...(job === null ? {} : { provider: job.provider }),
					periodId: claimed.periodId,
					...uncertainWriteContext(error),
				});
				await this.markUsageInvoiceFailedSafely(claimed, error);
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

	/** A failing mark must not abandon the rest of the batch; the job is retried from its lease. */
	private async markSubscriptionChangeFailedSafely(
		claimed: ClaimedSubscriptionChange,
		error: unknown,
	): Promise<void> {
		try {
			await this.dependencies.repository.markSubscriptionChangeFailed(
				claimed.projectInstanceId,
				claimed.changeId,
				errorMessage(error),
				this.dependencies.workerId,
			);
		} catch (markerError) {
			this.logError("Subscription change failure marker failed", markerError, {
				projectKey: claimed.projectKey,
				changeId: claimed.changeId,
				workerId: this.dependencies.workerId,
			});
		}
	}

	private async markUsageInvoiceFailedSafely(
		claimed: ClaimedUsageInvoiceJob,
		error: unknown,
	): Promise<void> {
		try {
			await this.dependencies.repository.markUsageInvoiceFailed(
				claimed.projectInstanceId,
				claimed.jobKind,
				claimed.jobId,
				errorMessage(error),
				this.dependencies.workerId,
			);
		} catch (markerError) {
			this.logError("Usage invoice failure marker failed", markerError, {
				projectKey: claimed.projectKey,
				jobKind: claimed.jobKind,
				jobId: claimed.jobId,
				workerId: this.dependencies.workerId,
			});
		}
	}

	/** A throwing logger must never abandon the batch or skip a failure transition. */
	private logError(message: string, error: unknown, context: Record<string, unknown>): void {
		try {
			this.dependencies.logger.error(message, error, context);
		} catch {
			// The logger is injectable; a reporting failure is never worth losing the job for.
		}
	}

	private logWarn(message: string, context: Record<string, unknown>): void {
		try {
			this.dependencies.logger.warn?.(message, context);
		} catch {
			// Same reasoning as logError.
		}
	}

	private recordJob(operation: string, result: "succeeded" | "failed"): void {
		safelyIncrementBillingMetric(
			this.dependencies.metrics ?? createNoopBillingMetrics(),
			"billing_worker_jobs_total",
			{ worker: "recurring_billing", operation, result },
		);
	}
}

/**
 * The provider may or may not have performed the write, so the job must never be finalized. It
 * fails through the normal retry path and the correlation is logged for reconciliation.
 */
class UncertainProviderWriteError extends Error {
	constructor(readonly correlation: Record<string, string>) {
		super("Provider write outcome is uncertain; reconciliation is required");
	}
}

function unservedOperation(provider: BillingProvider, operation: ProviderOperation): Error {
	return new Error(`${provider} provider does not serve ${operation}`);
}

function uncertainWriteContext(error: unknown): { correlation?: Record<string, string> } {
	return error instanceof UncertainProviderWriteError ? { correlation: error.correlation } : {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}
