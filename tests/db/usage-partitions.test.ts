import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createPartitionStatement,
	ensureUsageEventPartitions,
	nextUsagePartition,
} from "../../src/db/repository/usage-partitions";
import { FakeDatabase } from "./repository-fixture";

const locked = [{ acquired: true }];

describe("nextUsagePartition", () => {
	it("continues with whole UTC months after a UTC month boundary", () => {
		expect(nextUsagePartition(new Date("2028-09-01T00:00:00.000Z"))).toEqual({
			name: "usage_events_2028_09",
			from: new Date("2028-09-01T00:00:00.000Z"),
			to: new Date("2028-10-01T00:00:00.000Z"),
		});
		expect(nextUsagePartition(new Date("2028-12-01T00:00:00.000Z"))).toMatchObject({
			name: "usage_events_2028_12",
			to: new Date("2029-01-01T00:00:00.000Z"),
		});
	});

	it("bridges to the next UTC month after partitions made in another session time zone", () => {
		// Migration 003 ran at +02:00: its last partition ends at local midnight.
		expect(nextUsagePartition(new Date("2028-08-31T22:00:00.000Z"))).toEqual({
			name: "usage_events_2028_08_31t2200",
			from: new Date("2028-08-31T22:00:00.000Z"),
			to: new Date("2028-09-01T00:00:00.000Z"),
		});
		// ...or at -04:00, where it ends after the UTC boundary.
		expect(nextUsagePartition(new Date("2028-09-01T04:00:00.000Z"))).toEqual({
			name: "usage_events_2028_09_01t0400",
			from: new Date("2028-09-01T04:00:00.000Z"),
			to: new Date("2028-10-01T00:00:00.000Z"),
		});
	});
});

describe("createPartitionStatement", () => {
	it("renders a range partition with UTC bounds", () => {
		expect(createPartitionStatement(nextUsagePartition(new Date("2028-09-01T00:00:00.000Z")))).toBe(
			"CREATE TABLE usage_events_2028_09 PARTITION OF usage_events FOR VALUES FROM ('2028-09-01T00:00:00.000Z') TO ('2028-10-01T00:00:00.000Z')",
		);
	});

	it("refuses names and ranges it did not compute", () => {
		const from = new Date("2028-09-01T00:00:00.000Z");
		const to = new Date("2028-10-01T00:00:00.000Z");
		for (const name of ["usage_events_2028_09; DROP TABLE usage_events", "events_2028_09", ""])
			expect(() => createPartitionStatement({ name, from, to })).toThrow(
				"Refusing to create an invalid usage partition",
			);
		expect(() =>
			createPartitionStatement({ name: "usage_events_2028_09", from: to, to: from }),
		).toThrow("Refusing to create an invalid usage partition");
	});
});

describe("ensureUsageEventPartitions", () => {
	it("does nothing while another process holds the upkeep or migration lock", async () => {
		const database = new FakeDatabase([[], [{ acquired: false }]], { strict: true });
		expect(await ensureUsageEventPartitions(database as never)).toEqual({
			status: "locked",
			created: [],
			coveredUntil: null,
		});
		expect(database.queries[0]).toContain("set_config('lock_timeout', '1s', true)");
		expect(database.queries[0]).toContain("set_config('TimeZone', 'UTC', true)");
		expect(database.queries[1]).toContain("pg_try_advisory_xact_lock(hashtextextended(");
		expect(database.queries[1]).toContain("pg_try_advisory_xact_lock_shared(");
		expect(database.params[1]).toEqual([760_911, 520_384_001]);
		expect(database.queries).toHaveLength(2);
	});

	it("reports current coverage without touching the default partition", async () => {
		const database = new FakeDatabase(
			[[], locked, [{ covered_until: new Date("2028-10-01T00:00:00.000Z"), ready: true }]],
			{ strict: true },
		);
		expect(await ensureUsageEventPartitions(database as never, { horizonMonths: 12 })).toEqual({
			status: "current",
			created: [],
			coveredUntil: "2028-10-01T00:00:00.000Z",
		});
		expect(database.queries[2]).toContain("pg_get_expr(child.relpartbound, child.oid)");
		expect(database.queries[2]).toContain("inherits.inhparent = 'usage_events'::regclass");
		expect(database.params[2]).toEqual([12]);
		database.assertConsumed();
	});

	it("creates contiguous partitions, one transaction each, until the horizon", async () => {
		const database = new FakeDatabase(
			[
				[],
				locked,
				[{ covered_until: "2027-09-01 00:00:00+00", ready: false }],
				[{ occupied: false }],
				[],
				[],
				locked,
				[{ covered_until: "2027-10-01 00:00:00+00", ready: true }],
			],
			{ strict: true },
		);
		expect(await ensureUsageEventPartitions(database as never)).toEqual({
			status: "created",
			created: ["usage_events_2027_09"],
			coveredUntil: "2027-10-01T00:00:00.000Z",
		});
		expect(database.queries[3]).toStartWith(
			"SELECT EXISTS (SELECT 1 FROM usage_events_default) AS occupied",
		);
		expect(database.queries[4]).toStartWith(
			"CREATE TABLE usage_events_2027_09 PARTITION OF usage_events FOR VALUES FROM ('2027-09-01T00:00:00.000Z') TO ('2027-10-01T00:00:00.000Z')",
		);
		database.assertConsumed();
	});

	it("stops after the per-run limit and continues on the next run", async () => {
		const step = (coveredUntil: string) => [
			[],
			locked,
			[{ covered_until: coveredUntil, ready: false }],
			[{ occupied: false }],
			[],
		];
		const database = new FakeDatabase(
			[...step("2027-09-01T00:00:00.000Z"), ...step("2027-10-01T00:00:00.000Z")],
			{ strict: true },
		);
		expect(await ensureUsageEventPartitions(database as never, { maxCreates: 2 })).toEqual({
			status: "created",
			created: ["usage_events_2027_09", "usage_events_2027_10"],
			coveredUntil: "2027-11-01T00:00:00.000Z",
		});
		database.assertConsumed();
	});

	it("reports its creations and bound when another process takes the lock mid-run", async () => {
		const database = new FakeDatabase(
			[
				[],
				locked,
				[{ covered_until: "2027-09-01T00:00:00.000Z", ready: false }],
				[{ occupied: false }],
				[],
				[],
				[{ acquired: false }],
			],
			{ strict: true },
		);
		expect(await ensureUsageEventPartitions(database as never)).toEqual({
			status: "created",
			created: ["usage_events_2027_09"],
			coveredUntil: "2027-10-01T00:00:00.000Z",
		});
		database.assertConsumed();
	});

	it("leaves an occupied default partition to an operator instead of scanning it under a lock", async () => {
		const database = new FakeDatabase(
			[
				[],
				locked,
				[{ covered_until: "2027-09-01T00:00:00.000Z", ready: false }],
				[{ occupied: true }],
			],
			{ strict: true },
		);
		expect(await ensureUsageEventPartitions(database as never)).toEqual({
			status: "blocked",
			created: [],
			coveredUntil: "2027-09-01T00:00:00.000Z",
		});
		expect(database.queries.some((query) => query.startsWith("CREATE TABLE"))).toBe(false);
	});

	it.each([
		["55P03", "lock_timeout"],
		["23514", "blocked"],
		["42501", "forbidden"],
	] as const)("maps SQLSTATE %s to %s", async (sqlstate, status) => {
		const database = {
			execute: () => Promise.resolve([]),
			transaction: () => Promise.reject(Object.assign(new Error("postgres"), { errno: sqlstate })),
		};
		expect(await ensureUsageEventPartitions(database as never)).toEqual({
			status,
			created: [],
			coveredUntil: null,
		});
	});

	it("rethrows unexpected failures and rejects unbounded options", async () => {
		const failure = Object.assign(new Error("relation already exists"), { errno: "42P07" });
		const database = {
			execute: () => Promise.resolve([]),
			transaction: () => Promise.reject(failure),
		};
		await expect(ensureUsageEventPartitions(database)).rejects.toBe(failure);
		await expect(ensureUsageEventPartitions(database, { horizonMonths: 0 })).rejects.toThrow(
			"horizon",
		);
		await expect(ensureUsageEventPartitions(database, { maxCreates: 1000 })).rejects.toThrow(
			"creations per run",
		);
	});

	it("waits on the same advisory lock the migration runner holds", () => {
		const migrate = readFileSync(join(process.cwd(), "src/migrate.ts"), "utf8");
		expect(migrate).toContain("const migrationAdvisoryLockNamespace = 760_911;");
		expect(migrate).toContain("const migrationAdvisoryLockKey = 520_384_001;");
	});
});
