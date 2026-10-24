import { describe, expect, it } from "bun:test";
import {
	type AutoTopupsCommandDependencies,
	runAutoTopupsCommand,
} from "../../../src/composition/cli/auto-topups";
import type { OperatorContext } from "../../../src/composition/cli/operator-context";

const jobId = "019a1234-0000-7000-8000-000000000001";

async function run(argv: string[], dependencies: AutoTopupsCommandDependencies = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runAutoTopupsCommand(
		argv,
		{},
		{
			...dependencies,
			output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
		},
	);
	return { code, json: out.length > 0 ? JSON.parse(out.join("\n")) : null, error: err.join("\n") };
}

function fixture() {
	const calls: unknown[][] = [];
	const context = {
		sql: {
			query: async (query: { values: unknown[] }) => {
				calls.push(["audit", JSON.parse(String(query.values[4]))]);
				return [];
			},
		},
		billingDatabase: {},
		target: async (instanceKey: string) => {
			calls.push(["target", instanceKey]);
			return { project: { projectInstanceId: "instance-id" }, instanceId: "instance-id" };
		},
		gate: (_: unknown, actor: string, options: unknown) => ({
			instance: async (_sql: unknown, write: boolean) => {
				calls.push(["authorize", actor, write, options]);
			},
		}),
		close: async () => {
			calls.push(["close"]);
		},
	} as unknown as OperatorContext;
	return { calls, open: async () => context };
}

describe("quotum repair auto-topups", () => {
	it("rejects invalid arguments before opening a database", async () => {
		for (const argv of [
			[],
			["resume"],
			["report", "acme", "--apply", "true"],
			["report", "acme", "--limit", "501"],
			["report", "acme", "--limit", "0"],
			["report", "acme", "--after", "bad-id"],
			["resume", "acme", "bad-id", "--actor", "ops"],
			["resume", "acme", jobId],
			["resume", "acme", jobId, "--actor", "bad actor"],
			["resume", "acme", jobId, "--actor", "ops", "--member-override-reason", "\u202E"],
		]) {
			const result = await run(argv, {
				open: async () => {
					throw new Error("opened database");
				},
			});
			expect(result.code).toBe(64);
			expect(result.error).toContain("quotum repair auto-topups --help");
			expect(result.json).toBeNull();
		}
	});

	it("authorizes a read-only paged report and closes its connection", async () => {
		const f = fixture();
		const result = await run(["report", "acme", "--after", jobId, "--limit", "25"], {
			open: f.open,
			report: async (_, projectId, options) => {
				f.calls.push(["report", projectId, options]);
				return { jobs: [], nextAfter: null };
			},
		});
		expect(result).toMatchObject({
			code: 0,
			json: { instance: "acme", jobs: [], nextAfter: null },
		});
		expect(f.calls).toEqual([
			["target", "acme"],
			["authorize", "reader", false, { memberOverrideReason: undefined }],
			["report", "instance-id", { after: jobId, limit: 25 }],
			["close"],
		]);
	});

	it("audits an authorized repair before applying it and resumes the saved job", async () => {
		const f = fixture();
		const result = await run(
			[
				"resume",
				"acme",
				jobId,
				"--actor",
				"ops",
				"--member-override-reason",
				"owner requested repair",
			],
			{
				open: f.open,
				resume: async (_, projectId, id) => {
					f.calls.push(["resume", projectId, id]);
					return { jobId: id, status: "resumed" };
				},
			},
		);
		expect(result).toMatchObject({
			code: 0,
			json: { status: "resumed", jobId },
		});
		expect(f.calls).toEqual([
			["target", "acme"],
			["authorize", "ops", true, { memberOverrideReason: "owner requested repair" }],
			[
				"audit",
				{
					operator: "ops",
					memberOverrideReason: "owner requested repair",
					action: "auto_topup.resume",
					jobId: jobId,
				},
			],
			["resume", "instance-id", jobId],
			["close"],
		]);
	});

	it("closes the connection when a repair fails", async () => {
		const f = fixture();
		const result = await run(["resume", "acme", jobId, "--actor", "ops"], {
			open: f.open,
			resume: async () => {
				throw new Error("database refused repair");
			},
		});
		expect(result).toMatchObject({ code: 1, error: "database refused repair" });
		expect(f.calls.at(-1)).toEqual(["close"]);
	});
});
