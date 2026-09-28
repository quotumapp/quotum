import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	meterLimitWindowBounds,
	planGrantWindowBounds,
} from "../../src/db/repository/meter-limit-windows";
import {
	addCadence,
	addUtcMonths,
	type Cadence,
	type CadenceUnit,
	cadenceFitsWithin,
	cadenceSplits,
	canonicalCadence,
} from "../../src/shared/cadence";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 500);
const DAY = 86_400_000;
const MIN = new Date("2000-01-01T00:00:00.000Z").getTime();
const MAX = new Date("2090-01-01T00:00:00.000Z").getTime();

const instant = fc.integer({ min: MIN, max: MAX }).map((ms) => new Date(ms));
const calendarCadence: fc.Arbitrary<Cadence> = fc.oneof(
	fc.record({ unit: fc.constant<CadenceUnit>("month"), count: fc.integer({ min: 1, max: 36 }) }),
	fc.record({
		unit: fc.constantFrom<CadenceUnit>("quarter", "semi_annual", "year"),
		count: fc.integer({ min: 1, max: 3 }),
	}),
);
const fixedCadence: fc.Arbitrary<Cadence> = fc.oneof(
	fc.record({ unit: fc.constant<CadenceUnit>("hour"), count: fc.integer({ min: 1, max: 48 }) }),
	fc.record({ unit: fc.constant<CadenceUnit>("day"), count: fc.integer({ min: 1, max: 60 }) }),
	fc.record({ unit: fc.constant<CadenceUnit>("week"), count: fc.integer({ min: 1, max: 8 }) }),
);
const cadence = fc.oneof(calendarCadence, fixedCadence);
const billingCadence = fc.constantFrom<Cadence | null>(
	{ unit: "month", count: 1 },
	{ unit: "quarter", count: 1 },
	{ unit: "year", count: 1 },
	null,
);

interface Period {
	start: Date;
	billing: Cadence | null;
	aligned: boolean;
	offsetDays: number;
}

/** A provider period: aligned (one billing interval from its start) or not (trials, anchor changes). */
const period: fc.Arbitrary<Period> = fc.oneof(
	fc.record({
		start: instant,
		billing: billingCadence,
		aligned: fc.constant(true),
		offsetDays: fc.constant(0),
	}),
	fc.record({
		start: instant,
		billing: billingCadence,
		aligned: fc.constant(false),
		offsetDays: fc.integer({ min: 1, max: 400 }),
	}),
);

function periodEnd(p: Period): Date | null {
	if (p.billing === null) return null;
	if (!p.aligned) return new Date(p.start.getTime() + p.offsetDays * DAY);
	return addCadence(p.start, p.billing);
}

/** The catalog rejects an item that resets less often than its plan bills. */
function publishable(p: Period, reset: Cadence): boolean {
	return p.billing === null || cadenceFitsWithin(reset, p.billing);
}

const bounds = (p: Period, end: Date | null, reset: Cadence, now: Date) =>
	meterLimitWindowBounds(p.start, end, reset, now, p.billing);

/**
 * The window algorithms as they were before cadences: one step at a time from the period start or
 * end. The constant-time functions must agree with them everywhere.
 */
function referenceRoll(start: Date, end: Date, reset: Cadence, now: Date) {
	let currentStart = start;
	let currentEnd = end;
	const anchorDay =
		end.getTime() === addCadence(start, reset).getTime() ? start.getUTCDate() : end.getUTCDate();
	while (currentEnd <= now) {
		currentStart = currentEnd;
		currentEnd = addCadence(currentEnd, reset, 1, anchorDay);
	}
	return { start: currentStart, end: currentEnd };
}

function referenceSubWindow(start: Date, end: Date, reset: Cadence, now: Date) {
	const anchorDay = start.getUTCDate();
	let step = 0;
	let currentStart = start;
	for (;;) {
		const nextStart = addCadence(start, reset, step + 1, anchorDay);
		const currentEnd = nextStart < end ? nextStart : end;
		if (now < currentEnd || currentEnd >= end) return { start: currentStart, end: currentEnd };
		step += 1;
		currentStart = nextStart;
	}
}

function referenceBounds(p: Period, end: Date | null, reset: Cadence, now: Date) {
	const periodEndAt = end ?? addCadence(p.start, reset);
	if (end !== null && cadenceSplits(reset, p.billing)) {
		if (now < periodEndAt) return referenceSubWindow(p.start, periodEndAt, reset, now);
		return referenceRoll(periodEndAt, addCadence(periodEndAt, reset), reset, now);
	}
	return referenceRoll(p.start, periodEndAt, reset, now);
}

/** Exactly one reset interval: whole calendar months at the same time of day, or exact hours. */
function expectOneResetInterval(window: { start: Date; end: Date }, reset: Cadence): void {
	const canonical = canonicalCadence(reset);
	const elapsed = window.end.getTime() - window.start.getTime();
	if (canonical.kind === "hours") {
		expect(elapsed).toBe(canonical.hours * 3_600_000);
		return;
	}
	const months =
		(window.end.getUTCFullYear() - window.start.getUTCFullYear()) * 12 +
		window.end.getUTCMonth() -
		window.start.getUTCMonth();
	expect(months).toBe(canonical.months);
	expect(Number.isInteger(elapsed / DAY)).toBe(true);
	expect(elapsed / DAY).toBeGreaterThanOrEqual(canonical.months * 28);
	expect(elapsed / DAY).toBeLessThanOrEqual(canonical.months * 31);
}

describe("meter-limit window partition properties", () => {
	it("agrees with the step-by-step algorithm for every cadence", () => {
		fc.assert(
			fc.property(
				period,
				cadence,
				fc.integer({ min: -30 * DAY, max: 4 * 366 * DAY }),
				(p, reset, offset) => {
					fc.pre(publishable(p, reset));
					const end = periodEnd(p);
					const now = new Date(p.start.getTime() + offset);
					expect(bounds(p, end, reset, now)).toEqual(referenceBounds(p, end, reset, now));
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("agrees with the step-by-step algorithm for plan grant windows", () => {
		fc.assert(
			fc.property(
				instant,
				fc.integer({ min: 1, max: 400 * 24 }),
				cadence,
				fc.integer({ min: -30 * DAY, max: 420 * DAY }),
				(start, lengthHours, reset, offset) => {
					const end = new Date(start.getTime() + lengthHours * 3_600_000);
					const now = new Date(start.getTime() + offset);
					expect(planGrantWindowBounds(start, end, reset, now)).toEqual(
						referenceSubWindow(start, end, reset, now),
					);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("contains now, is stable inside itself, and tiles into the next window", () => {
		fc.assert(
			fc.property(
				period,
				cadence,
				fc.integer({ min: 0, max: 4 * 366 * DAY }),
				(p, reset, offset) => {
					fc.pre(publishable(p, reset));
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

	it("keeps every window of an aligned period one reset interval long, except a clamped last one", () => {
		fc.assert(
			fc.property(
				period.filter((p) => p.aligned),
				cadence,
				fc.integer({ min: 0, max: 4 * 366 * DAY }),
				(p, reset, offset) => {
					fc.pre(publishable(p, reset));
					const end = periodEnd(p);
					const window = bounds(p, end, reset, new Date(p.start.getTime() + offset));
					if (end !== null && window.end.getTime() === end.getTime()) {
						// The last window stops at the period end, no later than a full window would.
						expect(window.end.getTime()).toBeLessThanOrEqual(
							addCadence(window.start, reset, 1, p.start.getUTCDate()).getTime(),
						);
						return;
					}
					expectOneResetInterval(window, reset);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("rolls a lapsed period forward in whole reset intervals, aligned or not", () => {
		fc.assert(
			fc.property(
				period.filter((p) => p.billing !== null),
				cadence,
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

	it("adds calendar months with the anchor day clamped to each month", () => {
		fc.assert(
			fc.property(instant, fc.integer({ min: 0, max: 120 }), (start, months) => {
				const result = addUtcMonths(start, months);
				const lastDay = new Date(
					Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
				).getUTCDate();
				expect(result.getUTCDate()).toBe(Math.min(start.getUTCDate(), lastDay));
				expect(result.getTime() % DAY).toBe(start.getTime() % DAY);
			}),
			{ numRuns: NUM_RUNS },
		);
	});
});
