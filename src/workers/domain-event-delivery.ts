import type {
	ClaimedWebhookDelivery,
	WebhookDeliveryFailure,
} from "../db/repository/domain-events";
import { sendWebhook, type WebhookAttemptResult, type WebhookPost } from "../events/delivery";
import type { WebhookSecretSealer } from "../events/secret-sealer";
import type { DomainEventEnvelope } from "../events/types";
import {
	type BillingLogger,
	createNoopBillingLogger,
	safelyLogError,
	safelyLogInfo,
	safelyLogWarn,
} from "../observability/logger";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectInstanceContextResolver } from "../projects/context";
import { calculateNextAttemptAt, normalizeWorkerError } from "./backoff";
import { resolveClaimedProjectInstance } from "./project-context";

export interface DomainEventDeliveryStore {
	dispatchEvents(limit: number): Promise<number>;
	claimDeliveries(workerId: string, limit: number): Promise<ClaimedWebhookDelivery[]>;
	markDeliverySucceeded(
		projectId: string,
		deliveryId: string,
		workerId: string,
		statusCode: number,
	): Promise<void>;
	markDeliveryFailed(
		projectId: string,
		deliveryId: string,
		workerId: string,
		failure: WebhookDeliveryFailure,
	): Promise<{ endpointDisabled: boolean }>;
	deleteExpiredEvents(retentionDays: number, limit: number): Promise<number>;
}

export interface DomainEventDeliveryWorkerOptions {
	workerId: string;
	maxAttempts: number;
	retentionDays: number;
	batchSize: number;
	concurrency?: number;
	store: DomainEventDeliveryStore;
	/** Resolved on first use, so a process with no endpoints never needs the secrets key. */
	sealer: () => WebhookSecretSealer;
	post: WebhookPost;
	projectContextResolver: ProjectInstanceContextResolver;
	now?: () => Date;
	jitterMs?: () => number;
	logger?: BillingLogger;
	metrics?: BillingMetrics;
}

export interface DomainEventDeliveryRunResult {
	dispatched: number;
	claimed: number;
	succeeded: number;
	failed: number;
	expired: number;
}

/** A receiver's `Retry-After` is honored up to the longest backoff delay. */
const maxRetryAfterSeconds = 24 * 60 * 60;
/** Retention deletes at most this often; the sweep is a bounded index scan. */
const retentionIntervalMs = 10 * 60_000;

/**
 * Delivers outbound events. Each run fans newly recorded events out to their endpoints, sends the
 * deliveries that are due with Standard Webhooks signatures, and now and then deletes events past
 * retention. Delivery is at least once and unordered: a receiver deduplicates on `webhook-id`.
 */
export class DomainEventDeliveryWorker {
	private readonly options: Required<
		Omit<DomainEventDeliveryWorkerOptions, "concurrency" | "logger" | "metrics">
	> & { concurrency: number; logger: BillingLogger; metrics: BillingMetrics };
	private lastRetentionAt = Number.NEGATIVE_INFINITY;

	constructor(options: DomainEventDeliveryWorkerOptions) {
		const concurrency = options.concurrency ?? options.batchSize;
		if (!Number.isInteger(concurrency) || concurrency <= 0) {
			throw new Error("domain event delivery concurrency must be greater than zero");
		}
		this.options = {
			now: () => new Date(),
			jitterMs: () => Math.floor(Math.random() * 1000),
			...options,
			concurrency,
			logger: options.logger ?? createNoopBillingLogger(),
			metrics: options.metrics ?? createNoopBillingMetrics(),
		};
	}

	async runOnce(): Promise<DomainEventDeliveryRunResult> {
		const { store, workerId, batchSize, logger } = this.options;
		try {
			const dispatched = await store.dispatchEvents(batchSize * 4);
			const deliveries = await store.claimDeliveries(workerId, batchSize);
			const counts = await this.deliverAll(deliveries);
			const expired = await this.deleteExpiredEvents();
			const result = { dispatched, claimed: deliveries.length, ...counts, expired };
			if (dispatched + deliveries.length + expired > 0) {
				safelyLogInfo(logger, "Domain event delivery run completed", { ...result, workerId });
			}
			return result;
		} catch (error) {
			this.recordWorkerMetric("failed");
			safelyLogError(logger, "Domain event delivery run failed", error, {
				workerId,
				result: "failed",
			});
			throw error;
		}
	}

	private async deleteExpiredEvents(): Promise<number> {
		const now = this.options.now().getTime();
		if (now - this.lastRetentionAt < retentionIntervalMs) return 0;
		this.lastRetentionAt = now;
		return await this.options.store.deleteExpiredEvents(this.options.retentionDays, 1000);
	}

	private async deliverAll(
		deliveries: ClaimedWebhookDelivery[],
	): Promise<{ succeeded: number; failed: number }> {
		let next = 0;
		let succeeded = 0;
		let failed = 0;
		await Promise.all(
			Array.from({ length: Math.min(this.options.concurrency, deliveries.length) }, async () => {
				for (;;) {
					const delivery = deliveries[next];
					next += 1;
					if (delivery === undefined) return;
					if (await this.deliver(delivery)) succeeded += 1;
					else failed += 1;
				}
			}),
		);
		return { succeeded, failed };
	}

	private async deliver(delivery: ClaimedWebhookDelivery): Promise<boolean> {
		let result: WebhookAttemptResult;
		try {
			result = await sendWebhook(this.options.post, await this.request(delivery), this.options.now);
		} catch (error) {
			result = {
				ok: false,
				statusCode: null,
				error: normalizeWorkerError(error),
				retryAfterSeconds: null,
			};
		}
		try {
			if (result.ok) {
				await this.options.store.markDeliverySucceeded(
					delivery.projectId,
					delivery.id,
					this.options.workerId,
					result.statusCode,
				);
				this.recordDeliveryMetric("succeeded", `HTTP_${result.statusCode}`);
				this.recordWorkerMetric("succeeded");
				return true;
			}
			const { endpointDisabled } = await this.options.store.markDeliveryFailed(
				delivery.projectId,
				delivery.id,
				this.options.workerId,
				{
					error: result.error,
					statusCode: result.statusCode,
					nextAttemptAt: this.nextAttemptAt(delivery.attempts, result.retryAfterSeconds),
				},
			);
			this.recordDeliveryMetric(
				"failed",
				result.statusCode === null ? "NETWORK" : `HTTP_${result.statusCode}`,
			);
			this.recordWorkerMetric("failed");
			if (endpointDisabled) {
				// Ids only: the URL belongs to the merchant's configuration, not to logs.
				safelyLogWarn(this.options.logger, "Webhook endpoint disabled after failing deliveries", {
					projectKey: delivery.projectKey,
					endpointId: delivery.endpointId,
				});
			}
			return false;
		} catch (error) {
			// The lease was lost or the event was erased meanwhile; the claim's stale reclaim or the
			// erasure decides what happens to the row next.
			this.recordWorkerMetric("failed");
			safelyLogError(this.options.logger, "Webhook delivery marker failed", error, {
				deliveryId: delivery.id,
				workerId: this.options.workerId,
				result: "failed",
			});
			return false;
		}
	}

	private async request(delivery: ClaimedWebhookDelivery) {
		const project = await resolveClaimedProjectInstance(this.options.projectContextResolver, {
			projectInstanceId: delivery.projectId,
			projectInstanceKey: delivery.projectKey,
		});
		const sealer = this.options.sealer();
		const scope = { projectId: delivery.projectId, endpointId: delivery.endpointId };
		const secrets = [
			sealer.open(delivery.secretEnvelope, { ...scope, generation: delivery.secretGeneration }),
			...(delivery.previousSecretEnvelope === null
				? []
				: [
						sealer.open(delivery.previousSecretEnvelope, {
							...scope,
							generation: delivery.secretGeneration - 1,
						}),
					]),
		];
		const envelope: DomainEventEnvelope = {
			id: delivery.eventId,
			type: delivery.type,
			version: 1,
			createdAt: delivery.createdAt,
			occurredAt: delivery.occurredAt,
			environment: project.environment,
			projectKey: project.projectInstanceKey,
			...(delivery.billingAccountId === null
				? {}
				: { billingAccountId: delivery.billingAccountId }),
			data: delivery.data,
		};
		return {
			url: delivery.url,
			webhookId: delivery.eventId,
			body: JSON.stringify(envelope),
			secrets,
		};
	}

	private nextAttemptAt(attempts: number, retryAfterSeconds: number | null): Date | null {
		const now = this.options.now();
		const backoff = calculateNextAttemptAt({
			attempts,
			maxAttempts: this.options.maxAttempts,
			now,
			jitterMs: this.options.jitterMs(),
		});
		if (backoff === null || retryAfterSeconds === null) return backoff;
		const requested = new Date(
			now.getTime() + Math.min(retryAfterSeconds, maxRetryAfterSeconds) * 1000,
		);
		return requested > backoff ? requested : backoff;
	}

	/** Public on `/metrics`, so the series carries no project, endpoint or event identity. */
	private recordDeliveryMetric(result: "succeeded" | "failed", code: string): void {
		safelyIncrementBillingMetric(this.options.metrics, "billing_event_delivery_total", {
			result,
			code,
		});
	}

	private recordWorkerMetric(result: "succeeded" | "failed"): void {
		safelyIncrementBillingMetric(this.options.metrics, "billing_worker_jobs_total", {
			worker: "domain_event_delivery",
			result,
		});
	}
}
