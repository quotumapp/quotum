import { describe, expect, it } from "bun:test";
import type { ProjectionSyncJobRow } from "../../src/db/repository";
import type { BillingLogger } from "../../src/observability/logger";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { ProjectionSyncWorker } from "../../src/workers/projection-sync";
import { createDeferred } from "../helpers/deferred";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const job = {
	id: "job_1",
	project_id: "project_1",
	project_key: "voysee",
	customer_id: "customer_1",
	idempotency_key: "stripe:txn_1:projection",
	reason: "provider_webhook",
	payload: {
		billingAccountId: "user_1",
		generatedAt: "2026-05-31T00:00:00.000Z",
		balances: [],
		reason: "provider_webhook",
		entitlements: {
			billingAccountId: "user_1",
			generatedAt: "2026-05-31T00:00:00.000Z",
			entitlements: [],
		},
	},
	status: "processing",
	attempts: 0,
	last_error: null,
	reprojection_requested: false,
	next_attempt_at: null,
	locked_at: "2026-05-31T00:00:00.000Z",
	locked_by: "worker-a",
	created_at: "2026-05-31T00:00:00.000Z",
	updated_at: "2026-05-31T00:00:00.000Z",
} satisfies ProjectionSyncJobRow;
const workerProjectResolver = projectContextResolver({
	contexts: [projectInstanceContext("voysee", { projectInstanceId: job.project_id })],
});

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

describe("ProjectionSyncWorker", () => {
	it("syncs claimed jobs and marks them succeeded", async () => {
		const calls: string[] = [];
		const metrics = createInMemoryBillingMetrics();
		const { logger, infos } = createRecordingLogger();
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			concurrency: 1,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () => [job],
				markProjectionSyncJobSucceeded: async (projectId, jobId, workerId) => {
					calls.push(`succeeded:${projectId}:${jobId}:${workerId}`);
				},
				markProjectionSyncJobFailed: async () => {
					throw new Error("should not fail");
				},
			},
			delivery: {
				deliver: async ({ billingAccountId }) => {
					calls.push(`sync:${billingAccountId}`);
				},
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(calls).toEqual(["sync:user_1", "succeeded:project_1:job_1:worker-a"]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_projection_sync_jobs_total{result="succeeded"} 1',
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_worker_jobs_total{project="voysee",result="succeeded",worker="projection_sync"} 1',
		);
		expect(infos).toEqual([
			{
				message: "Projection sync run completed",
				context: { claimed: 1, succeeded: 1, failed: 0, workerId: "worker-a" },
			},
		]);
	});

	it("delivers claimed jobs with bounded concurrency", async () => {
		const releaseDeliveries = createDeferred<void>();
		const bothStarted = createDeferred<void>();
		const started: string[] = [];
		let activeDeliveries = 0;
		let maxActiveDeliveries = 0;
		const jobs = [
			{ ...job, id: "job_1" },
			{ ...job, id: "job_2", idempotency_key: "stripe:txn_2:projection" },
			{ ...job, id: "job_3", idempotency_key: "stripe:txn_3:projection" },
		];
		const succeeded: string[] = [];
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 3,
			concurrency: 2,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () => jobs,
				markProjectionSyncJobSucceeded: async (_projectId, jobId) => {
					succeeded.push(jobId);
				},
				markProjectionSyncJobFailed: async () => {
					throw new Error("should not fail");
				},
			},
			delivery: {
				deliver: async ({ jobId }) => {
					started.push(jobId);
					activeDeliveries += 1;
					maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
					if (started.length === 2) {
						bothStarted.resolve();
					}
					await releaseDeliveries.promise;
					activeDeliveries -= 1;
				},
			},
		});

		const run = worker.runOnce();
		let assertionError: unknown;
		try {
			await bothStarted.promise;
			expect(started).toEqual(["job_1", "job_2"]);
			expect(maxActiveDeliveries).toBe(2);
		} catch (error) {
			assertionError = error;
		} finally {
			releaseDeliveries.resolve();
		}
		const result = await run;

		if (assertionError !== undefined) {
			throw assertionError;
		}
		expect(result).toEqual({ claimed: 3, succeeded: 3, failed: 0 });
		expect(succeeded.sort()).toEqual(["job_1", "job_2", "job_3"]);
	});

	it("forwards projection job identity and purchase context to delivery", async () => {
		const synced: unknown[] = [];
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			concurrency: 1,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () => [
					{
						...job,
						idempotency_key: "google:purchase_token_1:purchase_verified",
						payload: {
							...job.payload,
							purchase: {
								provider: "google",
								channel: "android",
								purchaseKind: "consumable",
								transactionId: "purchase_token_1",
								productKey: "echo_credits_10",
								creditAmount: 10,
								totalCreditAmount: 20,
								quantity: 2,
								purchasedAt: "2026-05-31T00:00:00.000Z",
							} as const,
						},
					},
				],
				markProjectionSyncJobSucceeded: async () => undefined,
				markProjectionSyncJobFailed: async () => {
					throw new Error("should not fail");
				},
			},
			delivery: {
				deliver: async (input) => {
					synced.push(input);
				},
			},
		});

		await worker.runOnce();

		expect(synced).toEqual([
			{
				schemaVersion: 1,
				projectKey: "voysee",
				jobId: "job_1",
				idempotencyKey: "google:purchase_token_1:purchase_verified",
				billingAccountId: "user_1",
				generatedAt: job.payload.generatedAt,
				balances: [],
				reason: "provider_webhook",
				entitlements: job.payload.entitlements,
				purchase: {
					provider: "google",
					channel: "android",
					purchaseKind: "consumable",
					transactionId: "purchase_token_1",
					productKey: "echo_credits_10",
					creditAmount: 10,
					totalCreditAmount: 20,
					quantity: 2,
					purchasedAt: "2026-05-31T00:00:00.000Z",
				},
			},
		]);
	});

	it("forwards reversal context to delivery", async () => {
		const synced: unknown[] = [];
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () => [
					{
						...job,
						idempotency_key: "stripe:refund_re_1:provider_webhook",
						payload: {
							...job.payload,
							reversal: {
								provider: "stripe",
								channel: "web",
								reason: "refund",
								transactionId: "re_1",
								originalTransactionId: "pi_1",
								productKey: "echo_credits_10",
								creditAmount: 10,
								totalCreditAmount: 10,
								quantity: 1,
								reversedAt: "2026-05-31T00:00:00.000Z",
							} as const,
						},
					},
				],
				markProjectionSyncJobSucceeded: async () => undefined,
				markProjectionSyncJobFailed: async () => {
					throw new Error("should not fail");
				},
			},
			delivery: {
				deliver: async (input) => {
					synced.push(input);
				},
			},
		});

		await worker.runOnce();

		expect(synced).toEqual([
			{
				schemaVersion: 1,
				projectKey: "voysee",
				jobId: "job_1",
				idempotencyKey: "stripe:refund_re_1:provider_webhook",
				billingAccountId: "user_1",
				generatedAt: job.payload.generatedAt,
				balances: [],
				reason: "provider_webhook",
				entitlements: job.payload.entitlements,
				reversal: {
					provider: "stripe",
					channel: "web",
					reason: "refund",
					transactionId: "re_1",
					originalTransactionId: "pi_1",
					productKey: "echo_credits_10",
					creditAmount: 10,
					totalCreditAmount: 10,
					quantity: 1,
					reversedAt: "2026-05-31T00:00:00.000Z",
				},
			},
		]);
	});

	it("marks failed jobs with a retry timestamp", async () => {
		const calls: unknown[] = [];
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () => [job],
				markProjectionSyncJobSucceeded: async () => {
					throw new Error("should not succeed");
				},
				markProjectionSyncJobFailed: async (projectId, jobId, error, nextAttemptAt, workerId) => {
					calls.push({
						projectId,
						jobId,
						error,
						nextAttemptAt: nextAttemptAt?.toISOString(),
						workerId,
					});
				},
			},
			delivery: {
				deliver: async () => {
					throw new Error("delivery failed");
				},
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
		expect(calls).toEqual([
			{
				projectId: "project_1",
				jobId: "job_1",
				error: "delivery failed",
				nextAttemptAt: "2026-05-31T00:01:00.000Z",
				workerId: "worker-a",
			},
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_projection_sync_jobs_total{result="failed"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Projection sync job failed");
		expect(errors[0]?.context).toEqual({
			jobId: "job_1",
			workerId: "worker-a",
			result: "failed",
		});
	});

	it("continues processing remaining jobs when marking a failed job throws", async () => {
		const calls: string[] = [];
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const failedJob: ProjectionSyncJobRow = { ...job, id: "job_failed" };
		const laterJob: ProjectionSyncJobRow = {
			...job,
			id: "job_later",
			customer_id: "customer_2",
			idempotency_key: "stripe:txn_2:projection",
			payload: {
				...job.payload,
				billingAccountId: "user_2",
				entitlements: {
					...job.payload.entitlements,
					billingAccountId: "user_2",
				},
			},
		};
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			concurrency: 1,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () => [failedJob, laterJob],
				markProjectionSyncJobSucceeded: async (projectId, jobId) => {
					calls.push(`succeeded:${projectId}:${jobId}`);
				},
				markProjectionSyncJobFailed: async (projectId, jobId) => {
					calls.push(`failed:${projectId}:${jobId}`);
					throw new Error("failure marker unavailable");
				},
			},
			delivery: {
				deliver: async ({ jobId }) => {
					calls.push(`sync:${jobId}`);
					if (jobId === "job_failed") {
						throw new Error("delivery failed");
					}
				},
			},
			now: () => new Date("2026-05-31T00:00:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1 });
		expect(calls).toEqual([
			"sync:job_failed",
			"failed:project_1:job_failed",
			"sync:job_later",
			"succeeded:project_1:job_later",
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_projection_sync_jobs_total{result="failed"} 1',
		);
		expect(errors.map((entry) => entry.message)).toEqual([
			"Projection sync job failure marker failed",
			"Projection sync job failed",
		]);
	});

	it("records run failures when jobs cannot be claimed", async () => {
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () => {
					throw new Error("database unavailable");
				},
				markProjectionSyncJobSucceeded: async () => undefined,
				markProjectionSyncJobFailed: async () => undefined,
			},
			delivery: {
				deliver: async () => undefined,
			},
			metrics,
			logger,
		});

		await expect(worker.runOnce()).rejects.toThrow("database unavailable");
		expect(metrics.renderPrometheus()).toContain(
			'billing_projection_sync_jobs_total{result="failed"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Projection sync run failed");
		expect(errors[0]?.context).toEqual({ workerId: "worker-a", result: "failed" });
	});

	it("builds usage-driven jobs at delivery time and forwards the sequence", async () => {
		const delivered: Array<Record<string, unknown>> = [];
		const built: string[] = [];
		const usageJob = { ...job, id: "job_usage", reason: "usage_changed", payload: null } as const;
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			concurrency: 1,
			repository: {
				buildUsageProjection: async (projectId, customerId) => {
					built.push(`${projectId}:${customerId}`);
					return {
						billingAccountId: "user_1",
						generatedAt: "2026-06-01T00:00:00.000Z",
						reason: "usage_changed",
						entitlements: {
							billingAccountId: "user_1",
							generatedAt: "2026-06-01T00:00:00.000Z",
							entitlements: [],
						},
						balances: [
							{
								featureKey: "ai_credits",
								unit: "credit",
								available: "9.5",
								held: "0",
								periodEndsAt: null,
							},
						],
						sequence: 7,
					};
				},
				claimProjectionSyncJobs: async () => [usageJob],
				markProjectionSyncJobSucceeded: async () => {},
				markProjectionSyncJobFailed: async () => {
					throw new Error("unexpected failure");
				},
			},
			delivery: {
				deliver: async (input) => {
					delivered.push(input as unknown as Record<string, unknown>);
				},
				usageDeliveryMode: async () => "coalesced",
			},
		});

		await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(built).toEqual(["project_1:customer_1"]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			jobId: "job_usage",
			idempotencyKey: job.idempotency_key,
			reason: "usage_changed",
			sequence: 7,
			balances: [{ featureKey: "ai_credits", available: "9.5" }],
		});
	});

	it("marks usage-driven jobs succeeded without delivering when the receiver turned them off", async () => {
		const calls: string[] = [];
		const usageJob = { ...job, id: "job_usage", reason: "usage_changed", payload: null } as const;
		const worker = new ProjectionSyncWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			concurrency: 1,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("must not build a payload when delivery is off");
				},
				claimProjectionSyncJobs: async () => [usageJob],
				markProjectionSyncJobSucceeded: async (_projectId, jobId) => {
					calls.push(`succeeded:${jobId}`);
				},
				markProjectionSyncJobFailed: async () => {
					throw new Error("unexpected failure");
				},
			},
			delivery: {
				deliver: async () => {
					throw new Error("must not deliver when usage delivery is off");
				},
				usageDeliveryMode: async () => "off",
			},
		});

		await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(calls).toEqual(["succeeded:job_usage"]);
	});
});
