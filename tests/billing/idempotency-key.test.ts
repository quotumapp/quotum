import { describe, expect, it } from "bun:test";
import { parseIdempotencyKey, requireIdempotencyKey } from "../../src/billing/idempotency-key";

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

describe("requireIdempotencyKey", () => {
	it("returns a key of 1 to 200 characters exactly as sent", () => {
		for (const key of ["k", "order 42/retry#1", "caf\u00e9", "inner\u00a0space", "A".repeat(200)]) {
			expect(requireIdempotencyKey(key)).toBe(key);
		}
	});

	it("refuses a missing, empty, long or padded key instead of trimming it", () => {
		const refused = [
			null,
			undefined,
			"",
			"   ",
			"k".repeat(201),
			" order-1",
			"order-1 ",
			"\torder-1",
			"order-1\n",
			"\u00a0order-1",
			"order-1\u000b",
			"\u000corder-1",
		];
		for (const key of refused) {
			const failure = (() => {
				try {
					return requireIdempotencyKey(key);
				} catch (error) {
					return error;
				}
			})();
			expect(failure, JSON.stringify(key)).toMatchObject({
				code: "INVALID_REQUEST",
				status: 400,
				message:
					"Idempotency-Key header must contain between 1 and 200 characters with no surrounding whitespace",
			});
		}
	});
});
