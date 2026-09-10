import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { ProjectionSyncReason } from "../../src/billing/types";
import { createLocalProjectionReceiver } from "../helpers/projection-receiver";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectProjectionJob, expectStoreEvent, expectTableCounts } from "./helpers/db-assertions";
import { stripeCheckoutSessionObject, stripeEvent } from "./helpers/fake-provider-clients";
import { makeProjectionJobDue } from "./helpers/job-time-travel";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
	withProjectionUrl,
} from "./helpers/local-postgres";
import { createRecordingProjectionFetch, runProjectionWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Failure modes integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("recovers projection delivery after receiver outages", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "voysee-projection-secret" });
		receiver.queueResponses(
			{ status: 503, body: { success: false } },
			{ status: 503, body: { success: false } },
		);
		const env = withProjectionUrl(context.env, receiver.url);

		try {
			await ingestStripeCheckout(env, "evt_checkout");
			const pendingJob = await expectProjectionJob(context.sql, {
				billingAccountId: "integration_user",
				reason: "provider_webhook",
				status: "pending",
			});

			const first = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(1, 1000);
			expect(first).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
			await expectProjectionAttempt(context.sql, pendingJob.id, {
				status: "pending",
				attempts: 1,
				lastErrorIncludes: "status 503",
			});

			await makeProjectionJobDue(context.sql, pendingJob.id);
			const second = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(2, 1000);
			expect(second).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
			await expectProjectionAttempt(context.sql, pendingJob.id, {
				status: "pending",
				attempts: 2,
				lastErrorIncludes: "status 503",
			});

			await makeProjectionJobDue(context.sql, pendingJob.id);
			const third = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(3, 1000);
			expect(third).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
			await expectProjectionAttempt(context.sql, pendingJob.id, {
				status: "succeeded",
				attempts: 2,
				lastErrorIncludes: null,
			});
			expect(new Set(receiver.requests.map((request) => request.body.jobId))).toEqual(
				new Set([pendingJob.id]),
			);
			expect(new Set(receiver.requests.map((request) => request.body.idempotencyKey))).toEqual(
				new Set([pendingJob.idempotency_key]),
			);
			expect(receiver.requests.every((request) => request.signatureOk)).toBe(true);
		} finally {
			receiver.stop();
		}
	});

	it("records concurrent duplicate Stripe webhooks exactly once", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_duplicate",
			),
		});

		const responses = await Promise.all(
			Array.from({ length: 5 }, () => postStripeWebhook(fixture, { id: "evt_duplicate" })),
		);

		expect(responses.every((response) => response.status < 500)).toBe(true);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
	});

	it("records concurrent duplicate Apple verifications exactly once", async () => {
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		await createAppleAccountToken(fixture);

		const responses = await Promise.all(
			Array.from({ length: 4 }, () => verifyAppleSubscription(fixture)),
		);

		expect(responses.every((response) => response.status < 500)).toBe(true);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
	});

	it("clears locks after a mixed projection run with one failed job", async () => {
		const jobs = await seedProjectionJobs(context.sql, 3);
		const projection = createRecordingProjectionFetch();
		const fetch = async (url: string, init: RequestInit) => {
			const rawBody = String(init.body ?? "{}");
			const body = JSON.parse(rawBody) as { idempotencyKey?: string };
			if (body.idempotencyKey === jobs[1].idempotency_key) {
				return new Response(JSON.stringify({ success: false }), { status: 503 });
			}
			return projection.fetch(url, init);
		};

		const result = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch,
		});

		expect(result).toEqual({ claimed: 3, succeeded: 2, failed: 1 });
		await expectProjectionJobStatus(context.sql, jobs[0].id, "succeeded");
		await expectProjectionJobStatus(context.sql, jobs[1].id, "pending");
		await expectProjectionJobStatus(context.sql, jobs[2].id, "succeeded");
		await expectProjectionAttempt(context.sql, jobs[1].id, {
			status: "pending",
			attempts: 1,
			lastErrorIncludes: "status 503",
		});
		await expectNoProcessingProjectionJobs(context.sql);
	});

	it("keeps ingestion available while projection delivery fails", async () => {
		const env = withProjectionUrl(context.env, "https://voysee.projection.integration.test");
		const response = await ingestStripeCheckout(env, "evt_delivery_down");
		expect(response.status).toBe(200);
		const storeEvent = await expectStoreEvent(context.sql, {
			provider: "stripe",
			eventType: "checkout.session.completed",
			status: "processed",
		});
		expect(storeEvent.processing_error).toBeNull();
		const job = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "provider_webhook",
			status: "pending",
		});

		const first = await runProjectionWorkerOnce({
			env,
			repository: context.repository,
			fetch: createRecordingProjectionFetch(
				new Response(JSON.stringify({ success: false }), { status: 503 }),
			).fetch,
		});
		expect(first).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
		await makeProjectionJobDue(context.sql, job.id);
		const second = await runProjectionWorkerOnce({
			env,
			repository: context.repository,
			fetch: createRecordingProjectionFetch(new Error("receiver unavailable")).fetch,
		});

		expect(second).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
		await expectProjectionAttempt(context.sql, job.id, {
			status: "pending",
			attempts: 2,
			lastErrorIncludes: "receiver unavailable",
		});
	});
});

async function ingestStripeCheckout(
	env: LocalPostgresContext["env"],
	eventId: string,
): Promise<Response> {
	const fixture = createIntegrationApp({
		env,
		repository: context.repository,
		stripeEvent: stripeEvent("checkout.session.completed", stripeCheckoutSessionObject(), eventId),
	});
	return await postStripeWebhook(fixture, { id: eventId });
}

async function postStripeWebhook(
	fixture: ReturnType<typeof createIntegrationApp>,
	body: Record<string, unknown>,
): Promise<Response> {
	return await fixture.app.request("/v1/projects/voysee/webhooks/stripe", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": "sig_test",
		},
		body: JSON.stringify({
			type: "checkout.session.completed",
			data: { object: {} },
			...body,
		}),
	});
}

async function createAppleAccountToken(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<void> {
	const response = await fixture.app.request(
		"/v1/billing-accounts/integration_user/providers/apple/account-token",
		{ headers: fixture.authHeaders("voysee") },
	);
	const body = await response.json();
	expect(response.status).toBe(200);
	fixture.apple.setAppAccountToken(body.data.appAccountToken);
}

async function verifyAppleSubscription(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders("voysee"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "apple",
			billingAccountId: "integration_user",
			transactionId: "200000000000001",
		}),
	});
}

async function seedProjectionJobs(
	sql: SQL,
	count: number,
): Promise<Array<{ id: string; idempotency_key: string }>> {
	const jobs: Array<{ id: string; idempotency_key: string }> = [];
	for (let index = 0; index < count; index += 1) {
		const billingAccountId = `failure_user_${index}`;
		const idempotencyKey = `failure:projection:${index}`;
		const payload = {
			billingAccountId,
			generatedAt: "2026-06-01T00:00:00.000Z",
			entitlements: {
				billingAccountId,
				entitlements: [],
				generatedAt: "2026-06-01T00:00:00.000Z",
			},
			balances: [],
			reason: "provider_webhook" satisfies ProjectionSyncReason,
		};
		const rows = await sql<{ id: string; idempotency_key: string }[]>`
			WITH project_row AS (
				SELECT id
				FROM projects
				WHERE key = 'voysee'
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
				'provider_webhook', ${JSON.stringify(payload)}::text::jsonb, 'pending', now() - INTERVAL '1 second'
			FROM customer_row
			RETURNING id, idempotency_key
		`;
		expect(rows).toHaveLength(1);
		jobs.push(rows[0]);
	}
	return jobs;
}

async function expectProjectionAttempt(
	sql: SQL,
	jobId: string,
	expected: { status: string; attempts: number; lastErrorIncludes: string | null },
): Promise<void> {
	const rows = await sql<
		{ status: string; attempts: number; last_error: string | null; locked_by: string | null }[]
	>`
		SELECT status, attempts, last_error, locked_by
		FROM projection_sync_jobs
		WHERE id = ${jobId}
	`;
	expect(rows).toHaveLength(1);
	expect(rows[0].status).toBe(expected.status);
	expect(rows[0].attempts).toBe(expected.attempts);
	expect(rows[0].locked_by).toBeNull();
	if (expected.lastErrorIncludes === null) {
		expect(rows[0].last_error).toBeNull();
	} else {
		expect(rows[0].last_error).toContain(expected.lastErrorIncludes);
	}
}

async function expectProjectionJobStatus(
	sql: SQL,
	jobId: string,
	status: "pending" | "succeeded",
): Promise<void> {
	const rows = await sql<{ status: string; locked_by: string | null }[]>`
		SELECT status, locked_by
		FROM projection_sync_jobs
		WHERE id = ${jobId}
	`;
	expect(rows).toEqual([{ status, locked_by: null }]);
}

async function expectNoProcessingProjectionJobs(sql: SQL): Promise<void> {
	const rows = await sql<{ count: string }[]>`
		SELECT count(*)::text AS count
		FROM projection_sync_jobs
		WHERE status = 'processing'
			OR locked_at IS NOT NULL
			OR locked_by IS NOT NULL
	`;
	expect(rows).toEqual([{ count: "0" }]);
}
