import type { PromotionStripeSyncJob, PromotionStripeSyncOutcome } from "../billing/promotions";
import type { BillingProvider } from "../billing/types";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import type { ProviderAdapter } from "../providers/contract";
import { calculateNextAttemptAt, normalizeWorkerError } from "./backoff";
import { resolveClaimedProjectInstance } from "./project-context";

export interface PromotionMaintenanceRepository {
	releaseExpiredPromotionReservations(limit: number): Promise<number>;
	reconcilePromotionCoupons(limit: number): Promise<{ couponsCreated: number }>;
	ensureHostedPromotionCodeObjects(limit: number): Promise<number>;
	claimStripeObjects(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<PromotionStripeSyncJob[]>;
	markStripeObjectOutcome(
		projectId: string,
		objectId: string,
		workerId: string,
		outcome:
			| { kind: "ready"; externalId: string; providerActive: boolean }
			| { kind: "retired"; externalId: string | null }
			| { kind: "failed"; error: string; nextAttemptAt: Date | null }
			| { kind: "deferred"; error: string; nextAttemptAt: Date },
	): Promise<void>;
}

export interface PromotionStripeProvider {
	syncPromotionStripeObject(job: PromotionStripeSyncJob): Promise<PromotionStripeSyncOutcome>;
}

/** The adapter group a promotion object sync needs from its own provider. */
export type PromotionMaintenanceAdapter = Pick<ProviderAdapter, "promotions">;

export interface PromotionMaintenanceRunResult {
	reservationsReleased: number;
	couponsCreated: number;
	promotionCodesCreated: number;
	claimed: number;
	ready: number;
	retired: number;
	retryScheduled: number;
	failed: number;
	deferred: number;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const NOT_CONFIGURED_RETRY_MS = 60 * 60_000;

/**
 * Keeps promotion state that depends on time or on Stripe converging: expired reservations are
 * released, coupons follow catalog changes, and Stripe objects are created and toggled.
 */
export class PromotionMaintenanceWorker {
	constructor(
		private readonly dependencies: {
			workerId: string;
			batchSize?: number;
			staleAfterMs?: number;
			maxAttempts?: number;
			repository: PromotionMaintenanceRepository;
			projectContextResolver: ProjectInstanceContextResolver;
			/** Null when the project has no connection for the provider; the job is deferred. */
			adapterForJob(
				project: ProjectInstanceContext,
				provider: BillingProvider,
			): PromotionMaintenanceAdapter | null | Promise<PromotionMaintenanceAdapter | null>;
			logger: { error(message: string, error: unknown, context?: Record<string, unknown>): void };
			metrics?: BillingMetrics;
		},
	) {}

	async runOnce(): Promise<PromotionMaintenanceRunResult> {
		const batchSize = this.dependencies.batchSize ?? 25;
		const repository = this.dependencies.repository;
		const result: PromotionMaintenanceRunResult = {
			reservationsReleased: await repository.releaseExpiredPromotionReservations(batchSize * 10),
			couponsCreated: (await repository.reconcilePromotionCoupons(batchSize)).couponsCreated,
			promotionCodesCreated: await repository.ensureHostedPromotionCodeObjects(batchSize),
			claimed: 0,
			ready: 0,
			retired: 0,
			retryScheduled: 0,
			failed: 0,
			deferred: 0,
		};
		const staleBefore = new Date(Date.now() - (this.dependencies.staleAfterMs ?? 5 * 60_000));
		const jobs = await repository.claimStripeObjects(
			this.dependencies.workerId,
			batchSize,
			staleBefore,
		);
		result.claimed = jobs.length;
		for (const job of jobs) {
			const outcome = await this.sync(job);
			result[outcome] += 1;
			this.record(job.objectKind, outcome);
		}
		return result;
	}

	private async sync(
		job: PromotionStripeSyncJob,
	): Promise<"ready" | "retired" | "retryScheduled" | "failed" | "deferred"> {
		const { repository, workerId } = this.dependencies;
		try {
			const project = await resolveClaimedProjectInstance(
				this.dependencies.projectContextResolver,
				{
					projectInstanceId: job.projectId,
					projectInstanceKey: job.projectKey,
				},
			);
			const adapter = await this.dependencies.adapterForJob(project, job.provider);
			if (adapter === null) {
				await repository.markStripeObjectOutcome(job.projectId, job.objectId, workerId, {
					kind: "deferred",
					error: "Stripe is not configured for this environment",
					nextAttemptAt: new Date(Date.now() + NOT_CONFIGURED_RETRY_MS),
				});
				return "deferred";
			}
			if (adapter.promotions === undefined) {
				throw new Error(`${job.provider} provider does not serve promotion.hosted_code`);
			}
			const outcome = await adapter.promotions.syncObject(job);
			if (outcome.kind === "ready" || outcome.kind === "retired") {
				await repository.markStripeObjectOutcome(job.projectId, job.objectId, workerId, outcome);
				return outcome.kind;
			}
			return await this.fail(job, outcome.error, outcome.terminal);
		} catch (error) {
			this.dependencies.logger.error("Promotion provider sync failed", error, {
				projectKey: job.projectKey,
				objectId: job.objectId,
				objectKind: job.objectKind,
			});
			return await this.fail(job, normalizeWorkerError(error), false);
		}
	}

	private async fail(
		job: PromotionStripeSyncJob,
		error: string,
		terminal: boolean,
	): Promise<"retryScheduled" | "failed"> {
		const nextAttemptAt = terminal
			? null
			: calculateNextAttemptAt({
					attempts: job.attempts - 1,
					maxAttempts: this.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
				});
		await this.dependencies.repository.markStripeObjectOutcome(
			job.projectId,
			job.objectId,
			this.dependencies.workerId,
			{ kind: "failed", error, nextAttemptAt },
		);
		return nextAttemptAt === null ? "failed" : "retryScheduled";
	}

	private record(objectKind: string, result: string): void {
		safelyIncrementBillingMetric(
			this.dependencies.metrics ?? createNoopBillingMetrics(),
			"billing_worker_jobs_total",
			{ worker: "promotion_maintenance", operation: objectKind, result },
		);
	}
}
