import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import {
	allocationRowsSql,
	expiredSubjectReservationsSql,
} from "../../src/db/repository/metering-persistence";
import { executeRows } from "../../src/db/repository/query";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import { renderDrizzleSql, renderDrizzleSqlParams } from "../helpers/drizzle-sql";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

const SETTLED_RESERVATIONS = 50_000;
const BILLING_ACCOUNT = "history";

/** What `EXPLAIN (ANALYZE, BUFFERS)` reports for one execution of the statement. */
interface Measured {
	buffers: number;
	plan: string;
}

function literal(value: unknown): string {
	return value === null || value === undefined
		? "NULL"
		: `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Runs the statement the way the service does once a prepared statement has gone generic (after
 * five executions it stops being planned for its own parameter values), which is what a busy
 * account's reads use. A custom plan sees the values and, for an account whose reservations are
 * mostly settled, mistakes it for one with thousands open.
 */
async function measureGeneric(statement: DrizzleSQL): Promise<Measured> {
	const text = renderDrizzleSql(statement).replace(/\n-- params:.*$/s, "");
	const params = renderDrizzleSqlParams(statement).map(literal).join(", ");
	const database = context.db as unknown as TransactionalQueryExecutor;
	return await database.transaction(async (tx) => {
		await tx.execute(drizzleSql.raw(`SET LOCAL plan_cache_mode = force_generic_plan`));
		await tx.execute(drizzleSql.raw(`PREPARE history_probe AS ${text}`));
		const [row] = await executeRows<Record<string, unknown>>(
			tx,
			drizzleSql.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE history_probe(${params})`),
		);
		const document = row?.["QUERY PLAN"];
		const [entry] = (typeof document === "string" ? JSON.parse(document) : document) as Array<{
			Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
		}>;
		return {
			buffers:
				(entry?.Plan["Shared Hit Blocks"] ?? Number.POSITIVE_INFINITY) +
				(entry?.Plan["Shared Read Blocks"] ?? 0),
			plan: JSON.stringify(entry),
		};
	});
}

/** The plan text for the statement planned for its own parameter values. */
async function customPlan(statement: DrizzleSQL): Promise<string> {
	const database = context.db as unknown as TransactionalQueryExecutor;
	return await database.transaction(async (tx) => {
		const rows = await executeRows<Record<string, string>>(
			tx,
			drizzleSql`EXPLAIN (COSTS OFF) ${statement}`,
		);
		return rows.map((row) => Object.values(row).join("")).join("\n");
	});
}

localDescribe("Reservation history", () => {
	let customerId: string;
	let projectId: string;
	let walletFeatureId: string;

	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
		const project = integrationProjectContext();
		await context.repository.grantAllocation(project, {
			billingAccountId: BILLING_ACCOUNT,
			featureKey: "ai_credits",
			quantity: "100000",
			sourceKind: "credit_grant",
			sourceKey: "history",
		});
		// Three reservations that are really open: the only ones a balance should count.
		for (const key of ["a", "b", "c"]) {
			await context.repository.reserveUsage(project, {
				billingAccountId: BILLING_ACCOUNT,
				featureKey: "model_tokens",
				quantity: "100",
				expiresInSeconds: 3600,
				idempotencyKey: `history:${key}`,
			});
		}
		// A long history of settled ones, each with the hold row it left behind.
		await context.sql`
			INSERT INTO reservations (
				project_id, customer_id, entity_id, meter_feature_id, wallet_feature_id,
				rate_card_entry_id, rate_card_revision_id, rate_card_path, requested_quantity,
				held_quantity, confirmed_quantity, status, effective_at, expires_at, finalized_at,
				created_at, updated_at
			)
			SELECT r.project_id, r.customer_id, r.entity_id, r.meter_feature_id, r.wallet_feature_id,
				r.rate_card_entry_id, r.rate_card_revision_id, r.rate_card_path, 1, 1, 1, 'confirmed',
				now() - (series.n * INTERVAL '1 second') - INTERVAL '1 day',
				now() - (series.n * INTERVAL '1 second') - INTERVAL '1 day' + INTERVAL '5 minutes',
				now() - (series.n * INTERVAL '1 second') - INTERVAL '1 day',
				now() - (series.n * INTERVAL '1 second') - INTERVAL '1 day', now()
			FROM (SELECT * FROM reservations WHERE status = 'active' LIMIT 1) r
			CROSS JOIN generate_series(1, ${SETTLED_RESERVATIONS}) AS series(n)
		`;
		await context.sql`
			INSERT INTO reservation_allocations (
				project_id, reservation_id, allocation_id, held_quantity, consumed_quantity
			)
			SELECT r.project_id, r.id, source.allocation_id, 1, 1
			FROM reservations r
			CROSS JOIN (SELECT allocation_id FROM reservation_allocations LIMIT 1) source
			WHERE r.status = 'confirmed'
		`;
		// Open reservations of other accounts: with only this customer's three in the table, the
		// planner reaches them through the small active-expiry index whatever the history holds.
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT customer.project_id, concat('noise-', series.n)
			FROM (SELECT project_id FROM customers LIMIT 1) customer
			CROSS JOIN generate_series(1, 200) AS series(n)
		`;
		await context.sql`
			INSERT INTO reservations (
				project_id, customer_id, meter_feature_id, wallet_feature_id, rate_card_entry_id,
				rate_card_revision_id, rate_card_path, requested_quantity, held_quantity, status,
				effective_at, expires_at
			)
			SELECT r.project_id, noise.id, r.meter_feature_id, r.wallet_feature_id, r.rate_card_entry_id,
				r.rate_card_revision_id, r.rate_card_path, 1, 1, 'active', now(),
				now() + (series.n * INTERVAL '1 minute')
			FROM (SELECT * FROM reservations WHERE status = 'active' LIMIT 1) r
			JOIN customers noise ON noise.billing_account_id LIKE 'noise-%'
			CROSS JOIN generate_series(1, 100) AS series(n)
		`;
		await context.sql`ANALYZE reservations`;
		await context.sql`ANALYZE reservation_allocations`;
		const [row] = await context.sql<Array<{ project: string; customer: string; wallet: string }>>`
			SELECT customer.project_id::text AS project, customer.id::text AS customer,
				feature.id::text AS wallet
			FROM customers customer
			JOIN features feature
				ON feature.project_id = customer.project_id AND feature.key = 'ai_credits'
			WHERE customer.billing_account_id = ${BILLING_ACCOUNT}
		`;
		projectId = row?.project ?? "";
		customerId = row?.customer ?? "";
		walletFeatureId = row?.wallet ?? "";
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("counts only the open reservations as held", async () => {
		const balance = await context.repository.getMeteringBalance(
			integrationProjectContext(),
			BILLING_ACCOUNT,
			"ai_credits",
		);

		// Three reservations of 100 requests at 0.005 each.
		expect(balance).toMatchObject({ held: "1.5", consumed: "0" });
	});

	it("looks for expired reservations without reading the settled ones", async () => {
		const sweep = expiredSubjectReservationsSql(projectId, BILLING_ACCOUNT);

		const measured = await measureGeneric(sweep);

		// Walking the account's 50,003 reservations cost hundreds of buffers; the three open ones
		// cost a handful.
		expect(measured.plan).toContain("idx_billing_reservations_customer_active");
		expect(measured.buffers).toBeLessThan(50);
	});

	it("sums held quantities from the open reservations, not every hold an allocation had", async () => {
		const rows = allocationRowsSql(projectId, customerId, walletFeatureId, null);

		const measured = await measureGeneric(rows);

		// Reading `reservation_allocations` by allocation visited all 50,000 settled holds.
		expect(measured.plan).toContain("idx_billing_reservations_customer_active");
		expect(measured.buffers).toBeLessThan(50);
	});

	it("never reads the whole hold table, whatever the planner thinks of the account", async () => {
		// Planned for this account's own values it looks like one with thousands of open
		// reservations; a hash join against `reservation_allocations` would then read every hold.
		const plan = await customPlan(allocationRowsSql(projectId, customerId, walletFeatureId, null));

		expect(plan).not.toContain("Seq Scan on reservation_allocations");
		expect(plan).toContain("Index Scan using reservation_allocations_pkey");
	});
});
