import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { executeRows } from "../../src/db/repository/query";
import {
	dueProviderReconciliationsSql,
	expiredSubscriptionCandidatesSql,
} from "../../src/db/repository/subscription-reconciliation";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedReconciliationSubscriptions } from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/**
 * Plans a worker statement with sequential scans off, so the plan names an index only when the
 * statement can use one and the statistics make it cheaper than the alternatives.
 */
async function plan(statement: DrizzleSQL): Promise<string> {
	const database = context.db as unknown as TransactionalQueryExecutor;
	const lines = await database.transaction(async (tx) => {
		await tx.execute(drizzleSql`SET LOCAL enable_seqscan = off`);
		return await executeRows<Record<string, string>>(
			tx,
			drizzleSql`EXPLAIN (COSTS OFF) ${statement}`,
		);
	});
	return lines.map((line) => Object.values(line).join("")).join("\n");
}

/** A table the way production has it: a handful of rows due, almost all of them not yet. */
async function seedMostlyIdleSubscriptions(): Promise<void> {
	const ids = await seedReconciliationSubscriptions(context.sql, 1_000);
	await context.sql`
		UPDATE subscriptions
		SET provider_reconciliation_next_attempt_at = now() + INTERVAL '6 hours',
			status = CASE WHEN random() < 0.5 THEN 'expired' ELSE status END
		WHERE id IN ${context.sql(ids.slice(10))}
	`;
	await context.sql`ANALYZE subscriptions`;
}

localDescribe("Subscription reconciliation index use", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedMostlyIdleSubscriptions();
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("claims due subscriptions through the reconciliation index, expired ones included", async () => {
		const claim = await plan(dueProviderReconciliationsSql(100, new Date()));

		expect(claim).toContain("idx_billing_subscriptions_provider_reconciliation_due");
	});

	it("finds subscriptions past their expiry through the expiry index", async () => {
		const candidates = await plan(expiredSubscriptionCandidatesSql(100));

		expect(candidates).toContain("idx_billing_subscriptions_expiry_due");
	});
});
