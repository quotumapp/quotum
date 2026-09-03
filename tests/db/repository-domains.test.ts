import { describe, expect, it } from "bun:test";
import type {
	ExpiredSubscriptionReconciliationResult,
	ProjectionSyncJobRow,
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
} from "../../src/db/repository";
import {
	ProjectionSyncJobRepository,
	ProviderSubscriptionReconciliationRepository,
	StoreEventReplayJobRepository,
} from "../../src/db/repository-domains";

describe("repository domain adapters", () => {
	it("delegate projection sync job operations to the compatibility repository", async () => {
		const calls: unknown[] = [];
		const rows: ProjectionSyncJobRow[] = [];
		const adapter = new ProjectionSyncJobRepository({
			claimProjectionSyncJobs(workerId, limit) {
				calls.push({ method: "claimProjectionSyncJobs", workerId, limit });
				return Promise.resolve(rows);
			},
			markProjectionSyncJobSucceeded(projectId, jobId, workerId) {
				calls.push({ method: "markProjectionSyncJobSucceeded", projectId, jobId, workerId });
				return Promise.resolve();
			},
			markProjectionSyncJobFailed(projectId, jobId, lastError, nextAttemptAt, workerId) {
				calls.push({
					method: "markProjectionSyncJobFailed",
					projectId,
					jobId,
					lastError,
					nextAttemptAt,
					workerId,
				});
				return Promise.resolve();
			},
		});

		expect(await adapter.claimProjectionSyncJobs("worker-a", 5)).toBe(rows);
		await adapter.markProjectionSyncJobSucceeded("project_1", "job_1", "worker-a");
		await adapter.markProjectionSyncJobFailed(
			"project_1",
			"job_1",
			"delivery failed",
			null,
			"worker-a",
		);

		expect(calls).toEqual([
			{ method: "claimProjectionSyncJobs", workerId: "worker-a", limit: 5 },
			{
				method: "markProjectionSyncJobSucceeded",
				projectId: "project_1",
				jobId: "job_1",
				workerId: "worker-a",
			},
			{
				method: "markProjectionSyncJobFailed",
				projectId: "project_1",
				jobId: "job_1",
				lastError: "delivery failed",
				nextAttemptAt: null,
				workerId: "worker-a",
			},
		]);
	});

	it("delegate replay and reconciliation worker operations by domain", async () => {
		const calls: unknown[] = [];
		const replayRows: StoreEventReplayJobRow[] = [];
		const reconciliationRows: ProviderSubscriptionReconciliationRow[] = [];
		const expired: ExpiredSubscriptionReconciliationResult = {
			expiredSubscriptions: 0,
			affectedCustomers: 0,
			projectionJobs: 0,
		};
		const replay = new StoreEventReplayJobRepository({
			claimStoreEventReplayJobs(workerId, limit) {
				calls.push({ method: "claimStoreEventReplayJobs", workerId, limit });
				return Promise.resolve(replayRows);
			},
			claimStoreEventReplayJobById(workerId, project, eventId) {
				calls.push({ method: "claimStoreEventReplayJobById", workerId, project, eventId });
				return Promise.resolve(replayRows[0] as StoreEventReplayJobRow);
			},
			markStoreEventReplayJobSucceeded(projectId, eventId, workerId) {
				calls.push({ method: "markStoreEventReplayJobSucceeded", projectId, eventId, workerId });
				return Promise.resolve();
			},
			markStoreEventReplayJobFailed(projectId, eventId, errorMessage, nextAttemptAt, workerId) {
				calls.push({
					method: "markStoreEventReplayJobFailed",
					projectId,
					eventId,
					errorMessage,
					nextAttemptAt,
					workerId,
				});
				return Promise.resolve();
			},
		});
		const reconciliation = new ProviderSubscriptionReconciliationRepository({
			reconcileExpiredSubscriptions(limit) {
				calls.push({ method: "reconcileExpiredSubscriptions", limit });
				return Promise.resolve(expired);
			},
			claimProviderSubscriptionReconciliations(workerId, limit, staleBefore) {
				calls.push({
					method: "claimProviderSubscriptionReconciliations",
					workerId,
					limit,
					staleBefore,
				});
				return Promise.resolve(reconciliationRows);
			},
			markProviderSubscriptionReconciliationSucceeded(projectId, subscriptionId, workerId) {
				calls.push({
					method: "markProviderSubscriptionReconciliationSucceeded",
					projectId,
					subscriptionId,
					workerId,
				});
				return Promise.resolve();
			},
			markProviderSubscriptionReconciliationFailed(
				projectId,
				subscriptionId,
				errorMessage,
				nextAttemptAt,
				workerId,
			) {
				calls.push({
					method: "markProviderSubscriptionReconciliationFailed",
					projectId,
					subscriptionId,
					errorMessage,
					nextAttemptAt,
					workerId,
				});
				return Promise.resolve();
			},
		});
		const staleBefore = new Date("2026-06-07T12:00:00.000Z");

		expect(await replay.claimStoreEventReplayJobs("worker-a", 3)).toBe(replayRows);
		expect(await reconciliation.reconcileExpiredSubscriptions(10)).toBe(expired);
		expect(
			await reconciliation.claimProviderSubscriptionReconciliations("worker-a", 10, staleBefore),
		).toBe(reconciliationRows);

		expect(calls).toEqual([
			{ method: "claimStoreEventReplayJobs", workerId: "worker-a", limit: 3 },
			{ method: "reconcileExpiredSubscriptions", limit: 10 },
			{
				method: "claimProviderSubscriptionReconciliations",
				workerId: "worker-a",
				limit: 10,
				staleBefore,
			},
		]);
	});
});
