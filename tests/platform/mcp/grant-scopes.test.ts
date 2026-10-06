import { describe, expect, it } from "bun:test";
import { grantScopes } from "../../../src/platform/mcp/authorization";

describe("grant scopes", () => {
	it("reads a stored list as it is", () => {
		expect(grantScopes(["quotum.read", "offline_access"])).toEqual([
			"quotum.read",
			"offline_access",
		]);
	});

	it("reads a grant stored as a JSON string before the binding was fixed", () => {
		expect(grantScopes('["quotum.read","quotum.billing.write"]')).toEqual([
			"quotum.read",
			"quotum.billing.write",
		]);
	});

	it("grants nothing for anything else", () => {
		for (const stored of [null, undefined, "quotum.billing.write", '{"a":1}', 7, [1, null]])
			expect(grantScopes(stored)).toEqual([]);
	});
});
