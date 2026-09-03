import { describe, expect, it } from "bun:test";
import { createGoogleObfuscatedAccountId } from "../../../src/providers/google/account-link";

describe("Google Play account linking", () => {
	it("creates deterministic non-PII obfuscated account ids", () => {
		const id = createGoogleObfuscatedAccountId("user_1", "secret");

		expect(id).toBe(createGoogleObfuscatedAccountId(" user_1 ", "secret"));
		expect(id).not.toBe(createGoogleObfuscatedAccountId("user_2", "secret"));
		expect(id).not.toContain("user_1");
		expect(id).toMatch(/^gpa_[A-Za-z0-9_-]+$/);
		expect(id.length).toBeLessThanOrEqual(64);
	});

	it("rejects blank billing account ids", () => {
		expect(() => createGoogleObfuscatedAccountId(" ", "secret")).toThrow(
			"billingAccountId is required",
		);
	});
});
