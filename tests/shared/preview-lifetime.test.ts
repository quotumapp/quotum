import { describe, expect, it } from "bun:test";
import { previewExpiry } from "../../src/shared/preview-lifetime";

describe("preview lifetime", () => {
	it("calculates an exact deadline from the caller's clock", () => {
		const now = Date.parse("2026-10-26T12:00:00.000Z");
		expect(previewExpiry(3600, now).toISOString()).toBe("2026-10-26T13:00:00.000Z");
		expect(previewExpiry(1, now).getTime() - now).toBe(1000);
	});
	it("rejects unsafe arithmetic and overflowing dates", () => {
		for (const ttl of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 8_640_000_000_000])
			expect(() => previewExpiry(ttl, 1_000_000, "Review lifetime")).toThrow("Review lifetime");
	});
});
