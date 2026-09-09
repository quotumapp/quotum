import { describe, expect, it } from "bun:test";
import { constantTimeEquals } from "../../src/shared/constant-time-equals";

describe("constantTimeEquals", () => {
	it("compares bearer tokens exactly without throwing on length mismatches", () => {
		expect(constantTimeEquals("Bearer secret", "Bearer secret")).toBe(true);
		expect(constantTimeEquals("Bearer secret", "Bearer wrong")).toBe(false);
		expect(constantTimeEquals("Bearer secret", "Bearer much-longer-wrong-token")).toBe(false);
	});
});
