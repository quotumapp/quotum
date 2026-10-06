import { describe, expect, it } from "bun:test";
import { parseIdempotencyKey } from "../../src/billing/idempotency-key";

describe("parseIdempotencyKey", () => {
	it("returns keys of up to 200 printable characters unchanged", () => {
		for (const key of ["k", "checkout:acme.1_a-b", "A".repeat(200)]) {
			expect(parseIdempotencyKey(key)).toBe(key);
		}
	});

	it("refuses an empty, long, spaced or non-printable key with INVALID_IDEMPOTENCY_KEY", () => {
		for (const key of ["", "k".repeat(201), "two words", "line\nbreak", "nul\u0000", "caf\u00e9"]) {
			expect(() => parseIdempotencyKey(key)).toThrow("Idempotency-Key is invalid");
			try {
				parseIdempotencyKey(key);
			} catch (error) {
				expect(error).toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY", status: 400 });
			}
		}
	});
});
