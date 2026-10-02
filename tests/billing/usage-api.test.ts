import { describe, expect, it } from "bun:test";
import { publicUsageValue } from "../../src/billing/usage-api";

describe("public usage values", () => {
	it("canonicalizes decimal zeroes before applying storage and feature bounds", () => {
		for (const value of ["1", "0001", "1.000", "0001.000"]) {
			expect(publicUsageValue(value)).toBe("1");
		}
		expect(publicUsageValue("0000.01000000000")).toBe("0.01");
		expect(publicUsageValue("9999999999999999999.000000001")).toBe("9999999999999999999.000000001");
	});
	it("rejects invalid, zero, imprecise and out-of-range inputs", () => {
		for (const value of [
			"",
			"0",
			"000.000",
			" 1",
			"1 ",
			"+1",
			"-1",
			"1e3",
			".1",
			"1.",
			"0.0000000001",
			"10000000000000000000",
			`${"0".repeat(80)}1`,
		]) {
			expect(() => publicUsageValue(value)).toThrow();
		}
	});
});
