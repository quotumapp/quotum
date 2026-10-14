import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { allowedRequests } from "../../src/mcp/guarded-fetch";
import { billingOperation } from "../../src/platform/application/billing-port";

/** Every `/v1` route that can answer an embedded Checkout session's client secret. */
const secretRoutes = [
	["POST", "/v1/billing-accounts/acct_1/providers/stripe/checkout-sessions"],
	["GET", "/v1/billing-accounts/acct_1/providers/stripe/checkout-sessions/cs_1"],
	["POST", "/v1/billing-accounts/acct_1/providers/stripe/checkout-sessions/cs_1/expire"],
] as const;

describe("embedded Checkout client secret surfaces", () => {
	it("is reachable from neither the console, remote MCP and change proposals, nor stdio MCP", () => {
		for (const [method, path] of secretRoutes) {
			// The console, remote MCP and change proposals all dispatch through these operations.
			expect([method, path, billingOperation(method, path)]).toEqual([method, path, null]);
			// The read-only stdio tools may send only what this list allows.
			expect(allowedRequests.some(([verb, pattern]) => verb === method && pattern.test(path))).toBe(
				false,
			);
		}
	});

	it("needs a full project credential on every route that answers it", () => {
		const contract = JSON.parse(
			readFileSync(new URL("../../contracts/v1/openapi.json", import.meta.url), "utf8"),
		) as { paths: Record<string, Record<string, Record<string, unknown>>> };
		const prefix = "/v1/billing-accounts/{billingAccountId}";
		for (const [template, method] of [
			[`${prefix}/providers/stripe/checkout-sessions`, "post"],
			[`${prefix}/providers/stripe/checkout-sessions/{sessionId}`, "get"],
			[`${prefix}/providers/stripe/checkout-sessions/{sessionId}/expire`, "post"],
			[`${prefix}/commercial-actions`, "post"],
		] as const) {
			const operation = contract.paths[template]?.[method];
			expect(operation).toBeDefined();
			expect(operation?.["x-quotum-credential-access"]).toBeUndefined();
		}
	});
});
