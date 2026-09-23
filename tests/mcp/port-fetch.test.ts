import { describe, expect, it } from "bun:test";
import { createMcpPortFetch } from "../../src/composition/mcp-port-fetch";
import {
	allowedRequests,
	createGuardedFetch,
	McpRequestBlockedError,
} from "../../src/mcp/guarded-fetch";
import {
	type MerchantBillingCommand,
	type MerchantBillingOperation,
	type MerchantBillingPort,
	merchantBillingOperations,
} from "../../src/platform/application/billing-port";
import { connectMcp, toolJson, toolText } from "../helpers/mcp";

const baseUrl = "http://billing.internal";
const projectInstanceId = "11111111-1111-4111-8111-111111111111";
const principalId = "22222222-2222-4222-8222-222222222222";
const reads: Array<["GET" | "POST", string, MerchantBillingOperation, string[]]> = [
	["GET", "/v1/catalog", "stripe.catalog", []],
	["GET", "/v1/admin/catalog", "catalog", []],
	["GET", "/v1/admin/customers/search", "customers.search", []],
	[
		"GET",
		"/v1/admin/customers/by-billing-account/account%2Fone",
		"customers.account",
		["account/one"],
	],
	["GET", "/v1/admin/store-events", "events", []],
	["GET", "/v1/admin/store-events/event-1", "events.detail", ["event-1"]],
	["GET", "/v1/admin/projection-jobs", "projections", []],
	["GET", "/v1/admin/stats/summary", "stats", []],
	["GET", "/v1/admin/providers/capabilities", "providers.capabilities", []],
	["GET", "/v1/billing-accounts/account%2Fone/controls", "controls", ["account/one"]],
	[
		"GET",
		"/v1/billing-accounts/account%2Fone/balances/token%2Fcredits",
		"usage.balance",
		["account/one", "token/credits"],
	],
	["GET", "/v1/billing-accounts/account%2Fone/billing-summary", "account.summary", ["account/one"]],
	[
		"GET",
		"/v1/billing-accounts/account%2Fone/available-actions",
		"account.actions",
		["account/one"],
	],
	["GET", "/v1/billing-accounts/account%2Fone/usage/events", "usage.events", ["account/one"]],
	[
		"GET",
		"/v1/billing-accounts/account%2Fone/usage/operations/reserve/key%2Fone",
		"usage.operation",
		["account/one", "reserve", "key/one"],
	],
	["POST", "/v1/billing-accounts/account%2Fone/usage/check", "usage.check", ["account/one"]],
];

function fixture(respond?: MerchantBillingPort["dispatch"]) {
	const commands: MerchantBillingCommand[] = [];
	const portFetch = createMcpPortFetch({
		projectInstanceId,
		principalId,
		port: {
			dispatch: async (command) => {
				commands.push(command);
				return respond
					? respond(command)
					: { status: 200, body: { success: true, data: { operation: command.operation } } };
			},
		},
	});
	return { commands, portFetch, fetch: createGuardedFetch({ baseUrl, fetch: portFetch }) };
}

describe("MCP billing port transport", () => {
	it("maps every allowed read to its billing operation and decodes each identifier once", async () => {
		const { commands, fetch } = fixture();
		for (const [method, pattern] of allowedRequests)
			expect(
				reads.some(([verb, path]) => method === verb && pattern.test(path)),
				`${method} ${pattern}`,
			).toBe(true);
		for (const [method, path, operation, parameters] of reads) {
			const body = method === "POST" ? { featureKey: "tokens", quantity: "2" } : undefined;
			const response = await fetch(`${baseUrl}${path}?limit=5&cursor=next%2Bpage`, {
				method,
				...(body
					? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
					: {}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true, data: { operation } });
			expect(commands.at(-1)).toEqual({
				operation,
				parameters,
				projectInstanceId,
				actor: `merchant:${principalId}`,
				query: { limit: "5", cursor: "next+page" },
				body,
				idempotencyKey: null,
			});
		}
		expect(commands).toHaveLength(reads.length);
	});

	it("does not inherit the wider merchant port's writes or unlisted reads", async () => {
		const { commands, fetch } = fixture();
		for (const [method, pattern] of merchantBillingOperations) {
			const path = `/v1${pattern.replace(/:[A-Za-z][A-Za-z0-9]*/g, "sample")}`;
			if (allowedRequests.some(([verb, allowed]) => method === verb && allowed.test(path)))
				continue;
			await expect(
				fetch(`${baseUrl}${path}`, { method, ...(method === "GET" ? {} : { body: "{}" }) }),
			).rejects.toBeInstanceOf(McpRequestBlockedError);
		}
		for (const url of [
			"https://attacker.test/v1/catalog",
			`${baseUrl}/v1/admin/store-events/event?includeRawPayload=true`,
			`${baseUrl}/v1/billing-accounts/payer/payment-setup-sessions/setup-id`,
		])
			await expect(fetch(url)).rejects.toBeInstanceOf(McpRequestBlockedError);
		for (const name of ["x-billing-actor", "x-billing-operator-key", "idempotency-key"])
			await expect(
				fetch(`${baseUrl}/v1/catalog`, { headers: { [name]: "untrusted" } }),
			).rejects.toBeInstanceOf(McpRequestBlockedError);
		expect(commands).toEqual([]);
	});

	it("takes authority only from the verified grant, ignoring competing request identities", async () => {
		const { commands, fetch } = fixture();
		await fetch(
			`${baseUrl}/v1/billing-accounts/payer/usage/check?projectInstanceId=other&actor=operator`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-quotum-project": "other",
					"x-quotum-environment": "production",
					authorization: "Bearer untrusted",
				},
				body: JSON.stringify({
					featureKey: "tokens",
					quantity: "1",
					projectInstanceId: "other",
					actor: "operator",
					idempotencyKey: "untrusted",
				}),
			},
		);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({
			projectInstanceId,
			actor: `merchant:${principalId}`,
			idempotencyKey: null,
		});
		expect(commands[0]).not.toHaveProperty("headers");
		expect(commands[0]).not.toHaveProperty("authorization");
	});

	it("preserves structured billing errors and hides unexpected port failures from MCP clients", async () => {
		const response = {
			success: false,
			error: { code: "BILLING_ACCOUNT_NOT_FOUND", message: "Account not found" },
		};
		const known = fixture(async () => ({ status: 404, body: response }));
		const result = await known.fetch(`${baseUrl}/v1/billing-accounts/missing/billing-summary`);
		expect(result.status).toBe(404);
		expect(await result.json()).toEqual(response);
		const broken = fixture(async () => {
			throw new Error("database unavailable: synthetic-private-host synthetic-provider-secret");
		});
		const connection = await connectMcp((request) => broken.portFetch(request));
		try {
			const failure = await connection.client.callTool({
				name: "get_project_stats",
				arguments: {},
			});
			expect(failure.isError).toBe(true);
			expect(toolJson(failure)).toEqual({
				error: {
					code: "BILLING_API_UNAVAILABLE",
					message: "The billing API could not be reached or returned an unreadable response.",
				},
			});
			expect(toolText(failure)).not.toContain("synthetic-");
			expect(broken.commands).toHaveLength(1);
		} finally {
			await connection.close();
		}
	});
});
