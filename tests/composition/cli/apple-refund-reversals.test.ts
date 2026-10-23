import { describe, expect, it } from "bun:test";
import {
	type AppleRefundReversalsCommandDependencies,
	runAppleRefundReversalsCommand,
} from "../../../src/composition/cli/apple-refund-reversals";
import type { OperatorContext } from "../../../src/composition/cli/operator-context";

const eventId = "019a1234-0000-7000-8000-000000000001";

async function run(argv: string[], dependencies: AppleRefundReversalsCommandDependencies = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runAppleRefundReversalsCommand(
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

describe("quotum repair apple-refund-reversals", () => {
	it("rejects invalid arguments before opening a database", async () => {
		for (const argv of [
			[],
			["apply"],
			["report", "acme", "--apply", "true"],
			["report", "acme", "--limit", "501"],
			["report", "acme", "--limit", "0"],
			["report", "acme", "--after", "bad-id"],
			["apply", "acme", "bad-id", "--actor", "ops"],
			["apply", "acme", eventId],
			["apply", "acme", eventId, "--actor", "bad actor"],
			["apply", "acme", eventId, "--actor", "ops", "--member-override-reason", "\u202E"],
		]) {
			const result = await run(argv, {
				open: async () => {
					throw new Error("opened database");
				},
			});
			expect(result.code).toBe(64);
			expect(result.error).toContain("quotum repair apple-refund-reversals --help");
			expect(result.json).toBeNull();
		}
	});

	it("authorizes a read-only paged report and closes its connection", async () => {
		const f = fixture();
		const result = await run(["report", "acme", "--after", eventId, "--limit", "25"], {
			open: f.open,
			report: async (_, projectId, options) => {
				f.calls.push(["report", projectId, options]);
				return { events: [], nextAfter: null };
			},
		});
		expect(result).toMatchObject({
			code: 0,
			json: { instance: "acme", events: [], nextAfter: null },
		});
		expect(f.calls).toEqual([
			["target", "acme"],
			["authorize", "reader", false, { memberOverrideReason: undefined }],
			["report", "instance-id", { after: eventId, limit: 25 }],
			["close"],
		]);
	});

	it("audits an authorized repair before applying it and returns blocked results with exit 2", async () => {
		const f = fixture();
		const result = await run(
			[
				"apply",
				"acme",
				eventId,
				"--actor",
				"ops",
				"--member-override-reason",
				"owner requested repair",
			],
			{
				open: f.open,
				apply: async (_, projectId, id) => {
					f.calls.push(["apply", projectId, id]);
					return {
						storeEventId: id,
						transactionId: "transaction",
						billingAccountId: "account",
						status: "blocked",
						reason: "later_invalidation",
						allocations: [],
						unattributedAllocationIds: [],
						restoredAllocationIds: [],
					};
				},
			},
		);
		expect(result).toMatchObject({
			code: 2,
			json: { status: "blocked", reason: "later_invalidation" },
		});
		expect(f.calls).toEqual([
			["target", "acme"],
			["authorize", "ops", true, { memberOverrideReason: "owner requested repair" }],
			[
				"audit",
				{
					operator: "ops",
					memberOverrideReason: "owner requested repair",
					action: "apple.refund_reversal.repair",
					storeEventId: eventId,
				},
			],
			["apply", "instance-id", eventId],
			["close"],
		]);
	});

	it("closes the connection when a repair fails", async () => {
		const f = fixture();
		const result = await run(["apply", "acme", eventId, "--actor", "ops"], {
			open: f.open,
			apply: async () => {
				throw new Error("database refused repair");
			},
		});
		expect(result).toMatchObject({ code: 1, error: "database refused repair" });
		expect(f.calls.at(-1)).toEqual(["close"]);
	});
});
