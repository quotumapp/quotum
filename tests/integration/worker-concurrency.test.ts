import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { ProjectionSyncReason } from "../../src/billing/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	expireProjectionJobLock,
	expireStoreEventLock,
	makeProjectionJobDue,
	seedReplayEvent,
	setProjectionJobAttempts,
} from "./helpers/job-time-travel";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import type { ProjectionRequest } from "./helpers/worker-fixture";
import {
	createRecordingProjectionFetch,
	runProjectionWorkerOnce,
	runStoreEventReplayWorkerOnce,
} from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Worker concurrency integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("claims each projection job exactly once across competing workers", async () => {
		const jobs = await seedProjectionJobs(context.sql, { count: 10 });
		const workerA = createRecordingProjectionFetch();
		const workerB = createRecordingProjectionFetch();

		const [resultA, resultB] = await Promise.all([
			runProjectionWorkerOnce({
				env: context.env,
				repository: context.repository,
				fetch: workerA.fetch,
				workerId: "worker-a",
				batchSize: 10,
			}),
			runProjectionWorkerOnce({
				env: context.env,
				repository: context.repository,
				fetch: workerB.fetch,
				workerId: "worker-b",
				batchSize: 10,
			}),
		]);

		const allRequests = [...workerA.requests, ...workerB.requests];
		expect(resultA.claimed + resultB.claimed).toBe(10);
		expect(resultA.succeeded + resultB.succeeded).toBe(10);
		expect(resultA.failed + resultB.failed).toBe(0);
		expect(uniqueJobIds(allRequests)).toHaveLength(10);
		expect(disjoint(jobIds(workerA.requests), jobIds(workerB.requests))).toBe(true);
		expect(new Set(jobIds(allRequests))).toEqual(new Set(jobs.map((job) => job.id)));
		await expectProjectionJobStatusCounts(context.sql, { succeeded: 10 });
		await expectNoProjectionLocks(context.sql);
	});

	it("does not claim projection jobs locked by a live worker", async () => {
		const jobs = await seedProjectionJobs(context.sql, { count: 1 });
		const claimed = await context.repository.claimProjectionSyncJobs("worker-a", 1);
		expect(claimed.map((job) => job.id)).toEqual([jobs[0].id]);

		const projection = createRecordingProjectionFetch();
		const result = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
			workerId: "worker-b",
		});

		expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
		expect(projection.requests).toHaveLength(0);
		await expectProjectionJobLock(context.sql, jobs[0].id, {
			status: "processing",
			lockedBy: "worker-a",
		});
	});

	it("reclaims stale projection locks after the five-minute window", async () => {
		const jobs = await seedProjectionJobs(context.sql, { count: 1 });
		await context.repository.claimProjectionSyncJobs("worker-a", 1);
		await expireProjectionJobLock(context.sql, jobs[0].id);
		const projection = createRecordingProjectionFetch();

		const result = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
			workerId: "worker-b",
		});

		expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(projection.requests[0].body.jobId).toBe(jobs[0].id);
		await expectProjectionJobLock(context.sql, jobs[0].id, {
			status: "succeeded",
			lockedBy: null,
		});
	});

	it("honors next_attempt_at backoff scheduling for projection jobs", async () => {
		const jobs = await seedProjectionJobs(context.sql, { count: 1 });
		const failingProjection = createRecordingProjectionFetch(
			new Response(JSON.stringify({ success: true }), { status: 503 }),
		);

		const failed = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: failingProjection.fetch,
			workerId: "worker-a",
			now: () => new Date(),
		});

		expect(failed).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
		await expectProjectionNextAttemptNearOneMinute(context.sql, jobs[0].id);
		const immediate = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: createRecordingProjectionFetch().fetch,
			workerId: "worker-b",
		});
		expect(immediate).toEqual({ claimed: 0, succeeded: 0, failed: 0 });

		await makeProjectionJobDue(context.sql, jobs[0].id);
		const projection = createRecordingProjectionFetch();
		const retried = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
			workerId: "worker-b",
		});

		expect(retried).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(projection.requests[0].body.jobId).toBe(jobs[0].id);
	});

	it("keeps terminal projection failures parked until an explicit admin retry", async () => {
		const maxAttempts = 2;
		const jobs = await seedProjectionJobs(context.sql, { count: 1 });
		await setProjectionJobAttempts(context.sql, jobs[0].id, maxAttempts - 1);

		const failed = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: createRecordingProjectionFetch(
				new Response(JSON.stringify({ success: false }), { status: 200 }),
			).fetch,
			workerId: "worker-a",
			maxAttempts,
		});

		expect(failed).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
		await expectProjectionJobLock(context.sql, jobs[0].id, {
			status: "failed",
			lockedBy: null,
		});
		await makeProjectionJobDue(context.sql, jobs[0].id);
		const projection = createRecordingProjectionFetch();
		const retried = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
			workerId: "worker-b",
			maxAttempts,
		});

		expect(retried).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
		expect(projection.requests).toHaveLength(0);

		await expect(
			context.repository.retryProjectionSyncJob(integrationProjectContext(), jobs[0].id),
		).resolves.toEqual({ jobId: jobs[0].id, status: "pending" });
		const recoveredProjection = createRecordingProjectionFetch();
		const recovered = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: recoveredProjection.fetch,
			workerId: "worker-c",
			maxAttempts,
		});

		expect(recovered).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(recoveredProjection.requests[0].body.jobId).toBe(jobs[0].id);
	});

	it("claims store events exactly once across competing replay workers", async () => {
		const eventIds = await seedReplayEvents(context.sql, 6);
		const callsA: string[] = [];
		const callsB: string[] = [];

		const [resultA, resultB] = await Promise.all([
			runStoreEventReplayWorkerOnce({
				env: context.env,
				repository: context.repository,
				providers: replayProviders(callsA),
				workerId: "worker-a",
				batchSize: 6,
			}),
			runStoreEventReplayWorkerOnce({
				env: context.env,
				repository: context.repository,
				providers: replayProviders(callsB),
				workerId: "worker-b",
				batchSize: 6,
			}),
		]);

		expect(resultA.claimed + resultB.claimed).toBe(6);
		expect(resultA.processed + resultB.processed).toBe(6);
		expect(resultA.failed + resultB.failed).toBe(0);
		expect(new Set([...callsA, ...callsB])).toEqual(new Set(eventIds));
		expect(disjoint(callsA, callsB)).toBe(true);
		await expectStoreEventStatusCounts(context.sql, { processed: 6 });
		await expectNoStoreEventLocks(context.sql);
	});

	it("reclaims stale store event locks", async () => {
		const eventId = (
			await seedReplayEvents(context.sql, 1, { eventTypePrefix: "STALE_REPLAY" })
		)[0];
		const claimed = await context.repository.claimStoreEventReplayJobs("worker-a", 1);
		expect(claimed.map((event) => event.id)).toEqual([eventId]);
		await expireStoreEventLock(context.sql, eventId);
		const calls: string[] = [];

		const result = await runStoreEventReplayWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: replayProviders(calls),
			workerId: "worker-b",
		});

		expect(result).toEqual({
			claimed: 1,
			processed: 1,
			ignored: 0,
			retryable: 0,
			failed: 0,
		});
		expect(calls).toEqual([eventId]);
		await expectStoreEventLock(context.sql, eventId, { status: "processed", lockedBy: null });
	});
});

async function seedProjectionJobs(
	sql: SQL,
	{ count, projectKey = "voysee" }: { count: number; projectKey?: "voysee" | "wiseley" },
): Promise<Array<{ id: string; idempotency_key: string }>> {
	const jobs: Array<{ id: string; idempotency_key: string }> = [];
	for (let index = 0; index < count; index += 1) {
		const billingAccountId = `worker_user_${index}`;
		const idempotencyKey = `worker:projection:${index}`;
		const payload = {
			billingAccountId,
			generatedAt: "2026-06-01T00:00:00.000Z",
			entitlements: {
				billingAccountId,
				entitlements: [],
				generatedAt: "2026-06-01T00:00:00.000Z",
			},
			balances: [],
			reason: "purchase_verified" satisfies ProjectionSyncReason,
		};
		const rows = await sql<{ id: string; idempotency_key: string }[]>`
			WITH project_row AS (
				SELECT id
				FROM projects
				WHERE key = ${projectKey}
			),
			customer_row AS (
				INSERT INTO customers (project_id, billing_account_id)
				SELECT project_row.id, ${billingAccountId}
				FROM project_row
				ON CONFLICT (project_id, billing_account_id) DO UPDATE SET updated_at = now()
				RETURNING id, project_id
			)
			INSERT INTO projection_sync_jobs (
				project_id,
				customer_id,
				idempotency_key,
				reason,
				payload,
				status,
				next_attempt_at
			)
			SELECT customer_row.project_id, customer_row.id, ${idempotencyKey},
				'purchase_verified', ${JSON.stringify(payload)}::jsonb, 'pending', now() - INTERVAL '1 second'
			FROM customer_row
			RETURNING id, idempotency_key
		`;
		expect(rows).toHaveLength(1);
		jobs.push(rows[0]);
	}
	return jobs;
}

async function seedReplayEvents(
	sql: SQL,
	count: number,
	options: { eventTypePrefix?: string } = {},
): Promise<string[]> {
	const eventTypePrefix = options.eventTypePrefix ?? "CONCURRENT_REPLAY";
	const ids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		ids.push(
			await seedReplayEvent(sql, {
				projectKey: "voysee",
				provider: "stripe",
				channel: "web",
				status: "skipped",
				eventType: `${eventTypePrefix}_${index}`,
				externalEventId: `stripe:${eventTypePrefix.toLowerCase()}:${index}`,
			}),
		);
	}
	return ids;
}

function replayProviders(calls: string[]) {
	return {
		apple: null,
		google: null,
		stripe: {
			async replayStoreEvent(event: { id: string }) {
				calls.push(event.id);
				return { status: "processed" as const };
			},
		},
	};
}

function jobIds(requests: ProjectionRequest[]): string[] {
	return requests.map((request) => String(request.body.jobId));
}

function uniqueJobIds(requests: ProjectionRequest[]): string[] {
	return [...new Set(jobIds(requests))];
}

function disjoint(left: string[], right: string[]): boolean {
	const rightSet = new Set(right);
	return left.every((value) => !rightSet.has(value));
}

async function expectProjectionJobStatusCounts(
	sql: SQL,
	expected: Partial<Record<"pending" | "processing" | "succeeded" | "failed", number>>,
): Promise<void> {
	const rows = await sql<{ status: string; count: string }[]>`
		SELECT status, count(*)::text AS count
		FROM projection_sync_jobs
		GROUP BY status
	`;
	expect(Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))).toMatchObject(
		expected,
	);
}

async function expectStoreEventStatusCounts(
	sql: SQL,
	expected: Partial<Record<"pending" | "processing" | "processed" | "skipped" | "failed", number>>,
): Promise<void> {
	const rows = await sql<{ status: string; count: string }[]>`
		SELECT processing_status AS status, count(*)::text AS count
		FROM store_events
		GROUP BY processing_status
	`;
	expect(Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))).toMatchObject(
		expected,
	);
}

async function expectNoProjectionLocks(sql: SQL): Promise<void> {
	const rows = await sql<{ count: string }[]>`
		SELECT count(*)::text AS count
		FROM projection_sync_jobs
		WHERE locked_at IS NOT NULL
			OR locked_by IS NOT NULL
	`;
	expect(rows[0].count).toBe("0");
}

async function expectNoStoreEventLocks(sql: SQL): Promise<void> {
	const rows = await sql<{ count: string }[]>`
		SELECT count(*)::text AS count
		FROM store_events
		WHERE locked_at IS NOT NULL
			OR locked_by IS NOT NULL
	`;
	expect(rows[0].count).toBe("0");
}

async function expectProjectionJobLock(
	sql: SQL,
	jobId: string,
	expected: { status: string; lockedBy: string | null },
): Promise<void> {
	const rows = await sql<{ status: string; locked_by: string | null }[]>`
		SELECT status, locked_by
		FROM projection_sync_jobs
		WHERE id = ${jobId}
	`;
	expect(rows).toEqual([{ status: expected.status, locked_by: expected.lockedBy }]);
}

async function expectStoreEventLock(
	sql: SQL,
	eventId: string,
	expected: { status: string; lockedBy: string | null },
): Promise<void> {
	const rows = await sql<{ status: string; locked_by: string | null }[]>`
		SELECT processing_status AS status, locked_by
		FROM store_events
		WHERE id = ${eventId}
	`;
	expect(rows).toEqual([{ status: expected.status, locked_by: expected.lockedBy }]);
}

async function expectProjectionNextAttemptNearOneMinute(sql: SQL, jobId: string): Promise<void> {
	const rows = await sql<{ scheduled: boolean }[]>`
		SELECT next_attempt_at > now() + INTERVAL '59 seconds'
			AND next_attempt_at < now() + INTERVAL '61 seconds' AS scheduled
		FROM projection_sync_jobs
		WHERE id = ${jobId}
	`;
	expect(rows).toEqual([{ scheduled: true }]);
}
