import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createDeferred } from "../helpers/deferred";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	expireProjectionJobLock,
	expireStoreEventLock,
	seedReplayEvent,
} from "./helpers/job-time-travel";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { runStoreEventReplayWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Worker lease fencing", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("keeps a live replay heartbeat past the stale window so a second worker claims nothing", async () => {
		const eventId = await seedReplayEvent(context.sql, {
			projectKey: "voysee",
			provider: "stripe",
			channel: "web",
			status: "pending",
			eventType: "checkout.session.completed",
			externalEventId: "evt_heartbeat",
		});
		const hold = createDeferred<void>();
		const workerA = runStoreEventReplayWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: {
				apple: null,
				google: null,
				stripe: {
					async replayStoreEvent() {
						await hold.promise;
						return { status: "processed" };
					},
				},
			},
			workerId: "worker-a",
			leaseHeartbeatIntervalMs: 50,
		});

		await waitUntil(async () => {
			const [row] = await context.sql<{ locked_by: string | null }[]>`
				SELECT locked_by FROM store_events WHERE id = ${eventId}
			`;
			return row?.locked_by === "worker-a";
		});
		await expireStoreEventLock(context.sql, eventId);
		await waitUntil(async () => {
			const [row] = await context.sql<{ fresh: boolean }[]>`
				SELECT locked_at > now() - INTERVAL '1 minute' AS fresh
				FROM store_events
				WHERE id = ${eventId}
			`;
			return row?.fresh === true;
		}, 2_000);

		const workerB = await runStoreEventReplayWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: { apple: null, google: null, stripe: null },
			workerId: "worker-b",
		});
		expect(workerB).toMatchObject({ claimed: 0 });
		hold.resolve();
		expect(await workerA).toMatchObject({ claimed: 1, processed: 1 });
		const [finalRow] = await context.sql<{ processing_status: string; locked_by: string | null }[]>`
			SELECT processing_status, locked_by FROM store_events WHERE id = ${eventId}
		`;
		expect(finalRow).toEqual({ processing_status: "processed", locked_by: null });
	});

	it("fences store-event replay finalizers after a reclaimed lease", async () => {
		const eventId = await seedReplayEvent(context.sql, {
			projectKey: "voysee",
			provider: "stripe",
			channel: "web",
			status: "pending",
			eventType: "checkout.session.completed",
			externalEventId: "evt_fence",
		});
		const [claimed] = await context.repository.claimStoreEventReplayJobs("worker-a", 1);
		expect(claimed.id).toBe(eventId);
		await expireStoreEventLock(context.sql, eventId);
		const [reclaimed] = await context.repository.claimStoreEventReplayJobs("worker-b", 1);
		expect(reclaimed.id).toBe(eventId);
		await expect(
			context.repository.markStoreEventReplayJobSucceeded(claimed.project_id, eventId, "worker-a"),
		).rejects.toThrow(/is not locked by worker worker-a/);
		const [beforeRenew] = await context.sql<{ locked_at: string; locked_by: string }[]>`
			SELECT locked_at::text, locked_by FROM store_events WHERE id = ${eventId}
		`;
		await context.repository.renewStoreEventReplayJobLease(claimed.project_id, eventId, "worker-a");
		const [afterRenew] = await context.sql<{ locked_at: string; locked_by: string }[]>`
			SELECT locked_at::text, locked_by FROM store_events WHERE id = ${eventId}
		`;
		expect(afterRenew.locked_by).toBe("worker-b");
		expect(afterRenew.locked_at).toBe(beforeRenew.locked_at);
		await context.repository.markStoreEventReplayJobSucceeded(
			reclaimed.project_id,
			eventId,
			"worker-b",
		);
		const [finalRow] = await context.sql<{ processing_status: string; locked_by: string | null }[]>`
			SELECT processing_status, locked_by FROM store_events WHERE id = ${eventId}
		`;
		expect(finalRow).toEqual({ processing_status: "processed", locked_by: null });
	});

	it("fences projection-sync finalizers after a reclaimed lease; projection-sync has no heartbeat because delivery is bounded by timeoutMs (10s default) and a batch holds a job about a minute against a 5-minute reclaim window", async () => {
		const [job] = await seedProjectionJobs(context.sql, 1);
		const [claimed] = await context.repository.claimProjectionSyncJobs("worker-a", 1);
		expect(claimed.id).toBe(job.id);
		await expireProjectionJobLock(context.sql, job.id);
		const [reclaimed] = await context.repository.claimProjectionSyncJobs("worker-b", 1);
		expect(reclaimed.id).toBe(job.id);
		await expect(
			context.repository.markProjectionSyncJobSucceeded(claimed.project_id, job.id, "worker-a"),
		).rejects.toThrow(/is not locked by worker worker-a/);
		await expect(
			context.repository.markProjectionSyncJobFailed(
				claimed.project_id,
				job.id,
				"stale worker",
				new Date(Date.now() + 60_000),
				"worker-a",
			),
		).rejects.toThrow(/is not locked by worker worker-a/);
		await context.repository.markProjectionSyncJobSucceeded(
			reclaimed.project_id,
			job.id,
			"worker-b",
		);
		const [finalRow] = await context.sql<{ status: string; locked_by: string | null }[]>`
			SELECT status, locked_by FROM projection_sync_jobs WHERE id = ${job.id}
		`;
		expect(finalRow).toEqual({ status: "succeeded", locked_by: null });
	});
});

async function seedProjectionJobs(sql: LocalPostgresContext["sql"], count: number) {
	const jobs: Array<{ id: string; project_id: string }> = [];
	for (let index = 0; index < count; index += 1) {
		const billingAccountId = `lease-account-${index}`;
		const payload = {
			billingAccountId,
			generatedAt: "2026-06-01T00:00:00.000Z",
			entitlements: {
				billingAccountId,
				entitlements: [],
				generatedAt: "2026-06-01T00:00:00.000Z",
			},
			balances: [],
			reason: "purchase_verified",
		};
		const rows = await sql<{ id: string; project_id: string }[]>`
			WITH project_row AS (
				SELECT id FROM projects WHERE key = 'voysee'
			),
			customer_row AS (
				INSERT INTO customers (project_id, billing_account_id)
				SELECT id, ${billingAccountId} FROM project_row
				ON CONFLICT (project_id, billing_account_id) DO UPDATE SET updated_at = now()
				RETURNING id, project_id
			)
			INSERT INTO projection_sync_jobs (
				project_id, customer_id, idempotency_key, reason, payload, status, next_attempt_at
			)
			SELECT customer_row.project_id, customer_row.id, ${`lease:${index}`},
				'purchase_verified', ${JSON.stringify(payload)}::text::jsonb, 'pending',
				now() - INTERVAL '1 second'
			FROM customer_row
			RETURNING id, project_id
		`;
		jobs.push(rows[0]);
	}
	return jobs;
}

async function waitUntil(probe: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await probe()) return;
		await Bun.sleep(20);
	}
	throw new Error("timed out waiting for lease condition");
}
