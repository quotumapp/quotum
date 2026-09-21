import { afterEach, describe, expect, it } from "bun:test";
import { allowedRequests } from "../../src/mcp/guarded-fetch";
import { connectMcp, type McpTestConnection } from "../helpers/mcp";

let connection: McpTestConnection | undefined;

afterEach(async () => {
	await connection?.close();
	connection = undefined;
});

// One minimal call per tool. Adding a tool means adding it here, which is the review point.
const toolCalls: Readonly<Record<string, Record<string, unknown>>> = {
	check_usage: { billingAccountId: "account-1", featureKey: "tokens", quantity: "1" },
	find_api_operations: { query: "usage/check" },
	find_customer: { query: "account" },
	get_api_operation: { operationId: "postV1BillingAccountsByBillingAccountIdUsageCheck" },
	get_available_actions: { billingAccountId: "account-1" },
	get_balance: { billingAccountId: "account-1", featureKey: "tokens" },
	get_catalog: {},
	get_controls: { billingAccountId: "account-1" },
	get_customer_overview: { billingAccountId: "account-1" },
	get_project_stats: {},
	get_provider_capabilities: {},
	get_store_event: { eventId: "event-1" },
	get_stripe_catalog: {},
	get_usage_operation: { billingAccountId: "account-1", operationId: "key-1" },
	list_projection_jobs: {},
	list_store_events: {},
	list_usage_events: { billingAccountId: "account-1" },
};

describe("MCP tool inventory", () => {
	it("exposes exactly the reviewed read-only tools", async () => {
		connection = await connectMcp(() => Response.json({ success: true, data: {} }));
		const { tools } = await connection.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(toolCalls).sort());
		for (const tool of tools) {
			expect(tool.annotations?.readOnlyHint).toBe(true);
			expect(tool.description?.length ?? 0).toBeGreaterThan(20);
			expect(tool.name).not.toMatch(
				/consume|reserve|confirm|release|correct|publish|retry|replay|revoke|redeem|create|update|delete/u,
			);
			expect(tool.outputSchema).toBeUndefined();
		}
	});

	it("sends only allowlisted requests, and every allowlisted request belongs to a tool", async () => {
		connection = await connectMcp((request) =>
			Response.json(
				/\/(search|store-events|projection-jobs|usage\/events)$/u.test(
					new URL(request.url).pathname,
				)
					? { success: true, data: [], pagination: { nextCursor: null } }
					: { success: true, data: {} },
			),
		);
		for (const [name, args] of Object.entries(toolCalls)) {
			const result = await connection.client.callTool({ name, arguments: args });
			expect([name, result.isError]).toEqual([name, undefined]);
		}

		const sent = connection.calls.map((call) => [call.method, new URL(call.url).pathname] as const);
		expect(sent.filter(([method]) => method !== "GET")).toEqual([
			["POST", "/v1/billing-accounts/account-1/usage/check"],
		]);
		for (const call of connection.calls) {
			expect(call.headers.has("x-billing-operator-key")).toBe(false);
			expect(call.url).not.toContain("includeRawPayload");
		}
		const unused = allowedRequests.filter(
			([method, pattern]) =>
				!sent.some(([sentMethod, path]) => sentMethod === method && pattern.test(path)),
		);
		expect(unused).toEqual([]);
	});
});
