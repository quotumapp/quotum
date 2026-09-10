import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { calculateNextAttemptAt, normalizeWorkerError } from "../../src/workers/backoff";

describe("projection worker backoff", () => {
	it("uses capped exponential backoff", () => {
		const now = new Date("2026-05-31T00:00:00.000Z");

		expect(calculateNextAttemptAt({ attempts: 0, maxAttempts: 10, now, jitterMs: 0 })).toEqual(
			new Date("2026-05-31T00:01:00.000Z"),
		);
		expect(calculateNextAttemptAt({ attempts: 4, maxAttempts: 10, now, jitterMs: 0 })).toEqual(
			new Date("2026-05-31T00:16:00.000Z"),
		);
	});

	it("returns null after the final attempt", () => {
		const now = new Date("2026-05-31T00:00:00.000Z");
		expect(calculateNextAttemptAt({ attempts: 9, maxAttempts: 10, now, jitterMs: 0 })).toBeNull();
		expect(calculateNextAttemptAt({ attempts: 10, maxAttempts: 10, now, jitterMs: 0 })).toBeNull();
	});

	it("applies the 24h cap at the overflow boundary", () => {
		const now = new Date("2026-05-31T00:00:00.000Z");
		expect(calculateNextAttemptAt({ attempts: 8, maxAttempts: 10, now, jitterMs: 0 })).toEqual(
			new Date("2026-05-31T04:16:00.000Z"),
		);
		expect(calculateNextAttemptAt({ attempts: 10, maxAttempts: 100, now, jitterMs: 0 })).toEqual(
			new Date("2026-05-31T17:04:00.000Z"),
		);
		expect(calculateNextAttemptAt({ attempts: 11, maxAttempts: 100, now, jitterMs: 0 })).toEqual(
			new Date("2026-06-01T00:00:00.000Z"),
		);
		expect(calculateNextAttemptAt({ attempts: 1100, maxAttempts: 2000, now, jitterMs: 0 })).toEqual(
			new Date("2026-06-01T00:00:00.000Z"),
		);
	});

	it("adds explicit jitter and keeps default jitter in range", () => {
		const now = new Date("2026-05-31T00:00:00.000Z");
		expect(calculateNextAttemptAt({ attempts: 0, maxAttempts: 10, now, jitterMs: 999 })).toEqual(
			new Date(now.getTime() + 60_999),
		);
		const delays = Array.from({ length: 200 }, () => {
			const next = calculateNextAttemptAt({ attempts: 0, maxAttempts: 10, now });
			if (next === null) {
				throw new Error("expected a retry delay");
			}
			return next.getTime() - now.getTime();
		});
		expect(
			delays.every((delay) => delay >= 60_000 && delay < 61_000 && Number.isInteger(delay)),
		).toBe(true);
	});

	it("is null exactly at the maxAttempts boundary and otherwise monotonic", () => {
		const now = new Date("2026-05-31T00:00:00.000Z");
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 60 }),
				fc.integer({ min: 2, max: 100 }),
				(attempts, maxAttempts) => {
					const next = calculateNextAttemptAt({
						attempts,
						maxAttempts,
						now,
						jitterMs: 0,
					});
					if (attempts + 1 >= maxAttempts) {
						expect(next).toBeNull();
						return;
					}
					if (next === null) {
						throw new Error("expected a retry delay");
					}
					const delay = next.getTime() - now.getTime();
					expect(delay).toBeGreaterThanOrEqual(60_000);
					expect(delay).toBeLessThanOrEqual(86_400_000);
					const later = calculateNextAttemptAt({
						attempts: attempts + 1,
						maxAttempts,
						now,
						jitterMs: 0,
					});
					if (later !== null) {
						expect(later.getTime()).toBeGreaterThanOrEqual(next.getTime());
					}
				},
			),
		);
	});

	it("normalizes worker errors", () => {
		expect(normalizeWorkerError(new Error("failed"))).toBe("failed");
		expect(normalizeWorkerError("string error")).toBe("string error");
		expect(normalizeWorkerError({ reason: "bad" })).toBe('{"reason":"bad"}');
	});

	it("falls back when worker errors cannot be stringified", () => {
		expect(normalizeWorkerError(undefined)).toBe("Unknown worker error");
		expect(normalizeWorkerError(Symbol("x"))).toBe("Unknown worker error");
		expect(normalizeWorkerError(() => undefined)).toBe("Unknown worker error");
	});
});
