import { BillingError } from "../../billing/errors";

/**
 * The usage window a meter limit counts against right now. Metering writes and every balance read
 * use these exact bounds, so a stale or differently anchored window for the same feature is never
 * read by accident.
 */
export function meterLimitWindowBounds(
	periodStartAt: Date | string,
	periodEndAt: Date | string | null,
	interval: "month" | "year",
	now: Date,
): { start: Date; end: Date } {
	const start = new Date(periodStartAt);
	const end = periodEndAt === null ? addUtcInterval(start, interval) : new Date(periodEndAt);
	return rollWindowBounds(start, end, interval, now);
}

export function rollWindowBounds(
	start: Date,
	end: Date,
	interval: "month" | "year",
	now: Date,
): { start: Date; end: Date } {
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
		throw new BillingError(
			"Meter-limit subscription has invalid period bounds",
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	let currentStart = start;
	let currentEnd = end;
	const subscriptionDay = start.getUTCDate();
	while (currentEnd <= now) {
		currentStart = currentEnd;
		currentEnd = addUtcInterval(currentEnd, interval, subscriptionDay);
	}
	return { start: currentStart, end: currentEnd };
}

export function addUtcInterval(
	value: Date,
	interval: "month" | "year",
	anchorDay = value.getUTCDate(),
): Date {
	return addUtcMonths(value, interval === "month" ? 1 : 12, anchorDay);
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
