import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { sqlstateOf } from "../../src/db/postgres-errors";
import { RepositoryModule } from "../../src/db/repository/base";
import type { QueryExecutor } from "../../src/db/repository/types";
import { createDeferred } from "../helpers/deferred";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/** `transaction` is protected; the production retry loop sits behind it. */
class ProbeModule extends RepositoryModule {
	run<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
		return this.transaction(callback);
	}
}

localDescribe("transaction deadlock retry", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("retries a real 40P01 loser until both transactions commit", async () => {
		const projectId = integrationProjectContext().projectInstanceId;
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			VALUES (${projectId}, ${"deadlock-a"}), (${projectId}, ${"deadlock-b"})
		`;
		// Read the baseline from the database clock: the container's clock can drift from the host's.
		// As text it keeps the microseconds a JS Date would drop.
		const [clock] = await context.sql<Array<{ baseline: string }>>`
			SELECT clock_timestamp()::text AS baseline
		`;
		if (clock === undefined) throw new Error("Expected the database clock");
		const probe = new ProbeModule(context.db as never);
		const attempts = { a: 0, b: 0 };
		const firstLockHeld = { a: createDeferred(), b: createDeferred() };

		// Opposite lock orders on two rows. On the first attempt each transaction waits until both
		// hold their first row before asking for the other one, so the deadlock happens however long
		// either connection takes to open. Postgres aborts one loser with 40P01 after
		// `deadlock_timeout`, lowered here from its 1 s default and far under the pool's 30 s
		// statement timeout; the winner commits and the loser re-runs without waiting.
		const conflictingTransaction = (first: string, second: string, key: "a" | "b") =>
			probe.run(async (tx) => {
				attempts[key] += 1;
				await tx.execute(drizzleSql`SET LOCAL deadlock_timeout = '100ms'`);
				await tx.execute(
					drizzleSql`UPDATE customers SET updated_at = now()
						WHERE project_id = ${projectId} AND billing_account_id = ${first}`,
				);
				if (attempts[key] === 1) {
					firstLockHeld[key].resolve();
					await Promise.all([firstLockHeld.a.promise, firstLockHeld.b.promise]);
				}
				await tx.execute(
					drizzleSql`UPDATE customers SET updated_at = now()
						WHERE project_id = ${projectId} AND billing_account_id = ${second}`,
				);
			});

		await Promise.all([
			conflictingTransaction("deadlock-a", "deadlock-b", "a"),
			conflictingTransaction("deadlock-b", "deadlock-a", "b"),
		]);

		expect(attempts.a + attempts.b).toBe(3);
		expect(Math.max(attempts.a, attempts.b)).toBe(2);
		expect(Math.min(attempts.a, attempts.b)).toBe(1);

		const rows = await context.sql<Array<{ billing_account_id: string }>>`
			SELECT billing_account_id FROM customers
			WHERE project_id = ${projectId}
				AND billing_account_id IN (${"deadlock-a"}, ${"deadlock-b"})
				AND updated_at > ${clock.baseline}::timestamptz
			ORDER BY billing_account_id
		`;
		expect(rows.map((row) => row.billing_account_id)).toEqual(["deadlock-a", "deadlock-b"]);
	});

	it("does not retry a unique violation and rolls its transaction back", async () => {
		const projectId = integrationProjectContext().projectInstanceId;
		const probe = new ProbeModule(context.db as never);
		let attempts = 0;
		let captured: unknown = null;

		try {
			await probe.run(async (tx) => {
				attempts += 1;
				await tx.execute(
					drizzleSql`INSERT INTO customers (project_id, billing_account_id)
						VALUES (${projectId}, ${"deadlock-dup"})`,
				);
				await tx.execute(
					drizzleSql`INSERT INTO customers (project_id, billing_account_id)
						VALUES (${projectId}, ${"deadlock-dup"})`,
				);
			});
		} catch (error) {
			captured = error;
		}

		expect(attempts).toBe(1);
		expect(sqlstateOf(captured)).toBe("23505");
		const [remaining] = await context.sql<Array<{ count: number }>>`
			SELECT count(*)::int AS count FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${"deadlock-dup"}
		`;
		expect(remaining?.count).toBe(0);
	});
});
