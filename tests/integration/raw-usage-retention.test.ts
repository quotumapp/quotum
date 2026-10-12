import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { sqlstateOf } from "../../src/db/postgres-errors";
import { executeRows } from "../../src/db/repository/query";
import { expiredRawUsageSql } from "../../src/db/repository/raw-usage-retention";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedUsageInvoicePeriods } from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

type ProjectKey = "acme" | "globex";

/** The metered feature and customer the seeded events belong to, created once per project. */
async function ensureSubject(projectKey: ProjectKey): Promise<void> {
	await context.sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit)
		SELECT id, 'retention_meter', 'Retention meter', 'metered', 'consumable', 'call'
		FROM projects WHERE key = ${projectKey}
		ON CONFLICT DO NOTHING
	`;
	await context.sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, 'retention-account' FROM projects WHERE key = ${projectKey}
		ON CONFLICT DO NOTHING
	`;
}

/** `count` consume events recorded `ageDays` ago (a day's spread), tagged so tests can tell them apart. */
async function seedEvents(
	projectKey: ProjectKey,
	count: number,
	ageDays: number,
	tag: string,
): Promise<void> {
	await ensureSubject(projectKey);
	await context.sql`
		INSERT INTO usage_events (
			recorded_at, project_id, customer_id, meter_feature_id, wallet_feature_id, operation,
			quantity, wallet_quantity, effective_at, rate_card_path, metadata
		)
		SELECT
			now() - make_interval(days => ${ageDays}) + (series.n * INTERVAL '1 second'),
			customer.project_id, customer.id, feature.id, feature.id, 'consume',
			1, 1, now(), 'direct', jsonb_build_object('tag', ${tag}::text)
		FROM projects project
		JOIN customers customer
			ON customer.project_id = project.id AND customer.billing_account_id = 'retention-account'
		JOIN features feature ON feature.project_id = project.id AND feature.key = 'retention_meter'
		CROSS JOIN generate_series(1, ${count}) AS series(n)
		WHERE project.key = ${projectKey}
	`;
}

async function remainingByTag(): Promise<Record<string, number>> {
	const rows = await context.sql<Array<{ tag: string; events: number }>>`
		SELECT metadata->>'tag' AS tag, count(*)::integer AS events
		FROM usage_events
		GROUP BY 1
		ORDER BY 1
	`;
	return Object.fromEntries(rows.map((row) => [row.tag, row.events]));
}

localDescribe("Raw usage retention", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("applies each project's own retention window", async () => {
		await context.sql`
			INSERT INTO metering_settings (project_id, raw_usage_retention_days)
			SELECT id, 30 FROM projects WHERE key = 'globex'
			ON CONFLICT (project_id) DO UPDATE SET raw_usage_retention_days = 30
		`;
		await seedEvents("acme", 3, 401, "acme-401");
		await seedEvents("acme", 3, 40, "acme-40");
		await seedEvents("globex", 3, 40, "globex-40");
		await seedEvents("globex", 3, 10, "globex-10");

		const result = await context.repository.runMeteringMaintenance(100);

		expect(result.deletedRawUsageEvents).toBe(6);
		expect(await remainingByTag()).toEqual({ "acme-40": 3, "globex-10": 3 });
	});

	it("keeps an event a usage invoice adjustment references and deletes the rest", async () => {
		await seedEvents("acme", 4, 401, "expired");
		const [period] = await seedUsageInvoicePeriods(context.sql, 1);
		await context.sql`
			INSERT INTO usage_invoice_adjustments (
				project_id, closed_period_id, usage_event_id, usage_event_recorded_at,
				quantity, amount_minor, currency
			)
			SELECT event.project_id, ${period ?? ""}::uuid, event.id, event.recorded_at, -1, -100, 'USD'
			FROM (
				SELECT project_id, id, recorded_at FROM usage_events ORDER BY recorded_at, id LIMIT 1
			) event
		`;

		// The reference is a RESTRICT foreign key: before the fix the delete failed here and every
		// later pass failed the same way, because the oldest row is always the referenced one.
		const first = await context.repository.runMeteringMaintenance(100);
		const second = await context.repository.runMeteringMaintenance(100);

		expect(first.deletedRawUsageEvents).toBe(3);
		expect(second.deletedRawUsageEvents).toBe(0);
		expect(await remainingByTag()).toEqual({ expired: 1 });
	});

	it("drains a backlog within one pass and stops when a batch is not full", async () => {
		await seedEvents("acme", 1_000, 401, "backlog");

		const result = await context.repository.runMeteringMaintenance(100);

		expect(result.deletedRawUsageEvents).toBe(1_000);
		expect(await remainingByTag()).toEqual({});
	});

	it("runs a single batch when the retention budget is spent", async () => {
		await seedEvents("acme", 350, 401, "backlog");

		const result = await context.repository.runMeteringMaintenance(100, { retentionBudgetMs: 0 });

		expect(result.deletedRawUsageEvents).toBe(100);
		expect(await remainingByTag()).toEqual({ backlog: 250 });
	});

	it("commits the state transitions even when a retention batch fails", async () => {
		await seedEvents("acme", 2, 401, "expired");
		await context.sql`
			INSERT INTO usage_event_rollups (
				project_id, customer_id, meter_feature_id, period_start_at, period_end_at
			)
			SELECT customer.project_id, customer.id, feature.id,
				now() - INTERVAL '2 months', now() - INTERVAL '1 month'
			FROM customers customer
			JOIN features feature
				ON feature.project_id = customer.project_id AND feature.key = 'retention_meter'
			WHERE customer.billing_account_id = 'retention-account'
		`;
		await context.sql.unsafe(`
			CREATE OR REPLACE FUNCTION retention_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'retention test failure'; END $$;
			CREATE TRIGGER retention_test_fail BEFORE DELETE ON usage_events_default
				FOR EACH ROW EXECUTE FUNCTION retention_test_fail();
		`);
		try {
			let failure: unknown = null;
			try {
				await context.repository.runMeteringMaintenance(100);
			} catch (error) {
				failure = error;
			}
			// P0001 is the trigger's RAISE EXCEPTION: the retention statement itself failed.
			expect(sqlstateOf(failure)).toBe("P0001");
		} finally {
			await context.sql.unsafe(`
				DROP TRIGGER IF EXISTS retention_test_fail ON usage_events_default;
				DROP FUNCTION IF EXISTS retention_test_fail();
			`);
		}

		const [rollup] = await context.sql<Array<{ status: string }>>`
			SELECT status FROM usage_event_rollups
		`;
		expect(rollup?.status).toBe("closed");
		expect(await remainingByTag()).toEqual({ expired: 2 });
	});

	it("finds nothing to delete without reading the retained events", async () => {
		// Real partitions: events from the last three weeks, none past retention.
		for (const ageDays of [1, 5, 9, 13, 17, 21]) {
			await seedEvents("acme", 3_500, ageDays, `age-${ageDays}`);
		}
		await seedEvents("globex", 10, 2, "globex");
		await context.sql`ANALYZE usage_events`;

		const database = context.db as unknown as TransactionalQueryExecutor;
		const buffers = await database.transaction(async (tx) => {
			const [row] = await executeRows<Record<string, unknown>>(
				tx,
				drizzleSql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${expiredRawUsageSql(250)}`,
			);
			const document = row?.["QUERY PLAN"];
			const [entry] = (typeof document === "string" ? JSON.parse(document) : document) as Array<{
				Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
			}>;
			return (
				(entry?.Plan["Shared Hit Blocks"] ?? Number.POSITIVE_INFINITY) +
				(entry?.Plan["Shared Read Blocks"] ?? 0)
			);
		});

		// 21,010 events are retained. Walking them would cost thousands of buffers; one index probe
		// per project costs a few dozen.
		expect(buffers).toBeLessThan(300);
	});
});
