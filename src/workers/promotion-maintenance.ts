import type {
	PromotionStripeSyncJob,
	PromotionStripeSyncOutcome,
	SubscriptionDiscountInput,
	SubscriptionDiscountOutcome,
} from "../billing/promotions";
import type { ReferralDiscountApplication, ReferralRewardJob } from "../billing/referrals";
import type { BillingProvider } from "../billing/types";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import type { ProviderAdapter } from "../providers/contract";
import { calculateRetryDelayMs, normalizeWorkerError } from "./backoff";
import { JobLeaseRenewalError, jobHeartbeatInterval, startJobLeases } from "./job-leases";
import type { LeaseHeartbeatTimers } from "./lease-heartbeat";
import { resolveClaimedProjectInstance } from "./project-context";

export interface PromotionMaintenanceRepository {
	renewStripeObjectLease(projectId: string, objectId: string, workerId: string): Promise<boolean>;
	releaseExpiredPromotionReservations(limit: number): Promise<number>;
	reconcilePromotionCoupons(limit: number): Promise<{ couponsCreated: number }>;
	ensureHostedPromotionCodeObjects(limit: number): Promise<number>;
	claimStripeObjects(
		workerId: string,
		limit: number,
		staleAfterMs: number,
	): Promise<PromotionStripeSyncJob[]>;
	markStripeObjectOutcome(
		projectId: string,
		objectId: string,
		workerId: string,
		outcome:
			| { kind: "ready"; externalId: string; providerActive: boolean }
			| { kind: "retired"; externalId: string | null }
			| { kind: "failed"; error: string; retryDelayMs: number | null }
			| { kind: "deferred"; error: string; retryDelayMs: number },
	): Promise<void>;
}

/** What the worker needs to issue referral rewards that are due. */
export interface ReferralRewardSweep {
	qualifyDueReferrals(limit: number): Promise<number>;
	listDueRewards(limit: number): Promise<ReferralRewardJob[]>;
	issueReward(project: ProjectInstanceContext, rewardId: string): Promise<void>;
	deferReward(
		projectId: string,
		rewardId: string,
		input: { error: string; retryDelayMs: number | null },
	): Promise<void>;
	listHeldDiscounts(limit: number, maxAttempts: number): Promise<ReferralRewardJob[]>;
	prepareDiscount(
		project: ProjectInstanceContext,
		rewardId: string,
	): Promise<ReferralDiscountApplication | null>;
	completeDiscount(
		project: ProjectInstanceContext,
		discount: ReferralDiscountApplication,
	): Promise<void>;
	postponeDiscount(
		project: ProjectInstanceContext,
		discount: ReferralDiscountApplication,
		reason: string,
	): Promise<void>;
}

export interface PromotionStripeProvider {
	syncPromotionStripeObject(job: PromotionStripeSyncJob): Promise<PromotionStripeSyncOutcome>;
	addSubscriptionDiscount(input: SubscriptionDiscountInput): Promise<SubscriptionDiscountOutcome>;
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
	leaseSkipped: number;
	referralsQualified: number;
	referralRewardsProcessed: number;
	referralRewardsDeferred: number;
	referralDiscountsApplied: number;
}

type PromotionJobOutcome = "ready" | "retired" | "retryScheduled" | "failed" | "deferred";

const DEFAULT_MAX_ATTEMPTS = 8;
const NOT_CONFIGURED_RETRY_MS = 60 * 60_000;

/**
 * Keeps promotion state that depends on time or on Stripe converging: expired reservations are
 * released, coupons follow catalog changes, and Stripe objects are created and toggled.
 */
export class PromotionMaintenanceWorker {
	private readonly heartbeatIntervalMs: number;
	constructor(
		private readonly dependencies: {
			workerId: string;
			batchSize?: number;
			staleAfterMs?: number;
			leaseHeartbeatIntervalMs?: number;
			leaseHeartbeatTimers?: LeaseHeartbeatTimers;
			maxAttempts?: number;
			repository: PromotionMaintenanceRepository;
			referralRewards: ReferralRewardSweep;
			projectContextResolver: ProjectInstanceContextResolver;
			/** Null when the project has no connection for the provider; the job is deferred. */
			adapterForJob(
				project: ProjectInstanceContext,
				provider: BillingProvider,
			): PromotionMaintenanceAdapter | null | Promise<PromotionMaintenanceAdapter | null>;
			logger: { error(message: string, error: unknown, context?: Record<string, unknown>): void };
			metrics?: BillingMetrics;
		},
	) {
		this.heartbeatIntervalMs = jobHeartbeatInterval(
			dependencies.staleAfterMs ?? 5 * 60_000,
			dependencies.leaseHeartbeatIntervalMs,
		);
	}

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
			leaseSkipped: 0,
			referralsQualified: await this.dependencies.referralRewards.qualifyDueReferrals(batchSize),
			referralRewardsProcessed: 0,
			referralRewardsDeferred: 0,
			referralDiscountsApplied: 0,
		};
		await this.issueReferralRewards(batchSize, result);
		await this.applyHeldDiscounts(batchSize, result);
		const staleAfterMs = this.dependencies.staleAfterMs ?? 5 * 60_000;
		const jobs = await repository.claimStripeObjects(
			this.dependencies.workerId,
			batchSize,
			staleAfterMs,
		);
		result.claimed = jobs.length;
		const leases = startJobLeases({
			jobs,
			intervalMs: this.heartbeatIntervalMs,
			timers: this.dependencies.leaseHeartbeatTimers,
			renew: (job) =>
				repository.renewStripeObjectLease(job.projectId, job.objectId, this.dependencies.workerId),
			onLost: (job) =>
				this.dependencies.logger.error(
					"Promotion provider lease lost",
					new Error("Lease no longer owned"),
					{ objectId: job.objectId },
				),
			onError: (error, job) =>
				this.dependencies.logger.error("Promotion lease renewal failed", error, {
					objectId: job.objectId,
				}),
		});
		try {
			for (const job of jobs) {
				let outcome: PromotionJobOutcome | null = null;
				try {
					if (await leases.owns(job)) outcome = await this.sync(job, () => leases.owns(job));
				} catch (error) {
					if (!(error instanceof JobLeaseRenewalError)) throw error;
				} finally {
					leases.release(job);
				}
				result[outcome ?? "leaseSkipped"] += 1;
				this.record(job.objectKind, outcome ?? "lease_skipped");
			}
		} finally {
			await leases.stop();
		}

		return result;
	}

	/**
	 * Issues rewards in turn. Issuing is safe to repeat, so a reward needs no lease: two workers on
	 * one reward serialize on the recipient's lock, and the second finds it settled.
	 */
	private async issueReferralRewards(
		batchSize: number,
		result: PromotionMaintenanceRunResult,
	): Promise<void> {
		const { referralRewards, projectContextResolver, logger, maxAttempts } = this.dependencies;
		for (const job of await referralRewards.listDueRewards(batchSize)) {
			try {
				const project = await resolveClaimedProjectInstance(projectContextResolver, {
					projectInstanceId: job.projectId,
					projectInstanceKey: job.projectKey,
				});
				await referralRewards.issueReward(project, job.rewardId);
				result.referralRewardsProcessed += 1;
				this.record("referral_reward", "processed");
			} catch (error) {
				logger.error("Referral reward could not be issued", error, {
					projectKey: job.projectKey,
					rewardId: job.rewardId,
				});
				await referralRewards.deferReward(job.projectId, job.rewardId, {
					error: normalizeWorkerError(error),
					retryDelayMs: calculateRetryDelayMs({
						attempts: job.attempts,
						maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
					}),
				});
				result.referralRewardsDeferred += 1;
				this.record("referral_reward", "deferred");
			}
		}
	}

	/**
	 * Puts held discounts on live subscriptions. Like issuing, each attempt is safe to repeat, so
	 * none needs a lease: the reservation, the Stripe key and the settled status make a second
	 * worker on one reward arrive at the same result.
	 */
	private async applyHeldDiscounts(
		batchSize: number,
		result: PromotionMaintenanceRunResult,
	): Promise<void> {
		const { referralRewards, projectContextResolver, logger } = this.dependencies;
		const maxAttempts = this.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		for (const job of await referralRewards.listHeldDiscounts(batchSize, maxAttempts)) {
			try {
				const project = await resolveClaimedProjectInstance(projectContextResolver, {
					projectInstanceId: job.projectId,
					projectInstanceKey: job.projectKey,
				});
				if (await this.applyHeldDiscount(project, job.rewardId)) {
					result.referralDiscountsApplied += 1;
					this.record("referral_discount", "applied");
				}
			} catch (error) {
				logger.error("Referral discount could not be applied", error, {
					projectKey: job.projectKey,
					rewardId: job.rewardId,
				});
				await referralRewards.deferReward(job.projectId, job.rewardId, {
					error: normalizeWorkerError(error),
					retryDelayMs: calculateRetryDelayMs({ attempts: job.attempts, maxAttempts }),
				});
				this.record("referral_discount", "deferred");
			}
		}
	}

	private async applyHeldDiscount(
		project: ProjectInstanceContext,
		rewardId: string,
	): Promise<boolean> {
		const { referralRewards, adapterForJob } = this.dependencies;
		const discount = await referralRewards.prepareDiscount(project, rewardId);
		if (discount === null) return false;
		const adapter = await adapterForJob(project, "stripe");
		if (adapter?.promotions?.addSubscriptionDiscount === undefined) {
			await referralRewards.postponeDiscount(project, discount, "STRIPE_NOT_CONFIGURED");
			return false;
		}
		const outcome = await adapter.promotions.addSubscriptionDiscount({
			promotionId: discount.promotionId,
			externalSubscriptionId: discount.externalSubscriptionId,
			idempotencyKey: `billing:referral-reward:${discount.rewardId}`,
			retry: discount.retry,
		});
		if (outcome === "already_discounted") {
			await referralRewards.postponeDiscount(project, discount, "SUBSCRIPTION_HAS_DISCOUNT");
			return false;
		}
		await referralRewards.completeDiscount(project, discount);
		return true;
	}

	private async sync(
		job: PromotionStripeSyncJob,
		owns: () => Promise<boolean>,
	): Promise<PromotionJobOutcome | null> {
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
			if (!(await owns())) return null;
			if (adapter === null) {
				await repository.markStripeObjectOutcome(job.projectId, job.objectId, workerId, {
					kind: "deferred",
					error: "Stripe is not configured for this environment",
					retryDelayMs: NOT_CONFIGURED_RETRY_MS,
				});
				return "deferred";
			}
			if (adapter.promotions === undefined) {
				throw new Error(`${job.provider} provider does not serve promotion.hosted_code`);
			}
			const outcome = await adapter.promotions.syncObject(job);
			if (!(await owns())) return null;
			if (outcome.kind === "ready" || outcome.kind === "retired") {
				await repository.markStripeObjectOutcome(job.projectId, job.objectId, workerId, outcome);
				return outcome.kind;
			}
			return await this.fail(job, outcome.error, outcome.terminal);
		} catch (error) {
			if (error instanceof JobLeaseRenewalError || !(await owns())) return null;
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
		const retryDelayMs = terminal
			? null
			: calculateRetryDelayMs({
					attempts: job.attempts - 1,
					maxAttempts: this.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
				});
		await this.dependencies.repository.markStripeObjectOutcome(
			job.projectId,
			job.objectId,
			this.dependencies.workerId,
			{ kind: "failed", error, retryDelayMs },
		);
		return retryDelayMs === null ? "failed" : "retryScheduled";
	}

	private record(objectKind: string, result: string): void {
		safelyIncrementBillingMetric(
			this.dependencies.metrics ?? createNoopBillingMetrics(),
			"billing_worker_jobs_total",
			{ worker: "promotion_maintenance", operation: objectKind, result },
		);
	}
}
