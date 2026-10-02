import { readFile, writeFile } from "node:fs/promises";
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
import {
	parseUsageScopesSnapshot,
	readUsageScopesSnapshot,
	type UsageScopesSnapshot,
	UsageScopesSnapshotError,
	type UsageScopesVerification,
	verifyUsageScopesTransition,
} from "../../db/repository/usage-scopes-transition";
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
 * `quotum usage scopes report|snapshot|verify`, the declared meter-limit scope transition:
 *
 * - `report`: what the declared scope will change, read-only, on the release before it. Exits 2
 *   while something blocks the transition.
 * - `snapshot --out <file>`: records usage windows, active holds and unbilled usage before
 *   `quotum migrate`, reading only columns both schemas have. The file is never overwritten.
 * - `verify --baseline <file>`: after `quotum migrate`, checks the database against the snapshot.
 *   Exits 2 when a check fails; start the service only once it passes.
 *
 * Usage errors exit 64, and a database or file failure exits 1.
 */
export async function runUsageScopesCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: UsageScopesCommandDependencies = {},
): Promise<number> {
	const output = dependencies.output ?? { stdout: writeStdout, stderr: writeStderr };
	try {
		if (argv[0] === "snapshot") return await runSnapshot(argv.slice(1), env, dependencies, output);
		if (argv[0] === "verify") return await runVerify(argv.slice(1), env, dependencies, output);
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
		// An instance key the database does not hold, or a baseline that is not a snapshot, is a
		// wrong argument, as other usage errors are.
		if (error instanceof UsageScopesReportError || error instanceof UsageScopesSnapshotError) {
			output.stderr(`${error.message} Run \`${help}\` for usage.`);
			return 64;
		}
		return reportOperatorFailure(error, help, output);
	}
}

async function runSnapshot(
	argv: readonly string[],
	env: Environment,
	dependencies: UsageScopesCommandDependencies,
	output: CommandOutput,
): Promise<number> {
	const { options } = parseArguments(argv, ["out"], 0);
	const path = options.get("out");
	if (path === undefined) throw new CliUsageError("Name the snapshot file with --out.");
	const snapshot = await withDatabase(env, dependencies, readUsageScopesSnapshot);
	await writeSnapshot(path, snapshot);
	output.stdout(
		`Snapshot of ${snapshot.windows.length} usage window${snapshot.windows.length === 1 ? "" : "s"}, ${snapshot.holds.length} active hold${snapshot.holds.length === 1 ? "" : "s"}, ${snapshot.invoicePeriods.length} pending invoice period${snapshot.invoicePeriods.length === 1 ? "" : "s"} and ${snapshot.unbilledGroups.length} unbilled usage group${snapshot.unbilledGroups.length === 1 ? "" : "s"} written to ${path}. Run \`quotum migrate\`, then \`quotum usage scopes verify --baseline ${path}\`.`,
	);
	return 0;
}

/** Writes the snapshot only to a new file, readable by its owner alone. */
export async function writeSnapshot(path: string, snapshot: UsageScopesSnapshot): Promise<void> {
	try {
		await writeFile(path, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === "EEXIST")
			throw new Error(`${path} already exists; a snapshot never overwrites a file.`);
		if (code === "ENOENT") throw new Error(`The directory for ${path} does not exist.`);
		if (code === "EACCES") throw new Error(`Permission denied writing ${path}.`);
		throw error;
	}
}

async function runVerify(
	argv: readonly string[],
	env: Environment,
	dependencies: UsageScopesCommandDependencies,
	output: CommandOutput,
): Promise<number> {
	const json = argv.filter((arg) => arg === "--json");
	if (json.length > 1) throw new CliUsageError("--json is given more than once.");
	const { options } = parseArguments(
		argv.filter((arg) => arg !== "--json"),
		["baseline"],
		0,
	);
	const path = options.get("baseline");
	if (path === undefined) throw new CliUsageError("Name the snapshot with --baseline.");
	const baseline = parseUsageScopesSnapshot(await readBaseline(path));
	const verification = await withDatabase(env, dependencies, (database) =>
		verifyUsageScopesTransition(database, baseline),
	);
	output.stdout(
		json.length === 1
			? JSON.stringify(verification, null, 2)
			: renderUsageScopesVerification(verification, baseline),
	);
	if (!verification.passed) {
		output.stderr(
			"The declared-scope transition did not verify: do not start the service; restore the dump instead (docs/upgrade-transitions.md).",
		);
		return 2;
	}
	return 0;
}

async function readBaseline(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT")
			throw new UsageScopesSnapshotError(`No snapshot at ${path}.`);
		throw error;
	}
}

/** The verification for an operator to read; `--json` prints the same data whole. */
export function renderUsageScopesVerification(
	verification: UsageScopesVerification,
	baseline: Pick<UsageScopesSnapshot, "takenAt">,
): string {
	const lines = [`Declared-scope transition, verified against the snapshot of ${baseline.takenAt}`];
	for (const check of verification.checks) {
		lines.push(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
		for (const detail of check.details) lines.push(`  - ${detail}`);
		if (check.total > check.details.length)
			lines.push(`  … ${check.total - check.details.length} more; use --json.`);
	}
	if (verification.overCap.length > 0) {
		lines.push(
			`${verification.overCap.length} scope set${verification.overCap.length === 1 ? " is" : "s are"} over the cap and will be refused until room is left:`,
		);
		for (const set of verification.overCap)
			lines.push(
				`  - ${set.projectKey} ${set.billingAccountId} ${set.featureKey} [${set.scope}${set.entityId === null ? "" : ` entity ${set.entityExternalId ?? set.entityId}`}] ${set.windowStartAt} to ${set.windowEndAt}: ${set.usage} used + ${set.held} held of ${set.limit}`,
			);
	}
	lines.push(verification.passed ? "Verified: start the service." : "Not verified.");
	return lines.join("\n");
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
