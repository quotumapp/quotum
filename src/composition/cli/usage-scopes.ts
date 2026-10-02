import { createBillingDatabaseConnection } from "../../db/client";
import type { TransactionalQueryExecutor } from "../../db/repository/types";
import {
	type AccountScopeGroup,
	type MixedScopeConfiguration,
	type PostpaidEntityFanOut,
	type ProjectScopesReport,
	readUsageScopesReportSnapshot,
	type ScopeVersionLimit,
	type ScopeVersionRef,
	type UsageScopesReport,
	UsageScopesReportError,
} from "../../db/repository/usage-scopes-report";
import { loadPostgresPreparedStatements } from "../../env";
import { writeStderr, writeStdout } from "../../shared/cli-output";
import {
	CliUsageError,
	type CommandOutput,
	parseArguments,
	reportOperatorFailure,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

const help = "quotum usage scopes --help";

export interface UsageScopesCommandDependencies {
	output?: CommandOutput;
	/** Replace the database, for tests. */
	database?: TransactionalQueryExecutor;
	/** Replace the report, for tests. */
	read?: typeof readUsageScopesReportSnapshot;
}

/**
 * `quotum usage scopes report`: what the declared meter-limit scope will change, read-only.
 * Exits 0 when nothing blocks the scope transition, 2 when something does, 64 for usage errors and
 * 1 when the report cannot be read.
 */
export async function runUsageScopesCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: UsageScopesCommandDependencies = {},
): Promise<number> {
	const output = dependencies.output ?? { stdout: writeStdout, stderr: writeStderr };
	try {
		const { json, projectKey, accountLimit } = parseReportArguments(argv);
		const report = await withDatabase(env, dependencies, async (database) =>
			(dependencies.read ?? readUsageScopesReportSnapshot)(database, { projectKey, accountLimit }),
		);
		output.stdout(json ? JSON.stringify(report, null, 2) : renderUsageScopesReport(report));
		if (report.blockingItems > 0) {
			output.stderr(
				`${report.blockingItems} blocking item${report.blockingItems === 1 ? "" : "s"}: resolve ${report.blockingItems === 1 ? "it" : "them"} before the declared-scope upgrade (docs/upgrade-transitions.md).`,
			);
			return 2;
		}
		return 0;
	} catch (error) {
		// An instance key the database does not hold is a wrong argument, as other usage errors are.
		if (error instanceof UsageScopesReportError) {
			output.stderr(`${error.message} Run \`${help}\` for usage.`);
			return 64;
		}
		return reportOperatorFailure(error, help, output);
	}
}

export function parseReportArguments(argv: readonly string[]): {
	json: boolean;
	projectKey: string | null;
	accountLimit: number;
} {
	const [subcommand, ...rest] = argv;
	if (subcommand !== "report")
		throw new CliUsageError(
			subcommand === undefined
				? "Missing subcommand."
				: `Unknown subcommand ${JSON.stringify(subcommand)}.`,
		);
	const flags = rest.filter((arg) => arg === "--json");
	if (flags.length > 1) throw new CliUsageError("--json is given more than once.");
	const { options } = parseArguments(
		rest.filter((arg) => arg !== "--json"),
		["project", "limit"],
		0,
	);
	const project = options.get("project");
	if (project !== undefined && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(project))
		throw new CliUsageError("--project must be a project instance key.");
	const limit = options.get("limit");
	if (
		limit !== undefined &&
		(!/^\d{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000)
	)
		throw new CliUsageError("--limit must be a whole number from 1 to 1000.");
	return {
		json: flags.length === 1,
		projectKey: project ?? null,
		accountLimit: limit === undefined ? 50 : Number(limit),
	};
}

async function withDatabase<T>(
	env: Environment,
	dependencies: UsageScopesCommandDependencies,
	run: (database: TransactionalQueryExecutor) => Promise<T>,
): Promise<T> {
	if (dependencies.database !== undefined) return await run(dependencies.database);
	const postgresUri = env.POSTGRES_URI?.trim();
	if (!postgresUri) throw new Error("POSTGRES_URI is required");
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

/** The report for an operator to read; `--json` prints the same data whole. */
export function renderUsageScopesReport(report: UsageScopesReport): string {
	const lines = [`Declared meter-limit scope report, ${report.generatedAt}`];
	if (report.projects.length === 0) lines.push("", "No project instances.");
	for (const project of report.projects) lines.push("", ...renderProject(project));
	lines.push(
		"",
		`${report.blockingItems} blocking item${report.blockingItems === 1 ? "" : "s"}, ${report.warningItems} warning${report.warningItems === 1 ? "" : "s"}.`,
	);
	return lines.join("\n");
}

function renderProject(project: ProjectScopesReport): string[] {
	const lines = [`Project ${project.project.key} (${project.project.environment})`];
	if (project.features.length === 0)
		lines.push("  No meter limits on published or pinned versions.");
	for (const feature of project.features) {
		lines.push(`  Feature ${feature.featureKey}`);
		for (const limit of feature.limits) lines.push(`    ${limitLine(limit)}`);
	}
	const blocking = [
		...project.blocking.mixedScopeAccounts.map(
			(account) =>
				`Account ${account.billingAccountId} holds mixed scopes on ${account.featureKey}: ${account.sources
					.map((source) => `${source.plan} v${source.version} (${source.scope})`)
					.join(", ")}. Migrate or cancel one of them.`,
		),
		...project.blocking.postpaidEntityFanOut.map(
			(item) =>
				`${fanOutLine(item)}; the scope release refuses it. Move these subscriptions to a blocked or account-scoped version.`,
		),
		...project.blocking.unresolvedWindows.map(
			(group) =>
				`Account ${group.billingAccountId} has an open ${group.featureKey} window (${window(group)}) holding ${group.usage} used and ${group.held} held, but no meter limit applies to it now.`,
		),
	];
	const warnings = [
		...project.warnings.mixedScopeConfigurations.map(configurationLine),
		...project.warnings.postpaidEntityFanOut.map(
			(item) => `${fanOutLine(item)}; the next publication refuses it.`,
		),
	];
	if (blocking.length > 0) lines.push("  Blocking:", ...blocking.map((line) => `    - ${line}`));
	if (warnings.length > 0) lines.push("  Warnings:", ...warnings.map((line) => `    - ${line}`));
	const accounts = project.accounts;
	lines.push(
		`  Accounts: ${accounts.openWindows} open window${accounts.openWindows === 1 ? "" : "s"} in ${accounts.groups} group${accounts.groups === 1 ? "" : "s"}; ${accounts.affectedGroups} change under the declared scope, ${accounts.overCapGroups} over the cap.`,
	);
	for (const group of accounts.listed) lines.push(`    ${groupLine(group)}`);
	if (accounts.truncated) lines.push("    … more not listed; raise --limit or use --json.");
	return lines;
}

function limitLine(limit: ScopeVersionLimit): string {
	const reset =
		limit.reset === null
			? "no reset"
			: `per ${limit.reset.intervalCount === 1 ? "" : `${limit.reset.intervalCount} `}${limit.reset.interval}`;
	const holders = `${limit.subscriptions} subscription${limit.subscriptions === 1 ? "" : "s"}, ${limit.planGrants} grant${limit.planGrants === 1 ? "" : "s"}`;
	return `${ref(limit)} ${limit.scope} ${limit.overagePolicy} ${limit.quantity} ${reset}; ${holders}`;
}

function ref(limit: ScopeVersionRef): string {
	return `${limit.plan} v${limit.version} (${limit.planKind}${limit.published ? ", published" : ""})`;
}

function fanOutLine(item: PostpaidEntityFanOut): string {
	return `${item.featureKey}: ${ref(item.limit)} caps per entity with postpaid overage (${item.limit.subscriptions} subscription${item.limit.subscriptions === 1 ? "" : "s"})`;
}

function configurationLine(item: MixedScopeConfiguration): string {
	return `${item.featureKey}: ${ref(item.first)} caps per ${item.first.scope} and ${ref(item.second)} per ${item.second.scope}; an account could hold both, so the next publication refuses the pair.`;
}

function window(group: AccountScopeGroup): string {
	return `${group.windowStartAt} to ${group.windowEndAt}`;
}

function groupLine(group: AccountScopeGroup): string {
	const owner = group.entity === null ? "" : ` entity ${group.entity}`;
	const cap = group.limit === null ? "no cap" : `of ${group.limit}`;
	const spread = `${group.windows} window${group.windows === 1 ? "" : "s"}, ${group.entities} entit${group.entities === 1 ? "y" : "ies"}, ${group.filters} filter${group.filters === 1 ? "" : "s"}`;
	return `${group.overCap ? "OVER CAP " : ""}${group.billingAccountId} ${group.featureKey}${owner} [${group.scope}] ${window(group)}: ${group.usage} used + ${group.held} held ${cap} (${spread})`;
}

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runUsageScopesCommand(process.argv.slice(2), process.env);
}
