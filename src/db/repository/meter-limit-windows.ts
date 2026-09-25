import { BillingError } from "../../billing/errors";

type WindowInterval = "month" | "year";

/**
 * The usage window a meter limit counts against right now. Metering writes and every balance read
 * use these exact bounds, so a stale or differently anchored window for the same feature is never
 * read by accident.
 *
 * The provider period is the window while it is current, except when the item resets more often
 * than the plan bills (a monthly allowance on an annual plan): the period is then split into reset
 * sub-windows anchored at the period start, the last one clamped to the period end. Once the period
 * has ended and no renewal has been recorded yet, windows keep rolling forward from the period end
 * by the reset interval.
 */
export function meterLimitWindowBounds(
	periodStartAt: Date | string,
	periodEndAt: Date | string | null,
	interval: WindowInterval,
	now: Date,
	billingInterval: WindowInterval | null = null,
): { start: Date; end: Date } {
	const start = new Date(periodStartAt);
	const end = periodEndAt === null ? addUtcInterval(start, interval) : new Date(periodEndAt);
	const usesResetSubWindows =
		periodEndAt !== null &&
		billingInterval !== null &&
		intervalMonths(interval) < intervalMonths(billingInterval);
	if (usesResetSubWindows) {
		if (now < end) {
			return resetSubWindowBounds(start, end, interval, now);
		}
		// The period is over and no renewal has been recorded: keep rolling in reset-sized windows
		// from the period end, anchored on its day, so an unaligned end does not stretch the first
		// window past one reset interval and the renewal's first sub-window lines up with it.
		assertPeriodBounds(start, end);
		return rollWindowBounds(end, addUtcInterval(end, interval), interval, now);
	}
	return rollWindowBounds(start, end, interval, now);
}

/**
 * The reset window of a plan grant that contains `now`. A grant's windows are anchored at its start
 * and the last one is clamped to its end, so no allowance or limit window outlives the grant; past
 * the end the last window is returned.
 */
export function planGrantWindowBounds(
	startsAt: Date | string,
	endsAt: Date | string,
	interval: WindowInterval,
	now: Date,
): { start: Date; end: Date } {
	return resetSubWindowBounds(new Date(startsAt), new Date(endsAt), interval, now);
}

/**
 * The window of [start, end) or, once it has ended, of the reset-sized windows rolling on from its
 * end. A period exactly one interval long keeps its start's anchor day, so a month-end period that
 * was clamped (Jan 31 to Feb 28) rolls on to Mar 31. Any other period rolls on its end's day, as a
 * split period does, so no rolled window is longer or shorter than one reset interval.
 */
export function rollWindowBounds(
	start: Date,
	end: Date,
	interval: WindowInterval,
	now: Date,
): { start: Date; end: Date } {
	assertPeriodBounds(start, end);
	let currentStart = start;
	let currentEnd = end;
	const anchorDay =
		end.getTime() === addUtcInterval(start, interval).getTime()
			? start.getUTCDate()
			: end.getUTCDate();
	while (currentEnd <= now) {
		currentStart = currentEnd;
		currentEnd = addUtcInterval(currentEnd, interval, anchorDay);
	}
	return { start: currentStart, end: currentEnd };
}

/**
 * The reset sub-window of [start, end) that contains `now`. Every sub-window is computed from the
 * period start and its anchor day, never from a clamped predecessor, so month-end anchors keep
 * their day.
 */
function resetSubWindowBounds(
	start: Date,
	end: Date,
	interval: WindowInterval,
	now: Date,
): { start: Date; end: Date } {
	assertPeriodBounds(start, end);
	const anchorDay = start.getUTCDate();
	const months = intervalMonths(interval);
	let step = 0;
	let currentStart = start;
	for (;;) {
		const nextStart = addUtcMonths(start, months * (step + 1), anchorDay);
		const currentEnd = nextStart < end ? nextStart : end;
		if (now < currentEnd || currentEnd >= end) {
			return { start: currentStart, end: currentEnd };
		}
		step += 1;
		currentStart = nextStart;
	}
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

export function intervalMonths(interval: WindowInterval): number {
	return interval === "month" ? 1 : 12;
}

export function addUtcInterval(
	value: Date,
	interval: WindowInterval,
	anchorDay = value.getUTCDate(),
): Date {
	return addUtcMonths(value, intervalMonths(interval), anchorDay);
}

export function addUtcMonths(value: Date, months: number, anchorDay = value.getUTCDate()): Date {
	const result = new Date(value);
	result.setUTCDate(1);
	result.setUTCMonth(result.getUTCMonth() + months);
	const lastDay = new Date(
		Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
	).getUTCDate();
	result.setUTCDate(Math.min(anchorDay, lastDay));
	return result;
}

export function startOfUtcMonth(value: Date): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}
