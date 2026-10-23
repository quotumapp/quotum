import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { calculateRetryDelayMs } from "../../src/workers/backoff";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedAutoTopupJobs } from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;
localDescribe("database worker scheduling under host clock skew", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterEach(() => setSystemTime());
	afterAll(() => context.sql.close());
	it.each([-2, 2])("keeps a %i-day skew out of retries and lease eligibility", async (skewDays) => {
		await seedAutoTopupJobs(context.sql, context.repository, 1);
		const [clock] = await context.sql`SELECT clock_timestamp() AS now`;
		setSystemTime(new Date(clock.now.getTime() + skewDays * 86_400_000));
		const [job] = await context.repository.claimAutoTopupJobs("a", 1, 300_000);
		expect(job).toBeDefined();
		expect(await context.repository.claimAutoTopupJobs("b", 1, 300_000)).toEqual([]);
		await context.sql`UPDATE auto_topup_jobs SET locked_at = clock_timestamp() - interval '6 minutes'`;
		const [reclaimed] = await context.repository.claimAutoTopupJobs("b", 1, 300_000);
		expect(reclaimed.jobId).toBe(job.jobId);
		await context.repository.markAutoTopupFailed(job.projectId, job.jobId, "b", {
			kind: "retryable",
			error: "network",
			retryDelayMs: calculateRetryDelayMs({ attempts: 0, maxAttempts: 12, jitterMs: 0 }),
		});
		const [row] = await context.sql`SELECT next_attempt_at <= clock_timestamp() AS due,
   extract(epoch FROM next_attempt_at - clock_timestamp()) AS delay,
   locked_by, budget_reserved_at FROM auto_topup_jobs WHERE id = ${job.jobId}::uuid`;
		expect(row.due).toBe(false);
		expect(Number(row.delay)).toBeGreaterThan(55);
		expect(Number(row.delay)).toBeLessThanOrEqual(60);
		expect(row.locked_by).toBeNull();
		expect(row.budget_reserved_at).toBeNull();
		expect(await context.repository.claimAutoTopupJobs("c", 1, 300_000)).toEqual([]);
	});
});
