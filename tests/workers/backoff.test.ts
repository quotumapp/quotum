import { describe, expect, it } from "bun:test";
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
