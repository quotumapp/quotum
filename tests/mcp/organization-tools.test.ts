import { afterEach, describe, expect, it } from "bun:test";
import { BillingClient } from "../../src/sdk/client";
import { connectMcp, type McpTestConnection, toolJson } from "../helpers/mcp";

let connection: McpTestConnection | undefined;
afterEach(async () => connection?.close());

describe("organization MCP tools", () => {
	it("requires explicit targets for every billing tool and isolates concurrent calls", async () => {
		const calls: { target: string; request: Request }[] = [];
		connection = await connectMcp(
			() => {
				throw new Error("bound client must not run");
			},
			{
				organization: {
					listProjects: async () => ({ projects: [] }),
					client: async (target) =>
						new BillingClient({
							baseUrl: "http://billing.internal",
							fetch: async (input, init) => {
								const request = new Request(input, init);
								const key = `${target.projectKey}:${target.environment}`;
								calls.push({ target: key, request });
								return Response.json({ success: true, data: { target: key } });
							},
						}),
				},
			},
		);
		const { tools } = await connection.client.listTools();
		for (const tool of tools) {
			const required = tool.inputSchema.required ?? [];
			if (["list_projects", "find_api_operations", "get_api_operation"].includes(tool.name)) {
				expect(required).not.toContain("projectKey");
			} else {
				expect(required).toContain("projectKey");
				expect(required).toContain("environment");
			}
		}
		expect((await connection.client.callTool({ name: "get_catalog", arguments: {} })).isError).toBe(
			true,
		);
		expect(calls).toHaveLength(0);
		const targets = [
			{ projectKey: "first", environment: "sandbox" },
			{ projectKey: "second", environment: "production" },
		];
		const results = await Promise.all(
			targets.map((target) =>
				connection?.client.callTool({
					name: "get_project_stats",
					arguments: target,
				}),
			),
		);
		expect(results.map(toolJson)).toEqual([
			{ target: "first:sandbox" },
			{ target: "second:production" },
		]);
		expect(calls.map((call) => call.target)).toEqual(["first:sandbox", "second:production"]);
		for (const call of calls) {
			expect(new URL(call.request.url).search).toBe("");
		}
		await connection.client.callTool({
			name: "check_usage",
			arguments: {
				...targets[0],
				billingAccountId: "customer",
				featureId: "tokens",
				value: "1",
			},
		});
		expect(await calls.at(-1)?.request.json()).toEqual({
			featureId: "tokens",
			value: "1",
		});
	});
});
