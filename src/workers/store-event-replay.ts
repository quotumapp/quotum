import type { StoreEventReplayJobRow } from "../db/repository";
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

export interface StoreEventReplayProvider {
	replayStoreEvent(event: StoreEventReplayJobRow): Promise<StoreEventReplayProviderResult>;
}

export type StoreEventReplayProviderResult =
	| { status: "processed" }
	| { status: "ignored"; reason: string }
	| { status: "retryable"; reason: string };

export interface StoreEventReplayProviders {
	apple: StoreEventReplayProvider | null;
	google: StoreEventReplayProvider | null;
	stripe: StoreEventReplayProvider | null;
}

export type StoreEventReplayProviderSelector = (
	project: ProjectInstanceContext,
	provider: "apple" | "google" | "stripe",
) => StoreEventReplayProviders | Promise<StoreEventReplayProviders>;

export interface StoreEventReplayRunResult {
	claimed: number;
	processed: number;
	ignored: number;
	retryable: number;
	failed: number;
}

export interface StoreEventReplayOneResult {
	eventId: string;
	status: "processed" | "ignored" | "retryable" | "failed";
}

export interface StoreEventReplayRepository {
	claimStoreEventReplayJobs(workerId: string, limit: number): Promise<StoreEventReplayJobRow[]>;

	claimStoreEventReplayJobById(
		workerId: string,
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<StoreEventReplayJobRow>;

	markStoreEventReplayJobSucceeded(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void>;

	markStoreEventReplayJobFailed(
		projectId: string,
		eventId: string,
		errorMessage: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void>;
	renewStoreEventReplayJobLease?(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void>;
}

export interface StoreEventReplayWorkerOptions {
	workerId: string;
	maxAttempts: number;
	batchSize: number;
	repository: StoreEventReplayRepository;
	providers: StoreEventReplayProviders | StoreEventReplayProviderSelector;
	projectContextResolver: ProjectInstanceContextResolver;
	now?: () => Date;
	jitterMs?: () => number;
	logger?: BillingLogger;
	metrics?: BillingMetrics;
	leaseHeartbeatIntervalMs?: number;
}

export class StoreEventReplayWorker {
	private readonly workerId: string;
	private readonly maxAttempts: number;
	private readonly batchSize: number;
	private readonly repository: StoreEventReplayRepository;
	private readonly providers: StoreEventReplayProviders | StoreEventReplayProviderSelector;
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
		repository,
		providers,
		projectContextResolver,
		now = () => new Date(),
		jitterMs = () => Math.floor(Math.random() * 1000),
		logger = createNoopBillingLogger(),
		metrics = createNoopBillingMetrics(),
		leaseHeartbeatIntervalMs = 60_000,
	}: StoreEventReplayWorkerOptions) {
		this.workerId = workerId;
		this.maxAttempts = maxAttempts;
		this.batchSize = batchSize;
		this.repository = repository;
		this.providers = providers;
		this.projectContextResolver = projectContextResolver;
		this.now = now;
		this.jitterMs = jitterMs;
		this.logger = logger;
		this.metrics = metrics;
		this.leaseHeartbeatIntervalMs = leaseHeartbeatIntervalMs;
	}

	async runOnce(): Promise<StoreEventReplayRunResult> {
		try {
			const events = await this.repository.claimStoreEventReplayJobs(this.workerId, this.batchSize);
			const result: StoreEventReplayRunResult = {
				claimed: events.length,
				processed: 0,
				ignored: 0,
				retryable: 0,
				failed: 0,
			};

			const stopHeartbeat = this.startLeaseHeartbeat(events);
			try {
				for (const event of events) {
					const status = await this.processEvent(event);
					result[status] += 1;
				}
			} finally {
				await stopHeartbeat();
			}

			safelyLogInfo(this.logger, "Store event replay run completed", {
				...result,
				workerId: this.workerId,
			});
			return result;
		} catch (error) {
			safelyIncrementBillingMetric(this.metrics, "billing_store_event_replay_jobs_total", {
				provider: "unknown",
				result: "failed",
			});
			safelyLogError(this.logger, "Store event replay run failed", error, {
				provider: "unknown",
				workerId: this.workerId,
				result: "failed",
			});
			throw error;
		}
	}

	async runOne(
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<StoreEventReplayOneResult> {
		const event = await this.repository.claimStoreEventReplayJobById(
			this.workerId,
			project,
			eventId,
		);
		const stopHeartbeat = this.startLeaseHeartbeat([event]);
		const status = await this.processEvent(event, project).finally(stopHeartbeat);
		return { eventId: event.id, status };
	}

	private startLeaseHeartbeat(events: StoreEventReplayJobRow[]): () => Promise<void> {
		if (events.length === 0 || this.repository.renewStoreEventReplayJobLease === undefined) {
			return async () => undefined;
		}

		return startLeaseHeartbeat({
			intervalMs: this.leaseHeartbeatIntervalMs,
			heartbeat: async () => {
				await Promise.all(
					events.map((event) =>
						this.repository.renewStoreEventReplayJobLease?.(
							event.project_id,
							event.id,
							this.workerId,
						),
					),
				);
			},
			onError: (error) => {
				safelyLogError(this.logger, "Store event replay lease heartbeat failed", error, {
					workerId: this.workerId,
				});
			},
		});
	}

	private async processEvent(
		event: StoreEventReplayJobRow,
		resolvedProject?: ProjectInstanceContext,
	): Promise<"processed" | "ignored" | "retryable" | "failed"> {
		let result: StoreEventReplayProviderResult;

		try {
			const project =
				resolvedProject ??
				(await resolveClaimedProjectInstance(this.projectContextResolver, {
					projectInstanceId: event.project_id,
					projectInstanceKey: event.project_key,
				}));
			assertClaimedProjectIdentity(project, event.project_id, event.project_key);
			const provider = await this.providerFor(event, project);
			result = await provider.replayStoreEvent(event);
		} catch (error) {
			await this.markFailedSafely(event, error);
			this.recordEventResult(event, "failed", error);
			return "failed";
		}

		if (result.status === "retryable") {
			await this.markFailedSafely(event, result.reason);
			this.recordEventResult(event, "retryable", new Error(result.reason));
			return "retryable";
		}

		await this.repository.markStoreEventReplayJobSucceeded(
			event.project_id,
			event.id,
			this.workerId,
		);
		this.recordEventResult(event, result.status, undefined);
		return result.status;
	}

	private recordEventResult(
		event: StoreEventReplayJobRow,
		status: "processed" | "ignored" | "retryable" | "failed",
		failureError: unknown,
	): void {
		safelyIncrementBillingMetric(this.metrics, "billing_store_event_replay_jobs_total", {
			provider: event.provider,
			result: status,
		});
		safelyIncrementBillingMetric(this.metrics, "billing_worker_jobs_total", {
			worker: "store_event_replay",
			project: event.project_key,
			provider: event.provider,
			result: status,
		});

		if (failureError !== undefined) {
			safelyLogError(this.logger, "Store event replay job failed", failureError, {
				eventId: event.id,
				provider: event.provider,
				workerId: this.workerId,
				result: status,
			});
		}
	}

	private async providerFor(
		event: StoreEventReplayJobRow,
		project: ProjectInstanceContext,
	): Promise<StoreEventReplayProvider> {
		const provider = event.provider;
		if (provider !== "apple" && provider !== "google" && provider !== "stripe") {
			throw new Error(`Unsupported store event replay provider: ${provider}`);
		}

		const replayProvider = (await this.providersFor(project, provider))[provider];
		if (replayProvider === null) {
			throw new Error(`Store event replay provider is not configured: ${provider}`);
		}

		return replayProvider;
	}

	private async providersFor(
		project: ProjectInstanceContext,
		provider: "apple" | "google" | "stripe",
	): Promise<StoreEventReplayProviders> {
		return typeof this.providers === "function"
			? this.providers(project, provider)
			: this.providers;
	}

	private async markFailed(event: StoreEventReplayJobRow, error: unknown): Promise<void> {
		const nextAttemptAt = calculateNextAttemptAt({
			attempts: event.attempts,
			maxAttempts: this.maxAttempts,
			now: this.now(),
			jitterMs: this.jitterMs(),
		});

		await this.repository.markStoreEventReplayJobFailed(
			event.project_id,
			event.id,
			normalizeWorkerError(error),
			nextAttemptAt,
			this.workerId,
		);
	}

	private async markFailedSafely(event: StoreEventReplayJobRow, error: unknown): Promise<void> {
		try {
			await this.markFailed(event, error);
		} catch (markerError) {
			safelyLogError(this.logger, "Store event replay failure marker failed", markerError, {
				eventId: event.id,
				provider: event.provider,
				workerId: this.workerId,
				result: "failed",
			});
		}
	}
}

function assertClaimedProjectIdentity(
	project: ProjectInstanceContext,
	projectInstanceId: string,
	projectInstanceKey: string,
): void {
	if (
		project.projectInstanceId !== projectInstanceId ||
		project.projectInstanceKey !== projectInstanceKey
	) {
		throw new Error("Claimed work project identity does not match the platform project instance");
	}
}
