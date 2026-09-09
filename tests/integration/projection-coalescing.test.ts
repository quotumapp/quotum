import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { createRecordingProjectionFetch, runProjectionWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("usage projection coalescing", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
		await setUsageDebounce(0);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("keeps one usage job per account, builds it at delivery, and re-arms it after success", async () => {
		const project = integrationProjectContext();
		const billingAccountId = "coalesced";
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "coalesced",
		});
		for (const key of ["one", "two"]) {
			await context.repository.consumeUsage(project, {
				billingAccountId,
				featureKey: "model_tokens",
				quantity: "100",
				idempotencyKey: key,
			});
		}

		const pending = await usageJobs(billingAccountId);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ status: "pending", payload: null });
		expect(pending[0]?.idempotency_key).toMatch(/^usage:/);

		const first = createRecordingProjectionFetch();
		await expect(
			runProjectionWorkerOnce({
				env: context.env,
				repository: context.repository,
				fetch: first.fetch,
			}),
		).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(first.requests).toHaveLength(1);
		expect(first.requests[0]?.body).toMatchObject({
			reason: "usage_changed",
			billingAccountId,
			sequence: 1,
			balances: [{ featureKey: "ai_credits", available: "9", held: "0" }],
		});
		expect((await usageJobs(billingAccountId))[0]).toMatchObject({ status: "succeeded" });

		await context.repository.consumeUsage(project, {
			billingAccountId,
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "three",
		});
		expect((await usageJobs(billingAccountId))[0]).toMatchObject({
			status: "pending",
			payload: null,
		});
		const second = createRecordingProjectionFetch();
		await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: second.fetch,
		});
		expect(second.requests).toHaveLength(1);
		expect(second.requests[0]?.body).toMatchObject({
			sequence: 2,
			balances: [{ featureKey: "ai_credits", available: "8.5" }],
		});
	});

	it("holds a usage job back for the project's debounce before it becomes claimable", async () => {
		await setUsageDebounce(5000);
		const project = integrationProjectContext();
		const billingAccountId = "debounced";
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "debounced",
		});
		await context.repository.consumeUsage(project, {
			billingAccountId,
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "debounced-one",
		});
		const [job] = await context.sql<Array<{ due_in_ms: number }>>`
			SELECT EXTRACT(EPOCH FROM (jobs.next_attempt_at - now())) * 1000 AS due_in_ms
			FROM projection_sync_jobs jobs
			JOIN customers c ON c.project_id = jobs.project_id AND c.id = jobs.customer_id
			WHERE jobs.reason = 'usage_changed' AND c.billing_account_id = ${billingAccountId}
		`;
		expect(Number(job?.due_in_ms)).toBeGreaterThan(2000);
		const recording = createRecordingProjectionFetch();
		await expect(
			runProjectionWorkerOnce({
				env: context.env,
				repository: context.repository,
				fetch: recording.fetch,
			}),
		).resolves.toEqual({ claimed: 0, succeeded: 0, failed: 0 });
	});

	it("marks usage jobs succeeded without delivering when the connection turns them off", async () => {
		const project = integrationProjectContext();
		const billingAccountId = "silent";
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "silent",
		});
		await context.repository.consumeUsage(project, {
			billingAccountId,
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "silent-one",
		});
		const recording = createRecordingProjectionFetch();
		await expect(
			runProjectionWorkerOnce({
				env: {
					...context.env,
					connectionFixtures: context.env.connectionFixtures.map((fixture) => ({
						...fixture,
						usageDelivery: "off" as const,
					})),
				},
				repository: context.repository,
				fetch: recording.fetch,
			}),
		).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(recording.requests).toHaveLength(0);
		expect((await usageJobs(billingAccountId))[0]).toMatchObject({ status: "succeeded" });
	});
});

async function setUsageDebounce(milliseconds: number): Promise<void> {
	await context.sql`
		INSERT INTO metering_settings (project_id, projection_usage_debounce_ms)
		SELECT id, ${milliseconds} FROM projects WHERE key = 'voysee'
		ON CONFLICT (project_id) DO UPDATE SET projection_usage_debounce_ms = EXCLUDED.projection_usage_debounce_ms
	`;
}

async function usageJobs(billingAccountId: string) {
	return await context.sql<
		Array<{ idempotency_key: string; status: string; payload: unknown; attempts: number }>
	>`
		SELECT jobs.idempotency_key, jobs.status, jobs.payload, jobs.attempts
		FROM projection_sync_jobs jobs
		JOIN customers c ON c.project_id = jobs.project_id AND c.id = jobs.customer_id
		WHERE jobs.reason = 'usage_changed' AND c.billing_account_id = ${billingAccountId}
		ORDER BY jobs.created_at
	`;
}
