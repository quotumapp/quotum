import { describe, expect, it } from "bun:test";
import {
	authorizationFingerprint,
	consentedScopes,
	scopeList,
} from "../../../src/platform/mcp/authorization";

const requested = ["quotum.read", "offline_access", "quotum.billing.write"];

describe("consent scopes", () => {
	it("grants the request as made when the consent does not narrow it", () => {
		expect(consentedScopes(requested, null)).toEqual(requested);
		expect(consentedScopes(requested, [...requested].reverse())).toEqual(requested);
	});

	it("lets a consent decline only the proposal scope", () => {
		expect(consentedScopes(requested, ["quotum.read", "offline_access"])).toEqual([
			"quotum.read",
			"offline_access",
		]);
	});

	it("keeps requested order and ignores repeats", () => {
		expect(consentedScopes(requested, ["offline_access", "quotum.read", "quotum.read"])).toEqual([
			"quotum.read",
			"offline_access",
		]);
	});

	it("refuses to drop read or refresh access", () => {
		for (const granted of [
			["offline_access", "quotum.billing.write"],
			["quotum.read", "quotum.billing.write"],
			["quotum.billing.write"],
			[],
		])
			expect(() => consentedScopes(requested, granted)).toThrow(
				"Only change proposals can be left out",
			);
	});

	it("refuses a scope the client did not request", () => {
		expect(() => consentedScopes(["quotum.read", "offline_access"], [...requested])).toThrow(
			"Only change proposals can be left out",
		);
		expect(() => consentedScopes(requested, [...requested, "openid"])).toThrow(
			"Only change proposals can be left out",
		);
	});

	it("reads a space-separated scope value", () => {
		expect(scopeList("quotum.read  offline_access")).toEqual(["quotum.read", "offline_access"]);
		expect(scopeList("")).toEqual([]);
		for (const value of [undefined, null, 7, ["quotum.read"]]) expect(scopeList(value)).toBeNull();
	});

	it("keeps one proof valid for a consent that narrows the scope", () => {
		const query = new URLSearchParams({
			client_id: "client",
			redirect_uri: "http://localhost:8788/callback",
			state: "state",
			code_challenge: "challenge",
			code_challenge_method: "S256",
			resource: "https://api.example.com/mcp",
			scope: requested.join(" "),
		});
		const narrowed = new URLSearchParams(query);
		narrowed.set("scope", "quotum.read offline_access");
		expect(authorizationFingerprint(narrowed)).toBe(authorizationFingerprint(query));
		const other = new URLSearchParams(query);
		other.set("state", "another");
		expect(authorizationFingerprint(other)).not.toBe(authorizationFingerprint(query));
	});
});
