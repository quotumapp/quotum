import { describe, expect, it } from "bun:test";
import { describeRequestIssues, requestIssues } from "../../src/shared/request-issues";

describe("request issues", () => {
	it("leads each path with the request part and names the whole part by itself", () => {
		expect(
			requestIssues("body", [
				{ path: ["plans", 1, "key"], message: "Invalid input" },
				{ path: [], message: 'Unrecognized key: "extra"' },
			]),
		).toEqual([
			{ path: "body.plans.1.key", message: "Invalid input" },
			{ path: "body", message: 'Unrecognized key: "extra"' },
		]);
	});

	it("names the request when the caller knows no part", () => {
		expect(
			requestIssues(null, [
				{ path: ["quantity"], message: "Invalid input" },
				{ path: [], message: "Invalid input" },
			]),
		).toEqual([
			{ path: "quantity", message: "Invalid input" },
			{ path: "request", message: "Invalid input" },
		]);
	});

	it("keeps ten issues and cuts each text at 200 characters", () => {
		const issues = requestIssues(
			"query",
			Array.from({ length: 25 }, () => ({ path: ["k".repeat(400)], message: "m".repeat(400) })),
		);
		expect(issues).toHaveLength(10);
		expect(issues[0]?.path).toBe(`${"query.".padEnd(200, "k")}…`);
		expect(issues[0]?.message).toBe(`${"m".repeat(200)}…`);
	});

	it("describes the first issue and counts the others", () => {
		const issues = requestIssues("body", [
			{ path: ["value"], message: "Invalid input" },
			{ path: ["featureId"], message: "Invalid input" },
		]);
		expect(describeRequestIssues("Request validation failed", issues, 5)).toBe(
			"Request validation failed: body.value: Invalid input (4 more)",
		);
		expect(describeRequestIssues("Request validation failed", issues.slice(0, 1), 1)).toBe(
			"Request validation failed: body.value: Invalid input",
		);
		expect(describeRequestIssues("Request validation failed", [], 0)).toBe(
			"Request validation failed",
		);
	});
});
