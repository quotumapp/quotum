import { describe, expect, it } from "bun:test";
import { routeMethodIndex } from "../../src/shared/route-methods";

describe("routeMethodIndex", () => {
	it("lists the methods registered for a path, with HEAD beside GET", () => {
		const index = routeMethodIndex(() => [
			{ method: "GET", path: "/oauth/jwks" },
			{ method: "POST", path: "/oauth/token" },
			{ method: "GET", path: "/v1/accounts/:accountId" },
			{ method: "PUT", path: "/v1/accounts/:accountId" },
		]);
		expect(index.allowed("/oauth/jwks")).toEqual(["GET", "HEAD"]);
		expect(index.allowed("/oauth/token")).toEqual(["POST"]);
		expect(index.allowed("/v1/accounts/acct_1")).toEqual(["GET", "HEAD", "PUT"]);
		expect(index.allowed("/v1/accounts/acct_1/extra")).toEqual([]);
		expect(index.allowed("/oauth/unknown")).toEqual([]);
	});

	it("leaves out catch-all registrations and rebuilds when routes are added", () => {
		const routes = [{ method: "ALL", path: "/mcp" }];
		const index = routeMethodIndex(() => routes);
		expect(index.allowed("/mcp")).toEqual([]);
		routes.push({ method: "POST", path: "/mcp/extra" });
		expect(index.allowed("/mcp/extra")).toEqual(["POST"]);
	});

	it("matches a wildcard segment and escapes regular expression characters", () => {
		const index = routeMethodIndex(() => [
			{ method: "POST", path: "/api/auth/*" },
			{ method: "GET", path: "/.well-known/oauth" },
		]);
		expect(index.allowed("/api/auth/sign-up/email")).toEqual(["POST"]);
		expect(index.allowed("/.well-known/oauth")).toEqual(["GET", "HEAD"]);
		expect(index.allowed("/xwell-known/oauth")).toEqual([]);
	});
});
