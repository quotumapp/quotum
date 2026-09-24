import { createBillingDatabaseConnection } from "../../db/client";
import type { TransactionalQueryExecutor } from "../../db/repository/types";
import {
	ensureUsageEventPartitions,
	inspectUsageEventPartitions,
	type UsagePartitionUpkeepResult,
	type UsagePartitionUpkeepStatus,
} from "../../db/repository/usage-partitions";
import { loadPostgresPreparedStatements } from "../../env";
import {
	CliUsageError,
	type CommandOutput,
	CommandReport,
	parseArguments,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface PartitionsCommandDependencies {
	output?: CommandOutput;
	/** Replace the database and the partition upkeep, for tests. */
	database?: TransactionalQueryExecutor;
	inspect?: typeof inspectUsageEventPartitions;
	ensure?: typeof ensureUsageEventPartitions;
}

const notices: Record<Exclude<UsagePartitionUpkeepStatus, "current" | "created">, string> = {
	locked:
		"Another process holds the partition upkeep or migration lock; run the command again shortly.",
	lock_timeout: "usage_events stayed locked for more than a second; run the command again.",
	blocked:
		"usage_events_default holds rows, which stops the upkeep; see docs/operations.md#usage-partitions.",
	forbidden:
		"The POSTGRES_URI role does not own usage_events; run the command as the role that owns the schema.",
};

export async function runPartitionsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: PartitionsCommandDependencies = {},
): Promise<number> {
	return await runOperatorCommand(
		() => partitionsCommand(argv, env, dependencies),
		"quotum partitions --help",
		dependencies.output,
	);
}

async function partitionsCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: PartitionsCommandDependencies,
): Promise<CommandReport> {
	const [subcommand, ...args] = argv;
	if (subcommand !== "status" && subcommand !== "ensure")
		throw new CliUsageError(
			subcommand === undefined
				? "Missing subcommand."
				: `Unknown subcommand ${JSON.stringify(subcommand)}.`,
		);
	const { options } = parseArguments(args, ["months"], 0);
	const horizonMonths = months(options.get("months"));
	return await withDatabase(env, dependencies, async (database) => {
		if (subcommand === "status") {
			const coverage = await (dependencies.inspect ?? inspectUsageEventPartitions)(database, {
				horizonMonths,
			});
			const report = {
				coveredUntil: coverage.coveredUntil,
				horizon: coverage.horizon,
				horizonMonths,
				current: coverage.current,
				defaultPartitionHasRows: coverage.defaultPartitionHasRows,
				partitions: coverage.partitions,
			};
			if (coverage.defaultPartitionHasRows) return new CommandReport(report, 2, notices.blocked);
			if (!coverage.current)
				return new CommandReport(
					report,
					2,
					`The partitions end less than ${horizonMonths} months ahead; \`quotum partitions ensure\` adds the missing months.`,
				);
			return new CommandReport(report, 0);
		}
		const ensure = dependencies.ensure ?? ensureUsageEventPartitions;
		const created: string[] = [];
		let coveredUntil: string | null = null;
		let result: UsagePartitionUpkeepResult;
		// Each partition is still its own short transaction. The worker's smaller limit per run only
		// spreads its work across polls, so keep going until the horizon or a stop.
		do {
			result = await ensure(database, { horizonMonths, maxCreates: 120 });
			created.push(...result.created);
			coveredUntil = result.coveredUntil ?? coveredUntil;
		} while (result.status === "created");
		const report = { status: result.status, created, coveredUntil, horizonMonths };
		return result.status === "current"
			? new CommandReport(report, 0)
			: new CommandReport(report, 1, notices[result.status]);
	});
}

async function withDatabase<T>(
	env: Environment,
	dependencies: PartitionsCommandDependencies,
	run: (database: TransactionalQueryExecutor) => Promise<T>,
): Promise<T> {
	if (dependencies.database !== undefined) return await run(dependencies.database);
	const postgresUri = env.POSTGRES_URI?.trim();
	if (!postgresUri) throw new Error("POSTGRES_URI is required");
	// A transaction-mode pooler needs BILLING_POSTGRES_PREPARED_STATEMENTS=false here as well.
	const connection = createBillingDatabaseConnection({
		postgresUri,
		postgresPreparedStatements: loadPostgresPreparedStatements(env),
	});
	try {
		return await run(connection.db as unknown as TransactionalQueryExecutor);
	} finally {
		await connection.sql.close();
	}
}

function months(value: string | undefined): number {
	if (value === undefined) return 12;
	if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 120)
		throw new CliUsageError("--months must be a whole number from 1 to 120.");
	return Number(value);
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runPartitionsCommand(process.argv.slice(2), process.env);
}
