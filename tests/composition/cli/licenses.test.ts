import { describe, expect, it } from "bun:test";
import { runLicensesCommand } from "../../../src/composition/cli/licenses";
import type { OperatorContext } from "../../../src/composition/cli/operator-context";

describe("quotum licenses sync", () => {
	it("rejects invalid or unbounded requests before connecting", async () => {
		for (const args of [
			[],
			["sync"],
			["sync", "--instance", "acme"],
			["sync", "--instance", "acme", "--actor", "ops", "--limit", "501"],
			["sync", "--instance", "acme", "--actor", "ops", "--after", "bad"],
		]) {
			let opened = false;
			const code = await runLicensesCommand(
				args,
				{},
				{
					open: async () => {
						opened = true;
						throw new Error("unexpected");
					},
					output: { stdout() {}, stderr() {} },
				},
			);
			expect(code).toBe(64);
			expect(opened).toBe(false);
		}
	});
	it("authorizes and audits one bounded page with the operator, cursor and override reason", async () => {
		const calls: unknown[] = [];
		const output: string[] = [];
		const after = "019a1234-0000-7000-8000-000000000001";
		const context = {
			sql: {
				query: async (query: { values: unknown[] }) => {
					calls.push(["audit", JSON.parse(String(query.values[4]))]);
					return [];
				},
			},
			billingDatabase: {},
			target: async () => ({
				project: { projectInstanceId: "instance" },
				instanceId: "instance",
				organizationId: "org",
			}),
			gate: (_target: unknown, actor: string, options: unknown) => ({
				instance: async (_sql: unknown, write: boolean) => {
					calls.push(["authorize", actor, write, options]);
				},
			}),
			close: async () => {
				calls.push(["close"]);
			},
		} as unknown as OperatorContext;
		const code = await runLicensesCommand(
			[
				"sync",
				"--instance",
				"acme",
				"--actor",
				"ops",
				"--after",
				after,
				"--limit",
				"25",
				"--member-override-reason",
				"requested backfill",
			],
			{},
			{
				open: async () => context,
				sync: async (_database, projectId, cursor, limit) => {
					calls.push(["sync", projectId, cursor, limit]);
					return { customers: 25, nextAfter: after };
				},
				output: { stdout: (value) => output.push(value), stderr() {} },
			},
		);
		expect(code).toBe(0);
		expect(JSON.parse(output.join("\n"))).toMatchObject({ customers: 25, nextAfter: after });
		expect(calls).toEqual([
			["authorize", "ops", true, { memberOverrideReason: "requested backfill" }],
			[
				"audit",
				{
					operator: "ops",
					action: "licenses.sync",
					after,
					limit: 25,
					memberOverrideReason: "requested backfill",
				},
			],
			["sync", "instance", after, 25],
			["close"],
		]);
	});
});
