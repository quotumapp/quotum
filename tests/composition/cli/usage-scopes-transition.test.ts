import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	renderUsageScopesVerification,
	runUsageScopesCommand,
	writeSnapshot,
} from "../../../src/composition/cli/usage-scopes";
import type { TransactionalQueryExecutor } from "../../../src/db/repository/types";
import {
	inScopeSet,
	parseUsageScopesSnapshot,
	type UsageScopesSnapshot,
	UsageScopesSnapshotError,
} from "../../../src/db/repository/usage-scopes-transition";

const database = {} as TransactionalQueryExecutor;

const snapshot: UsageScopesSnapshot = {
	version: 1,
	takenAt: "2026-10-02T10:00:00.000Z",
	windows: [],
	holds: [],
	invoicePeriods: [],
	unbilledGroups: [],
};

async function run(argv: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runUsageScopesCommand(
		argv,
		{},
		{
			database,
			output: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
		},
	);
	return { code, stdout, stderr };
}

describe("usage scopes snapshot and verify commands", () => {
	it("refuses missing or unusable files as usage errors", async () => {
		expect(await run(["snapshot"])).toMatchObject({
			code: 64,
			stderr: ["Name the snapshot file with --out. Run `quotum usage scopes --help` for usage."],
		});
		expect(await run(["verify", "--json"])).toMatchObject({
			code: 64,
			stderr: ["Name the snapshot with --baseline. Run `quotum usage scopes --help` for usage."],
		});
		expect(await run(["verify", "--json", "--json", "--baseline", "x"])).toMatchObject({
			code: 64,
		});
		const directory = await mkdtemp(join(tmpdir(), "quotum-scopes-"));
		try {
			expect(await run(["verify", "--baseline", join(directory, "missing.json")])).toMatchObject({
				code: 64,
				stderr: [
					`No snapshot at ${join(directory, "missing.json")}. Run \`quotum usage scopes --help\` for usage.`,
				],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("writes a snapshot only to a new file, readable by its owner", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-scopes-"));
		try {
			const path = join(directory, "pre.json");
			await writeSnapshot(path, snapshot);
			expect(parseUsageScopesSnapshot(await readFile(path, "utf8"))).toEqual(snapshot);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			await expect(writeSnapshot(path, snapshot)).rejects.toThrow(
				`${path} already exists; a snapshot never overwrites a file.`,
			);
			await expect(writeSnapshot(join(directory, "none", "pre.json"), snapshot)).rejects.toThrow(
				"does not exist",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("parses only a snapshot this release wrote", () => {
		expect(() => parseUsageScopesSnapshot("not json")).toThrow(UsageScopesSnapshotError);
		expect(() => parseUsageScopesSnapshot(JSON.stringify({ ...snapshot, version: 2 }))).toThrow(
			"The baseline is not a version 1 usage scopes snapshot.",
		);
		expect(() => parseUsageScopesSnapshot("null")).toThrow(UsageScopesSnapshotError);
	});

	it("renders each check, bounded details and over-cap sets", () => {
		const text = renderUsageScopesVerification(
			{
				passed: false,
				checks: [
					{ name: "usage totals", passed: true, details: [], total: 0 },
					{
						name: "active holds",
						passed: false,
						details: ["Hold h1 changed from 10 to 5."],
						total: 3,
					},
				],
				overCap: [
					{
						customerId: "c1",
						featureId: "7",
						scope: "entity",
						entityId: "3",
						windowStartAt: "2026-10-02T00:00:00.000000Z",
						windowEndAt: "2026-10-03T00:00:00.000000Z",
						usage: "60",
						held: "0",
						limit: "50",
					},
				],
			},
			snapshot,
		);
		expect(text).toContain("PASS usage totals");
		expect(text).toContain(
			"FAIL active holds\n  - Hold h1 changed from 10 to 5.\n  … 2 more; use --json.",
		);
		expect(text).toContain("1 scope set is over the cap");
		expect(text).toContain("[entity entity 3]");
		expect(text).toEndWith("Not verified.");
	});

	it("places a row in the scope set the declared scope sums", () => {
		const account = { scope: "account" as const, entityId: null };
		expect(inScopeSet({ entityId: "4", scope: null }, account)).toBe(true);
		expect(inScopeSet({ entityId: "4", scope: null }, { scope: "entity", entityId: "4" })).toBe(
			true,
		);
		expect(inScopeSet({ entityId: "5", scope: null }, { scope: "entity", entityId: "4" })).toBe(
			false,
		);
		const bucket = { scope: "entity" as const, entityId: null };
		expect(inScopeSet({ entityId: null, scope: null }, bucket)).toBe(true);
		expect(inScopeSet({ entityId: null, scope: "entity" }, bucket)).toBe(true);
		expect(inScopeSet({ entityId: null, scope: "account" }, bucket)).toBe(false);
	});
});
