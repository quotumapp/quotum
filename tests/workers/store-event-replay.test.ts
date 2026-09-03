import { describe, expect, it } from "bun:test";
import type { StoreEventReplayJobRow } from "../../src/db/repository";
import type { BillingLogger } from "../../src/observability/logger";
import { type BillingMetrics, createInMemoryBillingMetrics } from "../../src/observability/metrics";
import type { ProjectContext } from "../../src/projects/context";
import { StoreEventReplayWorker } from "../../src/workers/store-event-replay";

const storeEvent = (overrides: Partial<StoreEventReplayJobRow> = {}): StoreEventReplayJobRow => ({
	id: "event_1",
	project_id: "project_1",
	project_key: "voysee",
	provider: "apple",
	channel: "ios",
	external_event_id: "notification_1",
	event_type: "DID_RENEW",
	customer_id: null,
	store_product_id: "premium_monthly",
	transaction_id: "200000000000001",
	purchase_kind: "subscription",
	processing_status: "processing",
	processing_error: null,
	attempts: 0,
	next_attempt_at: null,
	raw_payload: {},
	processed_at: null,
	locked_at: "2026-05-31T00:00:00.000Z",
	locked_by: "worker-a",
	created_at: "2026-05-31T00:00:00.000Z",
	updated_at: "2026-05-31T00:00:00.000Z",
	...overrides,
});

function createRepository(
	events: StoreEventReplayJobRow[],
	options: { succeedError?: Error; failError?: Error } = {},
) {
	const calls: unknown[] = [];

	return {
		calls,
		repository: {
			claimStoreEventReplayJobs: async (workerId: string, limit: number) => {
				calls.push({ method: "claimStoreEventReplayJobs", workerId, limit });
				return events;
			},
			claimStoreEventReplayJobById: async (
				workerId: string,
				project: ProjectContext,
				eventId: string,
			) => {
				calls.push({ method: "claimStoreEventReplayJobById", workerId, project, eventId });
				const event = events.find((candidate) => candidate.id === eventId);
				if (event === undefined) {
					throw new Error(`missing event ${eventId}`);
				}
				return event;
			},
			markStoreEventReplayJobSucceeded: async (
				_projectId: string,
				eventId: string,
				workerId: string,
			) => {
				calls.push({ method: "markStoreEventReplayJobSucceeded", eventId, workerId });
				if (options.succeedError !== undefined) {
					throw options.succeedError;
				}
			},
			markStoreEventReplayJobFailed: async (
				_projectId: string,
				eventId: string,
				error: string,
				nextAttemptAt: Date | null,
				workerId: string,
			) => {
				calls.push({
					method: "markStoreEventReplayJobFailed",
					eventId,
					error,
					nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
					workerId,
				});
				if (options.failError !== undefined) {
					throw options.failError;
				}
			},
		},
	};
}

function createRecordingLogger() {
	const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const errors: Array<{ message: string; error: unknown; context?: Record<string, unknown> }> = [];
	const logger: BillingLogger = {
		info(message, context) {
			infos.push({ message, context });
		},
		warn() {},
		error(message, error, context) {
			errors.push({ message, error, context });
		},
	};

	return { logger, infos, errors };
}

function createThrowingLogger(): BillingLogger {
	return {
		info() {
			throw new Error("logger info failed");
		},
		warn() {
			throw new Error("logger warn failed");
		},
		error() {
			throw new Error("logger error failed");
		},
	};
}

function createThrowingMetrics(): BillingMetrics {
	return {
		increment() {
			throw new Error("metrics increment failed");
		},
		renderPrometheus() {
			throw new Error("metrics render failed");
		},
	};
}

describe("StoreEventReplayWorker", () => {
	it("processes claimed events and marks them succeeded", async () => {
		const events = [storeEvent()];
		const { calls, repository } = createRepository(events);
		const providerCalls: StoreEventReplayJobRow[] = [];
		const metrics = createInMemoryBillingMetrics();
		const { logger, infos } = createRecordingLogger();
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async (event) => {
						providerCalls.push(event);
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 1, processed: 1, ignored: 0, retryable: 0, failed: 0 });
		expect(providerCalls).toEqual(events);
		expect(calls).toEqual([
			{ method: "claimStoreEventReplayJobs", workerId: "worker-a", limit: 5 },
			{
				method: "markStoreEventReplayJobSucceeded",
				eventId: "event_1",
				workerId: "worker-a",
			},
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_store_event_replay_jobs_total{provider="apple",result="processed"} 1',
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_worker_jobs_total{project="voysee",provider="apple",result="processed",worker="store_event_replay"} 1',
		);
		expect(infos).toEqual([
			{
				message: "Store event replay run completed",
				context: {
					claimed: 1,
					processed: 1,
					ignored: 0,
					retryable: 0,
					failed: 0,
					workerId: "worker-a",
				},
			},
		]);
	});

	it("selects replay providers from the claimed row project key", async () => {
		const events = [
			storeEvent({ id: "event_voysee", project_key: "voysee" }),
			storeEvent({ id: "event_wiseley", project_id: "project_2", project_key: "wiseley" }),
		];
		const providerCalls: string[] = [];
		const { repository } = createRepository(events);
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: (projectKey) => ({
				apple: {
					replayStoreEvent: async (event) => {
						providerCalls.push(`${projectKey}:${event.id}`);
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			}),
		});

		await worker.runOnce();

		expect(providerCalls).toEqual(["voysee:event_voysee", "wiseley:event_wiseley"]);
	});

	it("does not flip successful jobs when observability fails", async () => {
		const events = [storeEvent()];
		const { calls, repository } = createRepository(events);
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async () => ({ status: "processed" }),
				},
				google: null,
				stripe: null,
			},
			metrics: createThrowingMetrics(),
			logger: createThrowingLogger(),
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 1, processed: 1, ignored: 0, retryable: 0, failed: 0 });
		expect(calls).toEqual([
			{ method: "claimStoreEventReplayJobs", workerId: "worker-a", limit: 5 },
			{
				method: "markStoreEventReplayJobSucceeded",
				eventId: "event_1",
				workerId: "worker-a",
			},
		]);
	});

	it("marks ignored provider results succeeded and increments ignored", async () => {
		const { calls, repository } = createRepository([storeEvent()]);
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async () => ({
						status: "ignored",
						reason: "apple_store_event_not_recordable",
					}),
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 1, processed: 0, ignored: 1, retryable: 0, failed: 0 });
		expect(calls).toContainEqual({
			method: "markStoreEventReplayJobSucceeded",
			eventId: "event_1",
			workerId: "worker-a",
		});
	});

	it("does not mark processed events failed when success finalization throws", async () => {
		const finalizationError = new Error("success marker timed out");
		const { calls, repository } = createRepository([storeEvent()], {
			succeedError: finalizationError,
		});
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async () => ({ status: "processed" }),
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
		});

		await expect(worker.runOnce()).rejects.toThrow("success marker timed out");
		expect(calls).toEqual([
			{ method: "claimStoreEventReplayJobs", workerId: "worker-a", limit: 5 },
			{
				method: "markStoreEventReplayJobSucceeded",
				eventId: "event_1",
				workerId: "worker-a",
			},
		]);
	});

	it("marks retryable provider results failed with a retry timestamp", async () => {
		const { calls, repository } = createRepository([storeEvent({ attempts: 1 })]);
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async () => ({
						status: "retryable",
						reason: "apple_customer_unresolved",
					}),
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 1, processed: 0, ignored: 0, retryable: 1, failed: 0 });
		expect(calls).toContainEqual({
			method: "markStoreEventReplayJobFailed",
			eventId: "event_1",
			error: "apple_customer_unresolved",
			nextAttemptAt: "2026-05-31T00:02:00.000Z",
			workerId: "worker-a",
		});
	});

	it("marks missing or unsupported providers failed with normalized errors", async () => {
		const events = [
			storeEvent({ id: "event_google", provider: "google", channel: "android" }),
			storeEvent({ id: "event_unknown", provider: "unknown" as "apple" }),
		];
		const { calls, repository } = createRepository(events);
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: { apple: null, google: null, stripe: null },
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 2, processed: 0, ignored: 0, retryable: 0, failed: 2 });
		expect(calls).toContainEqual({
			method: "markStoreEventReplayJobFailed",
			eventId: "event_google",
			error: "Store event replay provider is not configured: google",
			nextAttemptAt: "2026-05-31T00:01:00.000Z",
			workerId: "worker-a",
		});
		expect(calls).toContainEqual({
			method: "markStoreEventReplayJobFailed",
			eventId: "event_unknown",
			error: "Unsupported store event replay provider: unknown",
			nextAttemptAt: "2026-05-31T00:01:00.000Z",
			workerId: "worker-a",
		});
	});

	it("marks final attempts failed without a next attempt timestamp", async () => {
		const { calls, repository } = createRepository([storeEvent({ attempts: 2 })]);
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async () => {
						throw new Error("provider unavailable");
					},
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 1, processed: 0, ignored: 0, retryable: 0, failed: 1 });
		expect(calls).toContainEqual({
			method: "markStoreEventReplayJobFailed",
			eventId: "event_1",
			error: "provider unavailable",
			nextAttemptAt: null,
			workerId: "worker-a",
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_store_event_replay_jobs_total{provider="apple",result="failed"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Store event replay job failed");
		expect(errors[0]?.context).toEqual({
			eventId: "event_1",
			provider: "apple",
			workerId: "worker-a",
			result: "failed",
		});
	});

	it("continues processing remaining events when marking a failed event throws", async () => {
		const events = [storeEvent({ id: "event_failed" }), storeEvent({ id: "event_later" })];
		const { calls, repository } = createRepository(events, {
			failError: new Error("failure marker unavailable"),
		});
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async (event) => {
						if (event.id === "event_failed") {
							throw new Error("provider unavailable");
						}
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 2, processed: 1, ignored: 0, retryable: 0, failed: 1 });
		expect(calls).toEqual([
			{ method: "claimStoreEventReplayJobs", workerId: "worker-a", limit: 5 },
			{
				method: "markStoreEventReplayJobFailed",
				eventId: "event_failed",
				error: "provider unavailable",
				nextAttemptAt: "2026-05-31T00:01:00.000Z",
				workerId: "worker-a",
			},
			{
				method: "markStoreEventReplayJobSucceeded",
				eventId: "event_later",
				workerId: "worker-a",
			},
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_store_event_replay_jobs_total{provider="apple",result="failed"} 1',
		);
		expect(errors.map((entry) => entry.message)).toEqual([
			"Store event replay failure marker failed",
			"Store event replay job failed",
		]);
	});

	it("runOne claims by event id and uses the same dispatch semantics", async () => {
		const { calls, repository } = createRepository([storeEvent({ id: "event_target" })]);
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository,
			providers: {
				apple: {
					replayStoreEvent: async () => ({ status: "processed" }),
				},
				google: null,
				stripe: null,
			},
		});

		const project = { projectKey: "wiseley" };
		const result = await worker.runOne(project, "event_target");

		expect(result).toEqual({ eventId: "event_target", status: "processed" });
		expect(calls).toEqual([
			{
				method: "claimStoreEventReplayJobById",
				workerId: "worker-a",
				project,
				eventId: "event_target",
			},
			{
				method: "markStoreEventReplayJobSucceeded",
				eventId: "event_target",
				workerId: "worker-a",
			},
		]);
	});

	it("renews claimed leases while a slow provider call is running", async () => {
		const events = [storeEvent()];
		const { repository } = createRepository(events);
		const renewed: string[] = [];
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository: {
				...repository,
				renewStoreEventReplayJobLease: async (projectId, eventId, workerId) => {
					renewed.push(`${projectId}:${eventId}:${workerId}`);
				},
			},
			providers: {
				apple: {
					replayStoreEvent: async () => {
						await Bun.sleep(20);
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			},
			leaseHeartbeatIntervalMs: 5,
		});

		await worker.runOnce();

		expect(renewed).toContain("project_1:event_1:worker-a");
	});

	it("records run failures when events cannot be claimed", async () => {
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new StoreEventReplayWorker({
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository: {
				claimStoreEventReplayJobs: async () => {
					throw new Error("database unavailable");
				},
				claimStoreEventReplayJobById: async () => {
					throw new Error("unused");
				},
				markStoreEventReplayJobSucceeded: async () => undefined,
				markStoreEventReplayJobFailed: async () => undefined,
			},
			providers: { apple: null, google: null, stripe: null },
			metrics,
			logger,
		});

		await expect(worker.runOnce()).rejects.toThrow("database unavailable");
		expect(metrics.renderPrometheus()).toContain(
			'billing_store_event_replay_jobs_total{provider="unknown",result="failed"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Store event replay run failed");
		expect(errors[0]?.context).toEqual({
			provider: "unknown",
			workerId: "worker-a",
			result: "failed",
		});
	});
});
