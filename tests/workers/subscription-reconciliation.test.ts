import { describe, expect, it } from "bun:test";
import type {
	ExpiredSubscriptionReconciliationResult,
	ProviderSubscriptionReconciliationRow,
} from "../../src/db/repository";
import type { BillingLogger } from "../../src/observability/logger";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { SubscriptionReconciliationWorker } from "../../src/workers/subscription-reconciliation";
import { createDeferred } from "../helpers/deferred";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const workerProjectResolver = projectContextResolver({
	contexts: [
		projectInstanceContext("voysee", { projectInstanceId: "project_1" }),
		projectInstanceContext("wiseley", { projectInstanceId: "project_2" }),
	],
});

const subscription = (
	overrides: Partial<ProviderSubscriptionReconciliationRow> = {},
): ProviderSubscriptionReconciliationRow => ({
	id: "subscription_1",
	project_id: "project_1",
	project_key: "voysee",
	provider: "apple",
	channel: "ios",
	external_subscription_id: "100000000000001",
	external_product_id: "premium_monthly",
	external_price_id: null,
	latest_transaction_id: "200000000000001",
	status: "active",
	expires_at: "2026-05-30T00:00:00.000Z",
	provider_reconciliation_attempts: 0,
	...overrides,
});

function createRepository({
	expiredResult = {
		expiredSubscriptions: 2,
		affectedCustomers: 1,
		projectionJobs: 1,
	},
	subscriptions = [],
	succeedError,
	failError,
}: {
	expiredResult?: ExpiredSubscriptionReconciliationResult;
	subscriptions?: ProviderSubscriptionReconciliationRow[];
	succeedError?: Error;
	failError?: Error;
} = {}) {
	const calls: unknown[] = [];

	return {
		calls,
		repository: {
			reconcileExpiredSubscriptions(limit: number) {
				calls.push({ method: "reconcileExpiredSubscriptions", limit });
				return Promise.resolve(expiredResult);
			},
			claimProviderSubscriptionReconciliations(workerId: string, limit: number, staleBefore: Date) {
				calls.push({
					method: "claimProviderSubscriptionReconciliations",
					workerId,
					limit,
					staleBefore: staleBefore.toISOString(),
				});
				return Promise.resolve(subscriptions);
			},
			markProviderSubscriptionReconciliationSucceeded(
				_projectId: string,
				subscriptionId: string,
				workerId: string,
			) {
				calls.push({
					method: "markProviderSubscriptionReconciliationSucceeded",
					subscriptionId,
					workerId,
				});
				if (succeedError !== undefined) {
					return Promise.reject(succeedError);
				}
				return Promise.resolve();
			},
			markProviderSubscriptionReconciliationFailed(
				_projectId: string,
				subscriptionId: string,
				error: string,
				nextAttemptAt: Date | null,
				workerId: string,
			) {
				calls.push({
					method: "markProviderSubscriptionReconciliationFailed",
					subscriptionId,
					error,
					nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
					workerId,
				});
				if (failError !== undefined) {
					return Promise.reject(failError);
				}
				return Promise.resolve();
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

describe("SubscriptionReconciliationWorker", () => {
	it("reconciles local expirations and claims stale provider subscriptions", async () => {
		const { calls, repository } = createRepository();
		const metrics = createInMemoryBillingMetrics();
		const { logger, infos } = createRecordingLogger();
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 10,
			staleAfterMs: 5 * 60 * 1000,
			repository,
			providers: { apple: null, google: null, stripe: null },
			now: () => new Date("2026-05-31T00:10:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({
			outcome: "succeeded",
			expiredSubscriptions: 2,
			affectedCustomers: 1,
			providerClaimed: 0,
			providerProcessed: 0,
			providerSkipped: 0,
			providerFailed: 0,
		});
		expect(calls).toEqual([
			{
				method: "claimProviderSubscriptionReconciliations",
				workerId: "worker-a",
				limit: 10,
				staleBefore: "2026-05-31T00:05:00.000Z",
			},
			{ method: "reconcileExpiredSubscriptions", limit: 10 },
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_subscription_reconciliation_runs_total{result="succeeded"} 1',
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_worker_jobs_total{result="succeeded",worker="subscription_reconciliation"} 1',
		);
		expect(infos).toEqual([
			{
				message: "Subscription reconciliation run completed",
				context: {
					outcome: "succeeded",
					expiredSubscriptions: 2,
					affectedCustomers: 1,
					providerClaimed: 0,
					providerProcessed: 0,
					providerSkipped: 0,
					providerFailed: 0,
					workerId: "worker-a",
				},
			},
		]);
	});

	it("marks provider refreshes succeeded when processed or skipped", async () => {
		const rows = [
			subscription({ id: "subscription_processed", provider: "apple" }),
			subscription({
				id: "subscription_skipped",
				provider: "google",
				channel: "android",
				external_subscription_id: "purchase_token_1",
			}),
		];
		const { calls, repository } = createRepository({ subscriptions: rows });
		const providerCalls: ProviderSubscriptionReconciliationRow[] = [];
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 10,
			staleAfterMs: 5 * 60 * 1000,
			repository,
			providers: {
				apple: {
					reconcileSubscription: async (row) => {
						providerCalls.push(row);
						return { status: "processed" };
					},
				},
				google: {
					reconcileSubscription: async (row) => {
						providerCalls.push(row);
						return { status: "skipped" };
					},
				},
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:10:00.000Z"),
			jitterMs: () => 0,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({
			outcome: "succeeded",
			expiredSubscriptions: 2,
			affectedCustomers: 1,
			providerClaimed: 2,
			providerProcessed: 1,
			providerSkipped: 1,
			providerFailed: 0,
		});
		expect(providerCalls).toEqual(rows);
		expect(calls).toContainEqual({
			method: "markProviderSubscriptionReconciliationSucceeded",
			subscriptionId: "subscription_processed",
			workerId: "worker-a",
		});
		expect(calls).toContainEqual({
			method: "markProviderSubscriptionReconciliationSucceeded",
			subscriptionId: "subscription_skipped",
			workerId: "worker-a",
		});
	});

	it("selects reconciliation providers from the claimed row project key", async () => {
		const { repository } = createRepository({
			subscriptions: [
				subscription({ id: "subscription_voysee", project_key: "voysee" }),
				subscription({
					id: "subscription_wiseley",
					project_id: "project_2",
					project_key: "wiseley",
				}),
			],
		});
		const providerCalls: string[] = [];
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			staleAfterMs: 60_000,
			repository,
			providers: (project) => ({
				apple: {
					reconcileSubscription: async (row) => {
						providerCalls.push(`${project.projectInstanceKey}:${row.id}`);
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			}),
		});

		await worker.runOnce();

		expect(providerCalls).toEqual(["voysee:subscription_voysee", "wiseley:subscription_wiseley"]);
	});

	it("does not mark processed or skipped subscriptions failed when success finalization throws", async () => {
		for (const status of ["processed", "skipped"] as const) {
			const finalizationError = new Error(`success marker timed out for ${status}`);
			const { calls, repository } = createRepository({
				subscriptions: [subscription({ id: `subscription_${status}` })],
				succeedError: finalizationError,
			});
			const worker = new SubscriptionReconciliationWorker({
				projectContextResolver: workerProjectResolver,
				workerId: "worker-a",
				maxAttempts: 3,
				batchSize: 10,
				staleAfterMs: 5 * 60 * 1000,
				repository,
				providers: {
					apple: {
						reconcileSubscription: async () => ({ status }),
					},
					google: null,
					stripe: null,
				},
				now: () => new Date("2026-05-31T00:10:00.000Z"),
				jitterMs: () => 0,
			});

			await expect(worker.runOnce()).rejects.toThrow(`success marker timed out for ${status}`);
			expect(calls).toEqual([
				{
					method: "claimProviderSubscriptionReconciliations",
					workerId: "worker-a",
					limit: 10,
					staleBefore: "2026-05-31T00:05:00.000Z",
				},
				{
					method: "markProviderSubscriptionReconciliationSucceeded",
					subscriptionId: `subscription_${status}`,
					workerId: "worker-a",
				},
			]);
		}
	});

	it("marks missing providers and thrown provider errors failed with retry backoff", async () => {
		const { calls, repository } = createRepository({
			subscriptions: [
				subscription({ id: "subscription_missing", provider: "stripe" }),
				subscription({
					id: "subscription_error",
					provider: "google",
					channel: "android",
					external_subscription_id: "purchase_token_1",
					provider_reconciliation_attempts: 1,
				}),
			],
		});
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 10,
			staleAfterMs: 5 * 60 * 1000,
			repository,
			providers: {
				apple: null,
				google: {
					reconcileSubscription: async () => {
						throw new Error("Google API unavailable");
					},
				},
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:10:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toEqual({
			outcome: "failed",
			expiredSubscriptions: 2,
			affectedCustomers: 1,
			providerClaimed: 2,
			providerProcessed: 0,
			providerSkipped: 0,
			providerFailed: 2,
		});
		expect(calls).toContainEqual({
			method: "markProviderSubscriptionReconciliationFailed",
			subscriptionId: "subscription_missing",
			error: "Subscription reconciliation provider is not configured: stripe",
			nextAttemptAt: "2026-05-31T00:11:00.000Z",
			workerId: "worker-a",
		});
		expect(calls).toContainEqual({
			method: "markProviderSubscriptionReconciliationFailed",
			subscriptionId: "subscription_error",
			error: "Google API unavailable",
			nextAttemptAt: "2026-05-31T00:12:00.000Z",
			workerId: "worker-a",
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_subscription_reconciliation_runs_total{result="failed"} 1',
		);
		expect(errors).toHaveLength(2);
		expect(errors.map((entry) => entry.message)).toEqual([
			"Subscription reconciliation provider job failed",
			"Subscription reconciliation provider job failed",
		]);
		expect(errors[0]?.context).toEqual({
			subscriptionId: "subscription_missing",
			provider: "stripe",
			workerId: "worker-a",
			result: "failed",
		});
	});

	it("marks max attempts failed without another retry", async () => {
		const { calls, repository } = createRepository({
			subscriptions: [
				subscription({
					id: "subscription_final",
					provider_reconciliation_attempts: 2,
				}),
			],
		});
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 10,
			staleAfterMs: 5 * 60 * 1000,
			repository,
			providers: {
				apple: {
					reconcileSubscription: async () => {
						throw new Error("Apple API unavailable");
					},
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:10:00.000Z"),
			jitterMs: () => 0,
		});

		const result = await worker.runOnce();

		expect(result.providerFailed).toBe(1);
		expect(calls).toContainEqual({
			method: "markProviderSubscriptionReconciliationFailed",
			subscriptionId: "subscription_final",
			error: "Apple API unavailable",
			nextAttemptAt: null,
			workerId: "worker-a",
		});
	});

	it("continues processing remaining subscriptions when marking a failed refresh throws", async () => {
		const rows = [
			subscription({ id: "subscription_failed" }),
			subscription({ id: "subscription_later" }),
		];
		const { calls, repository } = createRepository({
			subscriptions: rows,
			failError: new Error("failure marker unavailable"),
		});
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 10,
			staleAfterMs: 5 * 60 * 1000,
			repository,
			providers: {
				apple: {
					reconcileSubscription: async (row) => {
						if (row.id === "subscription_failed") {
							throw new Error("Apple API unavailable");
						}
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			},
			now: () => new Date("2026-05-31T00:10:00.000Z"),
			jitterMs: () => 0,
			metrics,
			logger,
		});

		const result = await worker.runOnce();

		expect(result).toMatchObject({
			providerClaimed: 2,
			providerProcessed: 1,
			providerFailed: 1,
		});
		expect(calls).toContainEqual({
			method: "markProviderSubscriptionReconciliationFailed",
			subscriptionId: "subscription_failed",
			error: "Apple API unavailable",
			nextAttemptAt: "2026-05-31T00:11:00.000Z",
			workerId: "worker-a",
		});
		expect(calls).toContainEqual({
			method: "markProviderSubscriptionReconciliationSucceeded",
			subscriptionId: "subscription_later",
			workerId: "worker-a",
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_subscription_reconciliation_runs_total{result="partial"} 1',
		);
		expect(errors.map((entry) => entry.message)).toEqual([
			"Subscription reconciliation failure marker failed",
			"Subscription reconciliation provider job failed",
		]);
	});

	it("renews claimed leases while a slow provider call is running", async () => {
		const rows = [subscription()];
		const { repository } = createRepository({ subscriptions: rows });
		const renewed: string[] = [];
		const renewedLease = createDeferred<void>();
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 10,
			staleAfterMs: 5 * 60 * 1000,
			repository: {
				...repository,
				renewProviderSubscriptionReconciliationLease: async (
					projectId,
					subscriptionId,
					workerId,
				) => {
					renewed.push(`${projectId}:${subscriptionId}:${workerId}`);
					renewedLease.resolve();
				},
			},
			providers: {
				apple: {
					reconcileSubscription: async () => {
						await renewedLease.promise;
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			},
			leaseHeartbeatIntervalMs: 5,
		});

		await worker.runOnce();

		expect(renewed[0]).toBe("project_1:subscription_1:worker-a");
	});

	it("records run failures when local reconciliation throws", async () => {
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const worker = new SubscriptionReconciliationWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 10,
			staleAfterMs: 5 * 60 * 1000,
			repository: {
				reconcileExpiredSubscriptions: async () => {
					throw new Error("database unavailable");
				},
				claimProviderSubscriptionReconciliations: async () => [],
				markProviderSubscriptionReconciliationSucceeded: async () => undefined,
				markProviderSubscriptionReconciliationFailed: async () => undefined,
			},
			providers: { apple: null, google: null, stripe: null },
			metrics,
			logger,
		});

		await expect(worker.runOnce()).rejects.toThrow("database unavailable");
		expect(metrics.renderPrometheus()).toContain(
			'billing_subscription_reconciliation_runs_total{result="failed"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Subscription reconciliation run failed");
		expect(errors[0]?.context).toEqual({ workerId: "worker-a", result: "failed" });
	});
});
