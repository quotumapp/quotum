import { describe, expect, it } from "bun:test";
import {
	type PartitionsCommandDependencies,
	runPartitionsCommand,
} from "../../../src/composition/cli/partitions";
import type { TransactionalQueryExecutor } from "../../../src/db/repository/types";
import type {
	UsagePartitionCoverage,
	UsagePartitionUpkeepOptions,
	UsagePartitionUpkeepResult,
} from "../../../src/db/repository/usage-partitions";

const database = {} as TransactionalQueryExecutor;

const coverage: UsagePartitionCoverage = {
	partitions: [
		{
			name: "usage_events_2028_09",
			from: "2028-09-01T00:00:00.000Z",
			to: "2028-10-01T00:00:00.000Z",
		},
	],
	coveredUntil: "2028-10-01T00:00:00.000Z",
	horizon: "2027-09-24T12:00:00.000Z",
	current: true,
	defaultPartitionHasRows: false,
};

async function run(
	argv: string[],
	dependencies: PartitionsCommandDependencies = {},
	env: Record<string, string | undefined> = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runPartitionsCommand(argv, env, {
		database,
		...dependencies,
		output: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
	});
	return { code, json: stdout.length ? JSON.parse(stdout.join("\n")) : undefined, stderr };
}

/** Answers each upkeep run with the next result and records the options it was given. */
function upkeepRuns(results: UsagePartitionUpkeepResult[]) {
	const options: (UsagePartitionUpkeepOptions | undefined)[] = [];
	const ensure = async (_: TransactionalQueryExecutor, given?: UsagePartitionUpkeepOptions) => {
		options.push(given);
		const next = results.shift();
		if (next === undefined) throw new Error("Unexpected upkeep run");
		return next;
	};
	return { ensure, options };
}

describe("quotum partitions status", () => {
	it("reports coverage and exits 0 when the partitions reach past the horizon", async () => {
		const horizons: (number | undefined)[] = [];
		const result = await run(["status"], {
			inspect: async (_, options) => {
				horizons.push(options?.horizonMonths);
				return coverage;
			},
		});
		expect(result).toEqual({
			code: 0,
			json: {
				coveredUntil: coverage.coveredUntil,
				horizon: coverage.horizon,
				horizonMonths: 12,
				current: true,
				defaultPartitionHasRows: false,
				partitions: coverage.partitions,
			},
			stderr: [],
		});
		expect(horizons).toEqual([12]);
	});

	it("exits 2 when the partitions end before the horizon", async () => {
		const result = await run(["status", "--months", "36"], {
			inspect: async () => ({ ...coverage, current: false }),
		});
		expect(result.code).toBe(2);
		expect(result.json).toMatchObject({ horizonMonths: 36, current: false });
		expect(result.stderr).toEqual([
			"The partitions end less than 36 months ahead; `quotum partitions ensure` adds the missing months.",
		]);
	});

	it("exits 2 and points to the runbook when the default partition holds rows", async () => {
		const result = await run(["status"], {
			inspect: async () => ({ ...coverage, current: false, defaultPartitionHasRows: true }),
		});
		expect(result.code).toBe(2);
		expect(result.stderr[0]).toContain("docs/operations.md#usage-partitions");
	});
});

describe("quotum partitions ensure", () => {
	it("runs the upkeep until the horizon and lists every partition it added", async () => {
		const upkeep = upkeepRuns([
			{
				status: "created",
				created: ["usage_events_2028_10", "usage_events_2028_11"],
				coveredUntil: "2028-12-01T00:00:00.000Z",
			},
			{
				status: "created",
				created: ["usage_events_2028_12"],
				coveredUntil: "2029-01-01T00:00:00.000Z",
			},
			{ status: "current", created: [], coveredUntil: "2029-01-01T00:00:00.000Z" },
		]);
		const result = await run(["ensure", "--months", "27"], { ensure: upkeep.ensure });
		expect(result).toEqual({
			code: 0,
			json: {
				status: "current",
				created: ["usage_events_2028_10", "usage_events_2028_11", "usage_events_2028_12"],
				coveredUntil: "2029-01-01T00:00:00.000Z",
				horizonMonths: 27,
			},
			stderr: [],
		});
		expect(upkeep.options).toEqual(Array(3).fill({ horizonMonths: 27, maxCreates: 120 }));
	});

	it.each([
		["locked", "Another process holds the partition upkeep or migration lock"],
		["lock_timeout", "usage_events stayed locked for more than a second"],
		["blocked", "docs/operations.md#usage-partitions"],
		["forbidden", "does not own usage_events"],
	] as const)("exits 1 and explains %s", async (status, notice) => {
		const upkeep = upkeepRuns([
			{
				status: "created",
				created: ["usage_events_2028_10"],
				coveredUntil: "2028-11-01T00:00:00.000Z",
			},
			{ status, created: [], coveredUntil: null },
		]);
		const result = await run(["ensure"], { ensure: upkeep.ensure });
		expect(result.code).toBe(1);
		// The partition added before the stop and its bound still show.
		expect(result.json).toEqual({
			status,
			created: ["usage_events_2028_10"],
			coveredUntil: "2028-11-01T00:00:00.000Z",
			horizonMonths: 12,
		});
		expect(result.stderr).toHaveLength(1);
		expect(result.stderr[0]).toContain(notice);
	});
});

describe("quotum partitions arguments and settings", () => {
	it.each([
		[[], "Missing subcommand."],
		[["prune"], 'Unknown subcommand "prune".'],
		[["status", "extra"], "Expected 0 arguments before the options."],
		[["ensure", "--force", "yes"], "Unknown option --force."],
		[["status", "--months"], "--months needs a value."],
		...["0", "121", "1.5", "twelve", "-3"].map(
			(months) =>
				[["ensure", "--months", months], "--months must be a whole number from 1 to 120."] as const,
		),
	] as const)("rejects %j with exit 64 before connecting", async (argv, message) => {
		const result = await run([...argv], {
			database: undefined,
			inspect: async () => {
				throw new Error("connected");
			},
		});
		expect(result.code).toBe(64);
		expect(result.stderr).toEqual([`${message} Run \`quotum partitions --help\` for usage.`]);
	});

	it("requires POSTGRES_URI and a valid prepared-statements setting before connecting", async () => {
		expect(await run(["status"], { database: undefined })).toMatchObject({
			code: 1,
			stderr: ["POSTGRES_URI is required"],
		});
		const invalid = await run(
			["status"],
			{ database: undefined },
			{
				POSTGRES_URI: "postgres://quotum@127.0.0.1:1/quotum",
				BILLING_POSTGRES_PREPARED_STATEMENTS: "sometimes",
			},
		);
		expect(invalid.code).toBe(1);
		expect(invalid.stderr.join("\n")).toContain("BILLING_POSTGRES_PREPARED_STATEMENTS");
	});
});
