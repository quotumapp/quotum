import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	addUtcMonths,
	intervalMonths,
	meterLimitWindowBounds,
} from "../../src/db/repository/meter-limit-windows";

type Interval = "month" | "year";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 500);
const DAY = 86_400_000;
const MIN = new Date("2000-01-01T00:00:00.000Z").getTime();
const MAX = new Date("2090-01-01T00:00:00.000Z").getTime();

const instant = fc.integer({ min: MIN, max: MAX }).map((ms) => new Date(ms));
const interval = fc.constantFrom<Interval>("month", "year");

interface Period {
	start: Date;
	billingInterval: Interval | null;
	aligned: boolean;
	offsetDays: number;
}

/** A provider period: aligned (one billing interval from its start) or not (trials, anchor changes). */
const period: fc.Arbitrary<Period> = fc.oneof(
	fc.record({
		start: instant,
		billingInterval: fc.constantFrom<Interval | null>("month", "year", null),
		aligned: fc.constant(true),
		offsetDays: fc.constant(0),
	}),
	fc.record({
		start: instant,
		billingInterval: fc.constantFrom<Interval | null>("month", "year", null),
		aligned: fc.constant(false),
		offsetDays: fc.integer({ min: 1, max: 400 }),
	}),
);

function periodEnd(p: Period): Date | null {
	if (p.billingInterval === null) return null;
	if (!p.aligned) return new Date(p.start.getTime() + p.offsetDays * DAY);
	return addUtcMonths(p.start, intervalMonths(p.billingInterval));
}

/** The catalog rejects an item that resets less often than its plan bills. */
function publishable(p: Period, reset: Interval): boolean {
	return p.billingInterval === null || intervalMonths(reset) <= intervalMonths(p.billingInterval);
}

const bounds = (p: Period, end: Date | null, reset: Interval, now: Date) =>
	meterLimitWindowBounds(p.start, end, reset, now, p.billingInterval);

/** One reset interval: that many calendar months at the same time of day, within their day range. */
function expectOneResetInterval(window: { start: Date; end: Date }, reset: Interval): void {
	const months =
		(window.end.getUTCFullYear() - window.start.getUTCFullYear()) * 12 +
		window.end.getUTCMonth() -
		window.start.getUTCMonth();
	const days = (window.end.getTime() - window.start.getTime()) / DAY;
	const [min, max] = reset === "month" ? [28, 31] : [365, 366];
	expect(months).toBe(intervalMonths(reset));
	expect(Number.isInteger(days)).toBe(true);
	expect(days).toBeGreaterThanOrEqual(min);
	expect(days).toBeLessThanOrEqual(max);
}

describe("meter-limit window partition properties", () => {
	it("contains now, is stable inside itself, and tiles into the next window", () => {
		fc.assert(
			fc.property(
				period,
				interval,
				fc.integer({ min: 0, max: 6 * 366 * DAY }),
				(p, reset, offset) => {
					const end = periodEnd(p);
					const now = new Date(p.start.getTime() + offset);
					const window = bounds(p, end, reset, now);
					expect(window.start.getTime()).toBeLessThanOrEqual(now.getTime());
					expect(window.end.getTime()).toBeGreaterThan(now.getTime());
					expect(bounds(p, end, reset, window.start)).toEqual(window);
					expect(bounds(p, end, reset, new Date(window.end.getTime() - 1))).toEqual(window);
					expect(bounds(p, end, reset, window.end).start).toEqual(window.end);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("keeps every window of an aligned period exactly one reset interval long", () => {
		fc.assert(
			fc.property(
				period.filter((p) => p.aligned),
				interval,
				fc.integer({ min: 0, max: 6 * 366 * DAY }),
				(p, reset, offset) => {
					fc.pre(publishable(p, reset));
					const window = bounds(p, periodEnd(p), reset, new Date(p.start.getTime() + offset));
					expectOneResetInterval(window, reset);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("rolls a lapsed period forward in whole reset intervals, aligned or not", () => {
		fc.assert(
			fc.property(
				period.filter((p) => p.billingInterval !== null),
				interval,
				fc.integer({ min: 0, max: 3 * 366 * DAY }),
				(p, reset, pastEnd) => {
					fc.pre(publishable(p, reset));
					const end = periodEnd(p);
					if (end === null) throw new Error("A billed period has an end");
					const window = bounds(p, end, reset, new Date(end.getTime() + pastEnd));
					expect(window.start.getTime()).toBeGreaterThanOrEqual(end.getTime());
					expectOneResetInterval(window, reset);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});
});
