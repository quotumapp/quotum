import type {
	ExpiredSubscriptionReconciliationResult,
	ProviderSubscriptionReconciliationRow,
} from "../db/repository";
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
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import { calculateNextAttemptAt, normalizeWorkerError } from "./backoff";
import { startLeaseHeartbeat } from "./lease-heartbeat";
import { resolveClaimedProjectInstance } from "./project-context";

export interface SubscriptionReconciliationProvider {
	reconcileSubscription(
		subscription: ProviderSubscriptionReconciliationRow,
	): Promise<{ status: "processed" | "skipped" }>;
}

export interface SubscriptionReconciliationProviders {
	apple: SubscriptionReconciliationProvider | null;
	google: SubscriptionReconciliationProvider | null;
	stripe: SubscriptionReconciliationProvider | null;
}

export type SubscriptionReconciliationProviderSelector = (
	project: ProjectInstanceContext,
	provider: "apple" | "google" | "stripe",
) => SubscriptionReconciliationProviders | Promise<SubscriptionReconciliationProviders>;

export interface SubscriptionReconciliationRepository {
	reconcileExpiredSubscriptions(limit: number): Promise<ExpiredSubscriptionReconciliationResult>;
	claimProviderSubscriptionReconciliations(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<ProviderSubscriptionReconciliationRow[]>;
	markProviderSubscriptionReconciliationSucceeded(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void>;
	markProviderSubscriptionReconciliationFailed(
		projectId: string,
		subscriptionId: string,
		errorMessage: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void>;
	renewProviderSubscriptionReconciliationLease?(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void>;
}

export interface SubscriptionReconciliationWorkerOptions {
	workerId: string;
	maxAttempts: number;
	batchSize: number;
	staleAfterMs: number;
	repository: SubscriptionReconciliationRepository;
	providers: SubscriptionReconciliationProviders | SubscriptionReconciliationProviderSelector;
	projectContextResolver: ProjectInstanceContextResolver;
	now?: () => Date;
	jitterMs?: () => number;
	logger?: BillingLogger;
	metrics?: BillingMetrics;
	leaseHeartbeatIntervalMs?: number;
}

export interface SubscriptionReconciliationRunResult {
	outcome: "succeeded" | "partial" | "failed";
	expiredSubscriptions: number;
	affectedCustomers: number;
	providerClaimed: number;
	providerProcessed: number;
	providerSkipped: number;
	providerFailed: number;
}

export class SubscriptionReconciliationWorker {
	private readonly workerId: string;
	private readonly maxAttempts: number;
	private readonly batchSize: number;
	private readonly staleAfterMs: number;
	private readonly repository: SubscriptionReconciliationRepository;
	private readonly providers:
		| SubscriptionReconciliationProviders
		| SubscriptionReconciliationProviderSelector;
	private readonly projectContextResolver: ProjectInstanceContextResolver;
	private readonly now: () => Date;
	private readonly jitterMs: () => number;
	private readonly logger: BillingLogger;
	private readonly metrics: BillingMetrics;
	private readonly leaseHeartbeatIntervalMs: number;

	constructor({
		workerId,
		maxAttempts,
		batchSize,
		staleAfterMs,
		repository,
		providers,
		projectContextResolver,
		now = () => new Date(),
		jitterMs = () => Math.floor(Math.random() * 1000),
		logger = createNoopBillingLogger(),
		metrics = createNoopBillingMetrics(),
		leaseHeartbeatIntervalMs = 60_000,
	}: SubscriptionReconciliationWorkerOptions) {
		this.workerId = workerId;
		this.maxAttempts = maxAttempts;
		this.batchSize = batchSize;
		this.staleAfterMs = staleAfterMs;
		this.repository = repository;
		this.providers = providers;
		this.projectContextResolver = projectContextResolver;
		this.now = now;
		this.jitterMs = jitterMs;
		this.logger = logger;
		this.metrics = metrics;
		this.leaseHeartbeatIntervalMs = leaseHeartbeatIntervalMs;
	}

	async runOnce(): Promise<SubscriptionReconciliationRunResult> {
		try {
			const now = this.now();
			const staleBefore = new Date(now.getTime() - this.staleAfterMs);
			const subscriptions = await this.repository.claimProviderSubscriptionReconciliations(
				this.workerId,
				this.batchSize,
				staleBefore,
			);
			const result: SubscriptionReconciliationRunResult = {
				outcome: "succeeded",
				expiredSubscriptions: 0,
				affectedCustomers: 0,
				providerClaimed: subscriptions.length,
				providerProcessed: 0,
				providerSkipped: 0,
				providerFailed: 0,
			};

			const stopHeartbeat = this.startLeaseHeartbeat(subscriptions);
			try {
				for (const subscription of subscriptions) {
					const status = await this.processSubscription(subscription);
					if (status === "processed") {
						result.providerProcessed += 1;
						continue;
					}

					if (status === "skipped") {
						result.providerSkipped += 1;
						continue;
					}

					result.providerFailed += 1;
				}
			} finally {
				await stopHeartbeat();
			}
			const expired = await this.repository.reconcileExpiredSubscriptions(this.batchSize);
			result.expiredSubscriptions = expired.expiredSubscriptions;
			result.affectedCustomers = expired.affectedCustomers;
			result.outcome = reconciliationOutcome(result);

			safelyIncrementBillingMetric(this.metrics, "billing_subscription_reconciliation_runs_total", {
				result: result.outcome,
			});
			safelyIncrementBillingMetric(this.metrics, "billing_worker_jobs_total", {
				worker: "subscription_reconciliation",
				result: result.outcome,
			});
			safelyLogInfo(this.logger, "Subscription reconciliation run completed", {
				...result,
				workerId: this.workerId,
			});
			return result;
		} catch (error) {
			safelyIncrementBillingMetric(this.metrics, "billing_subscription_reconciliation_runs_total", {
				result: "failed",
			});
			safelyIncrementBillingMetric(this.metrics, "billing_worker_jobs_total", {
				worker: "subscription_reconciliation",
				result: "failed",
			});
			safelyLogError(this.logger, "Subscription reconciliation run failed", error, {
				workerId: this.workerId,
				result: "failed",
			});
			throw error;
		}
	}

	private startLeaseHeartbeat(
		subscriptions: ProviderSubscriptionReconciliationRow[],
	): () => Promise<void> {
		if (
			subscriptions.length === 0 ||
			this.repository.renewProviderSubscriptionReconciliationLease === undefined
		) {
			return async () => undefined;
		}

		return startLeaseHeartbeat({
			intervalMs: this.leaseHeartbeatIntervalMs,
			heartbeat: async () => {
				await Promise.all(
					subscriptions.map((subscription) =>
						this.repository.renewProviderSubscriptionReconciliationLease?.(
							subscription.project_id,
							subscription.id,
							this.workerId,
						),
					),
				);
			},
			onError: (error) => {
				safelyLogError(this.logger, "Subscription reconciliation lease heartbeat failed", error, {
					workerId: this.workerId,
				});
			},
		});
	}

	private async processSubscription(
		subscription: ProviderSubscriptionReconciliationRow,
	): Promise<"processed" | "skipped" | "failed"> {
		let result: { status: "processed" | "skipped" };

		try {
			const project = await resolveClaimedProjectInstance(this.projectContextResolver, {
				projectInstanceId: subscription.project_id,
				projectInstanceKey: subscription.project_key,
			});
			const provider = await this.providerFor(subscription, project);
			result = await provider.reconcileSubscription(subscription);
		} catch (error) {
			await this.markFailedSafely(subscription, error);
			safelyLogError(this.logger, "Subscription reconciliation provider job failed", error, {
				subscriptionId: subscription.id,
				provider: subscription.provider,
				workerId: this.workerId,
				result: "failed",
			});
			return "failed";
		}

		await this.repository.markProviderSubscriptionReconciliationSucceeded(
			subscription.project_id,
			subscription.id,
			this.workerId,
		);
		return result.status;
	}

	private async providerFor(
		subscription: ProviderSubscriptionReconciliationRow,
		project: ProjectInstanceContext,
	): Promise<SubscriptionReconciliationProvider> {
		const provider = subscription.provider;
		const reconciliationProvider = (await this.providersFor(project, provider))[provider];
		if (reconciliationProvider === null) {
			throw new Error(`Subscription reconciliation provider is not configured: ${provider}`);
		}

		return reconciliationProvider;
	}

	private async providersFor(
		project: ProjectInstanceContext,
		provider: "apple" | "google" | "stripe",
	): Promise<SubscriptionReconciliationProviders> {
		return typeof this.providers === "function"
			? this.providers(project, provider)
			: this.providers;
	}

	private async markFailed(
		subscription: ProviderSubscriptionReconciliationRow,
		error: unknown,
	): Promise<void> {
		const nextAttemptAt = calculateNextAttemptAt({
			attempts: subscription.provider_reconciliation_attempts,
			maxAttempts: this.maxAttempts,
			now: this.now(),
			jitterMs: this.jitterMs(),
		});

		await this.repository.markProviderSubscriptionReconciliationFailed(
			subscription.project_id,
			subscription.id,
			normalizeWorkerError(error),
			nextAttemptAt,
			this.workerId,
		);
	}

	private async markFailedSafely(
		subscription: ProviderSubscriptionReconciliationRow,
		error: unknown,
	): Promise<void> {
		try {
			await this.markFailed(subscription, error);
		} catch (markerError) {
			safelyLogError(
				this.logger,
				"Subscription reconciliation failure marker failed",
				markerError,
				{
					subscriptionId: subscription.id,
					provider: subscription.provider,
					workerId: this.workerId,
					result: "failed",
				},
			);
		}
	}
}

function reconciliationOutcome(
	result: Pick<SubscriptionReconciliationRunResult, "providerClaimed" | "providerFailed">,
): SubscriptionReconciliationRunResult["outcome"] {
	if (result.providerFailed === 0) {
		return "succeeded";
	}
	return result.providerFailed === result.providerClaimed ? "failed" : "partial";
}
