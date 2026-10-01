import { describe, expect, it } from "bun:test";
import {
	parseReportArguments,
	renderUsageScopesReport,
	runUsageScopesCommand,
	type UsageScopesCommandDependencies,
} from "../../../src/composition/cli/usage-scopes";
import type { TransactionalQueryExecutor } from "../../../src/db/repository/types";
import {
	type ProjectScopesReport,
	type UsageScopesReport,
	UsageScopesReportError,
} from "../../../src/db/repository/usage-scopes-report";

const database = {} as TransactionalQueryExecutor;

const ref = {
	plan: "pro",
	version: 2,
	planKind: "base",
	scope: "account",
	published: true,
	subscriptions: 3,
	planGrants: 0,
} as const;

function project(overrides: Partial<ProjectScopesReport> = {}): ProjectScopesReport {
	return {
		project: { key: "acme", environment: "production" },
		features: [
			{
				featureKey: "api_requests",
				limits: [
					{
						...ref,
						overagePolicy: "blocked",
						quantity: "100",
						reset: { interval: "day", intervalCount: 1 },
					},
					{
						...ref,
						plan: "boost",
						version: 1,
						planKind: "addon",
						scope: "entity",
						published: false,
						subscriptions: 1,
						planGrants: 2,
						overagePolicy: "allowed",
						quantity: "50",
						reset: { interval: "week", intervalCount: 2 },
					},
					{
						...ref,
						plan: "lifetime",
						version: 1,
						subscriptions: 1,
						overagePolicy: "blocked",
						quantity: "10",
						reset: null,
					},
				],
			},
		],
		blocking: { mixedScopeAccounts: [], postpaidEntityFanOut: [], unresolvedWindows: [] },
		warnings: { mixedScopeConfigurations: [], postpaidEntityFanOut: [] },
		accounts: {
			openWindows: 1,
			groups: 1,
			affectedGroups: 0,
			overCapGroups: 0,
			listed: [],
			truncated: false,
		},
		...overrides,
	};
}

function report(projects: ProjectScopesReport[], blockingItems = 0, warningItems = 0) {
	return {
		generatedAt: "2026-10-02T09:00:00.000Z",
		projects,
		blockingItems,
		warningItems,
	} satisfies UsageScopesReport;
}

async function run(
	argv: string[],
	dependencies: UsageScopesCommandDependencies = {},
	env: Record<string, string | undefined> = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runUsageScopesCommand(argv, env, {
		database,
		...dependencies,
		output: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
	});
	return { code, stdout: stdout.join("\n"), stderr };
}

const group = {
	billingAccountId: "acct-1",
	featureKey: "api_requests",
	windowStartAt: "2026-10-02T00:00:00.000Z",
	windowEndAt: "2026-10-03T00:00:00.000Z",
	scope: "account",
	entity: null,
	windows: 3,
	entities: 2,
	filters: 1,
	usage: "120",
	held: "10",
	limit: "100",
	overagePolicy: "blocked",
	overCap: true,
} as const;

describe("quotum usage scopes report", () => {
	it("prints the report and exits 0 when nothing blocks the upgrade", async () => {
		const options: unknown[] = [];
		const result = await run(["report"], {
			read: async (given, readOptions) => {
				expect(given).toBe(database);
				options.push(readOptions);
				return report([project()]);
			},
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(options).toEqual([{ projectKey: null, accountLimit: 50 }]);
		expect(result.stdout).toContain("Project acme (production)");
		expect(result.stdout).toContain(
			"pro v2 (base, published) account blocked 100 per day; 3 subscriptions, 0 grants",
		);
		expect(result.stdout).toContain(
			"boost v1 (addon) entity allowed 50 per 2 week; 1 subscription, 2 grants",
		);
		expect(result.stdout).toContain("lifetime v1 (base, published) account blocked 10 no reset");
		expect(result.stdout).toContain("0 blocking items, 0 warnings.");
	});

	it("prints JSON with --json and exits 2 with one line when items block the upgrade", async () => {
		const blocked = report(
			[
				project({
					blocking: {
						mixedScopeAccounts: [
							{
								billingAccountId: "acct-2",
								featureKey: "api_requests",
								sources: [
									{ plan: "pro", version: 2, scope: "account" },
									{ plan: "boost", version: 1, scope: "entity" },
								],
							},
						],
						postpaidEntityFanOut: [],
						unresolvedWindows: [],
					},
				}),
			],
			1,
		);
		const result = await run(["report", "--json", "--project", "acme", "--limit", "5"], {
			read: async (_, options) => {
				expect(options).toEqual({ projectKey: "acme", accountLimit: 5 });
				return blocked;
			},
		});
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toEqual(blocked);
		expect(result.stderr).toEqual([
			"1 blocking item: resolve it before the declared-scope upgrade (docs/upgrade-transitions.md).",
		]);
		const plural = await run(["report"], { read: async () => report([project()], 3) });
		expect(plural.stderr[0]).toStartWith("3 blocking items: resolve them");
	});

	it.each([
		[[], "Missing subcommand."],
		[["status"], 'Unknown subcommand "status".'],
		[["report", "--json", "--json"], "--json is given more than once."],
		[["report", "--limit", "0"], "--limit must be a whole number from 1 to 1000."],
		[["report", "--limit", "1001"], "--limit must be a whole number from 1 to 1000."],
		[["report", "--limit", "1e3"], "--limit must be a whole number from 1 to 1000."],
		[["report", "--project", "Acme Corp"], "--project must be a project instance key."],
		[["report", "--force", "x"], "Unknown option --force."],
		[["report", "extra"], "Expected 0 arguments before the options."],
	])("refuses %j with exit 64 before reading", async (argv, message) => {
		let read = false;
		const result = await run(argv, {
			read: async () => {
				read = true;
				return report([]);
			},
		});
		expect(result.code).toBe(64);
		expect(read).toBe(false);
		expect(result.stderr).toEqual([`${message} Run \`quotum usage scopes --help\` for usage.`]);
	});

	it("treats an instance the database does not hold as a usage error", async () => {
		const result = await run(["report", "--project", "globex"], {
			read: async () => {
				throw new UsageScopesReportError('No project instance "globex".');
			},
		});
		expect(result.code).toBe(64);
		expect(result.stderr).toEqual([
			'No project instance "globex". Run `quotum usage scopes --help` for usage.',
		]);
	});

	it("exits 1 with one line when the report cannot be read", async () => {
		const failed = await run(["report"], {
			read: async () => {
				throw new Error("connection refused");
			},
		});
		expect(failed).toMatchObject({ code: 1, stderr: ["connection refused"] });
		const unset = await run(["report"], { database: undefined }, {});
		expect(unset).toMatchObject({ code: 1, stderr: ["POSTGRES_URI is required"] });
	});

	it("parses the defaults", () => {
		expect(parseReportArguments(["report"])).toEqual({
			json: false,
			projectKey: null,
			accountLimit: 50,
		});
	});
});

describe("rendering the scope report", () => {
	it("lists blocking items, warnings and account groups", () => {
		const text = renderUsageScopesReport(
			report(
				[
					project({
						blocking: {
							mixedScopeAccounts: [
								{
									billingAccountId: "acct-2",
									featureKey: "api_requests",
									sources: [
										{ plan: "pro", version: 2, scope: "account" },
										{ plan: "boost", version: 1, scope: "entity" },
									],
								},
							],
							postpaidEntityFanOut: [
								{
									featureKey: "tokens",
									limit: { ...ref, plan: "metered", scope: "entity", subscriptions: 1 },
								},
							],
							unresolvedWindows: [
								{ ...group, scope: "unresolved", limit: null, overagePolicy: null, overCap: false },
							],
						},
						warnings: {
							mixedScopeConfigurations: [
								{
									featureKey: "api_requests",
									first: ref,
									second: { ...ref, plan: "boost", planKind: "addon", scope: "entity" },
								},
							],
							postpaidEntityFanOut: [
								{
									featureKey: "tokens",
									limit: { ...ref, plan: "draft", scope: "entity", subscriptions: 0 },
								},
							],
						},
						accounts: {
							openWindows: 4,
							groups: 2,
							affectedGroups: 1,
							overCapGroups: 1,
							listed: [
								group,
								{
									...group,
									billingAccountId: "acct-3",
									scope: "entity",
									entity: "workspace-a",
									overCap: false,
									windows: 1,
									entities: 1,
									filters: 2,
								},
							],
							truncated: true,
						},
					}),
					project({
						project: { key: "globex", environment: "sandbox" },
						features: [],
					}),
				],
				3,
				2,
			),
		);
		expect(text).toContain(
			"Account acct-2 holds mixed scopes on api_requests: pro v2 (account), boost v1 (entity). Migrate or cancel one of them.",
		);
		expect(text).toContain(
			"tokens: metered v2 (base, published) caps per entity with postpaid overage (1 subscription); the scope release refuses it.",
		);
		expect(text).toContain(
			"Account acct-1 has an open api_requests window (2026-10-02T00:00:00.000Z to 2026-10-03T00:00:00.000Z) holding 120 used and 10 held, but no meter limit applies to it now.",
		);
		expect(text).toContain(
			"api_requests: pro v2 (base, published) caps per account and boost v2 (addon, published) per entity; an account could hold both, so the next publication refuses the pair.",
		);
		expect(text).toContain(
			"tokens: draft v2 (base, published) caps per entity with postpaid overage (0 subscriptions); the next publication refuses it.",
		);
		expect(text).toContain(
			"Accounts: 4 open windows in 2 groups; 1 change under the declared scope, 1 over the cap.",
		);
		expect(text).toContain(
			"OVER CAP acct-1 api_requests [account] 2026-10-02T00:00:00.000Z to 2026-10-03T00:00:00.000Z: 120 used + 10 held of 100 (3 windows, 2 entities, 1 filter)",
		);
		expect(text).toContain(
			"acct-3 api_requests entity workspace-a [entity] 2026-10-02T00:00:00.000Z to 2026-10-03T00:00:00.000Z: 120 used + 10 held of 100 (1 window, 1 entity, 2 filters)",
		);
		expect(text).toContain("… more not listed; raise --limit or use --json.");
		expect(text).toContain(
			"Project globex (sandbox)\n  No meter limits on published or pinned versions.",
		);
		expect(text).toContain("3 blocking items, 2 warnings.");
	});

	it("says when there are no project instances", () => {
		const text = renderUsageScopesReport(report([]));
		expect(text).toContain("No project instances.");
		expect(text).toContain("0 blocking items, 0 warnings.");
		expect(
			renderUsageScopesReport({ ...report([project()], 1, 1) }).endsWith(
				"1 blocking item, 1 warning.",
			),
		).toBe(true);
		const single = project({
			accounts: {
				openWindows: 1,
				groups: 1,
				affectedGroups: 0,
				overCapGroups: 0,
				listed: [{ ...group, limit: null, overCap: false, windows: 1, entities: 1, filters: 1 }],
				truncated: false,
			},
		});
		const singleText = renderUsageScopesReport(report([single]));
		expect(singleText).toContain("Accounts: 1 open window in 1 group;");
		expect(singleText).toContain("120 used + 10 held no cap (1 window, 1 entity, 1 filter)");
	});
});
