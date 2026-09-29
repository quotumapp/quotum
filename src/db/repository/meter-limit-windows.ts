import { BillingError } from "../../billing/errors";
import {
	addCadence,
	type Cadence,
	type CadenceUnit,
	cadenceMilliseconds,
	cadenceSplits,
	canonicalCadence,
	utcMonthIndexDifference,
} from "../../shared/cadence";

/**
 * The usage window a meter limit counts against right now. Metering writes and every balance read
 * use these exact bounds, so a stale or differently anchored window for the same feature is never
 * read by accident.
 *
 * The provider period is the window while it is current, except when the item resets more often
 * than the plan bills (a monthly allowance on an annual plan, a weekly one on a monthly plan): the
 * period is then split into reset sub-windows anchored at the period start, the last one clamped to
 * the period end. Once the period has ended and no renewal has been recorded yet, windows keep
 * rolling forward from the period end by the reset cadence.
 */
export function meterLimitWindowBounds(
	periodStartAt: Date | string,
	periodEndAt: Date | string | null,
	reset: Cadence,
	now: Date,
	billing: Cadence | null = null,
): { start: Date; end: Date } {
	const start = new Date(periodStartAt);
	const end = periodEndAt === null ? addCadence(start, reset) : new Date(periodEndAt);
	if (periodEndAt !== null && cadenceSplits(reset, billing)) {
		if (now < end) {
			return resetSubWindowBounds(start, end, reset, now);
		}
		// The period is over and no renewal has been recorded: keep rolling in reset-sized windows
		// from the period end, anchored on its day, so an unaligned end does not stretch the first
		// window past one reset interval and the renewal's first sub-window lines up with it.
		assertPeriodBounds(start, end);
		return rollWindowBounds(end, addCadence(end, reset), reset, now);
	}
	return rollWindowBounds(start, end, reset, now);
}

/** The latest instant a Date holds; a grant without an end is windowed as if it ended there. */
const openEnd = new Date(8_640_000_000_000_000);

/**
 * The reset window of a plan grant that contains `now`. A grant's windows are anchored at its start
 * and the last one is clamped to its end, so no allowance or limit window outlives the grant; past
 * the end the last window is returned. A default-plan grant has no end, so its windows roll on.
 */
export function planGrantWindowBounds(
	startsAt: Date | string,
	endsAt: Date | string | null,
	reset: Cadence,
	now: Date,
): { start: Date; end: Date } {
	return resetSubWindowBounds(
		new Date(startsAt),
		endsAt === null ? openEnd : new Date(endsAt),
		reset,
		now,
	);
}

/**
 * The window of [start, end) or, once it has ended, of the reset-sized windows rolling on from its
 * end. A period exactly one interval long keeps its start's anchor day, so a month-end period that
 * was clamped (Jan 31 to Feb 28) rolls on to Mar 31. Any other period rolls on its end's day, as a
 * split period does, so no rolled window is longer or shorter than one reset interval. Fixed
 * cadences have no anchor day: every rolled window is exactly one cadence long.
 */
export function rollWindowBounds(
	start: Date,
	end: Date,
	reset: Cadence,
	now: Date,
): { start: Date; end: Date } {
	assertPeriodBounds(start, end);
	if (now < end) return { start, end };
	const milliseconds = cadenceMilliseconds(reset);
	if (milliseconds !== null) {
		const steps = Math.floor((now.getTime() - end.getTime()) / milliseconds);
		const windowStart = new Date(end.getTime() + steps * milliseconds);
		return { start: windowStart, end: new Date(windowStart.getTime() + milliseconds) };
	}
	const anchorDay =
		end.getTime() === addCadence(start, reset, 1, start.getUTCDate()).getTime()
			? start.getUTCDate()
			: end.getUTCDate();
	// Every step lands in its own calendar month, so the month distance finds the window directly;
	// within the month `now` falls in, the boundary may still be ahead of it.
	const steps = Math.floor(utcMonthIndexDifference(end, now) / calendarMonths(reset));
	const boundary = addCadence(end, reset, steps, anchorDay);
	return boundary > now
		? { start: addCadence(end, reset, steps - 1, anchorDay), end: boundary }
		: { start: boundary, end: addCadence(end, reset, steps + 1, anchorDay) };
}

/**
 * The reset sub-window of [start, end) that contains `now`, or the first or last one when `now` is
 * outside the period. Every boundary is computed from the period start and its anchor day, never
 * from a clamped predecessor, so month-end anchors keep their day.
 */
function resetSubWindowBounds(
	start: Date,
	end: Date,
	reset: Cadence,
	now: Date,
): { start: Date; end: Date } {
	assertPeriodBounds(start, end);
	const instant = now < start ? start : now >= end ? new Date(end.getTime() - 1) : now;
	const anchorDay = start.getUTCDate();
	const milliseconds = cadenceMilliseconds(reset);
	let steps =
		milliseconds === null
			? Math.floor(utcMonthIndexDifference(start, instant) / calendarMonths(reset))
			: Math.floor((instant.getTime() - start.getTime()) / milliseconds);
	let windowStart = addCadence(start, reset, steps, anchorDay);
	if (windowStart > instant) {
		steps -= 1;
		windowStart = addCadence(start, reset, steps, anchorDay);
	}
	const next = addCadence(start, reset, steps + 1, anchorDay);
	return { start: windowStart, end: next < end ? next : end };
}

function calendarMonths(cadence: Cadence): number {
	const canonical = canonicalCadence(cadence);
	if (canonical.kind !== "months") throw new Error("Expected a calendar cadence");
	return canonical.months;
}

function assertPeriodBounds(start: Date, end: Date): void {
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
		throw new BillingError(
			"Meter-limit subscription has invalid period bounds",
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
}

/** A stored cadence: the unit column and its count column, which defaults to one. */
export function storedCadence(unit: CadenceUnit, count: number | string | null = 1): Cadence {
	return { unit, count: count === null ? 1 : Number(count) };
}

/** A stored cadence whose unit column is nullable, such as a free plan's billing interval. */
export function optionalStoredCadence(
	unit: CadenceUnit | null,
	count: number | string | null = 1,
): Cadence | null {
	return unit === null ? null : storedCadence(unit, count);
}

export function startOfUtcMonth(value: Date): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}
