import { describe, expect, it } from "bun:test";
import type { ProjectionSyncJobRow, StoreEventReplayJobRow } from "../../../src/db/repository";
import { createIntegrationBillingEnv } from "./local-postgres";
import { integrationProjectContext } from "./platform-fixture";
import { runProjectionWorkerOnce, runStoreEventReplayWorkerOnce } from "./worker-fixture";

describe("worker fixture helpers", () => {
	it("wires projection worker overrides and defaults fetch to global fetch", async () => {
		const env = createIntegrationBillingEnv(
			"postgresql://postgres:postgres@127.0.0.1:5432/postgres",
			{
				connectionFixtures: [
					{
						projectInstanceKey: "voysee",
						projectionUrl: "https://projection.test",
						projectionSecret: "voysee-projection-secret",
					},
				],
			},
		);
		const calls: string[] = [];
		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls.push("fetch");
			return Response.json({ success: true });
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await runProjectionWorkerOnce({
				env,
				repository: {
					async buildUsageProjection(): Promise<never> {
						throw new Error("usage projections are not expected here");
					},
					async claimProjectionSyncJobs(workerId, limit) {
						calls.push(`claim:${workerId}:${limit}`);
						return [projectionJob()];
					},
					async markProjectionSyncJobSucceeded(_projectId, _jobId, workerId) {
						calls.push(`succeed:${workerId}`);
					},
					async markProjectionSyncJobFailed() {
						throw new Error("unexpected projection failure");
					},
				},
				workerId: "worker-a",
				batchSize: 7,
			});

			expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
			expect(calls).toEqual(["claim:worker-a:7", "fetch", "succeed:worker-a"]);
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("wires store replay worker overrides", async () => {
		const env = createIntegrationBillingEnv(
			"postgresql://postgres:postgres@127.0.0.1:5432/postgres",
		);
		const calls: string[] = [];

		const result = await runStoreEventReplayWorkerOnce({
			env,
			repository: {
				async claimStoreEventReplayJobs(workerId, limit) {
					calls.push(`claim:${workerId}:${limit}`);
					return [storeEvent()];
				},
				async claimStoreEventReplayJobById() {
					throw new Error("unexpected runOne claim");
				},
				async markStoreEventReplayJobSucceeded(_projectId, _eventId, workerId) {
					calls.push(`succeed:${workerId}`);
				},
				async markStoreEventReplayJobFailed() {
					throw new Error("unexpected replay failure");
				},
			},
			providers: {
				apple: null,
				google: null,
				stripe: {
					async replayStoreEvent(event) {
						calls.push(`replay:${event.id}`);
						return { status: "processed" };
					},
				},
			},
			workerId: "worker-b",
			batchSize: 3,
		});

		expect(result).toEqual({
			claimed: 1,
			processed: 1,
			ignored: 0,
			retryable: 0,
			failed: 0,
		});
		expect(calls).toEqual(["claim:worker-b:3", "replay:event-1", "succeed:worker-b"]);
	});
});

function projectionJob(): ProjectionSyncJobRow {
	return {
		id: "job-1",
		project_id: integrationProjectContext().projectInstanceId,
		project_key: "voysee",
		customer_id: "customer-1",
		idempotency_key: "idem-1",
		reason: "purchase_verified",
		payload: {
			billingAccountId: "integration_user",
			generatedAt: "2026-06-01T00:00:00.000Z",
			balances: [],
			entitlements: {
				billingAccountId: "integration_user",
				entitlements: [],
				generatedAt: "2026-06-01T00:00:00.000Z",
			},
			reason: "purchase_verified",
		},
		status: "processing",
		attempts: 0,
		last_error: null,
		reprojection_requested: false,
		next_attempt_at: null,
		locked_at: null,
		locked_by: "worker-a",
		created_at: "2026-06-01T00:00:00.000Z",
		updated_at: "2026-06-01T00:00:00.000Z",
	};
}

function storeEvent(): StoreEventReplayJobRow {
	return {
		id: "event-1",
		project_id: integrationProjectContext().projectInstanceId,
		project_key: "voysee",
		provider: "stripe",
		channel: "web",
		external_event_id: "evt_1",
		event_type: "checkout.session.completed",
		customer_id: null,
		store_product_id: null,
		transaction_id: null,
		purchase_kind: null,
		processing_status: "processing",
		processing_error: null,
		attempts: 0,
		next_attempt_at: null,
		raw_payload: {},
		processed_at: null,
		locked_at: null,
		locked_by: "worker-b",
		created_at: "2026-06-01T00:00:00.000Z",
		updated_at: "2026-06-01T00:00:00.000Z",
	};
}
