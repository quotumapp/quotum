import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import { ensureUsageEventPartitions } from "../../src/db/repository/usage-partitions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;
let database: TransactionalQueryExecutor;

async function monthlyPartitions(): Promise<Array<{ name: string; from: Date; to: Date }>> {
	const rows = await context.sql<{ name: string; lower: Date; upper: Date }[]>`
		SELECT
			child.relname AS name,
			(regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM [(]''([^'']+)''[)]'))[1]::timestamptz AS lower,
			(regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO [(]''([^'']+)''[)]'))[1]::timestamptz AS upper
		FROM pg_inherits inherits
		JOIN pg_class child ON child.oid = inherits.inhrelid
		WHERE inherits.inhparent = 'usage_events'::regclass
			AND pg_get_expr(child.relpartbound, child.oid) <> 'DEFAULT'
		ORDER BY 2
	`;
	return rows.map((row) => ({
		name: row.name,
		from: new Date(row.lower),
		to: new Date(row.upper),
	}));
}

async function expectContiguousUntil(horizonMonths: number): Promise<void> {
	const partitions = await monthlyPartitions();
	for (const [index, partition] of partitions.entries()) {
		const previous = partitions[index - 1];
		if (previous !== undefined) expect(partition.from).toEqual(previous.to);
	}
	const [horizon] = await context.sql<{ at: Date }[]>`
		SELECT now() + make_interval(months => ${horizonMonths}::integer) AS at
	`;
	expect(partitions.at(-1)?.to.getTime()).toBeGreaterThan(new Date(horizon?.at ?? 0).getTime());
}

localDescribe("usage partition upkeep", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
		database = context.db as unknown as TransactionalQueryExecutor;
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("keeps a freshly migrated schema current", async () => {
		await expect(ensureUsageEventPartitions(database)).resolves.toMatchObject({
			status: "current",
			created: [],
		});
	});

	it("creates contiguous partitions up to a longer horizon, then stays current", async () => {
		const result = await ensureUsageEventPartitions(database, {
			horizonMonths: 30,
			maxCreates: 12,
		});
		expect(result.status).toBe("created");
		expect(result.created.length).toBeGreaterThan(0);
		for (const name of result.created) expect(name).toMatch(/^usage_events_\d{4}_\d{2}/);
		await expectContiguousUntil(30);
		await expect(ensureUsageEventPartitions(database, { horizonMonths: 30 })).resolves.toEqual({
			status: "current",
			created: [],
			coveredUntil: result.coveredUntil,
		});
	});

	it("lets concurrent runs create each partition once", async () => {
		const runs = await Promise.all([
			ensureUsageEventPartitions(database, { horizonMonths: 42, maxCreates: 24 }),
			ensureUsageEventPartitions(database, { horizonMonths: 42, maxCreates: 24 }),
		]);
		const created = runs.flatMap((run) => run.created);
		expect(new Set(created).size).toBe(created.length);
		for (const run of runs) expect(["created", "current", "locked"]).toContain(run.status);
		// A run that found the lock taken leaves the rest to the next poll.
		await ensureUsageEventPartitions(database, { horizonMonths: 42, maxCreates: 24 });
		await expectContiguousUntil(42);
	});

	it("reports a role that does not own usage_events as forbidden", async () => {
		const role = `quotum_partition_reader_${process.pid}`;
		await context.sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
		try {
			await context.sql.unsafe(`GRANT SELECT ON usage_events_default TO ${role}`);
			const asReader: TransactionalQueryExecutor = {
				execute: (query) => database.execute(query),
				transaction: (callback) =>
					database.transaction(async (tx) => {
						await tx.execute(drizzleSql.raw(`SET LOCAL ROLE ${role}`));
						return await callback(tx);
					}),
			};
			await expect(
				ensureUsageEventPartitions(asReader, { horizonMonths: 60 }),
			).resolves.toMatchObject({ status: "forbidden", created: [] });
		} finally {
			await context.sql.unsafe(`DROP OWNED BY ${role}`);
			await context.sql.unsafe(`DROP ROLE ${role}`);
		}
	});
});
