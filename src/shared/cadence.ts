/**
 * The cadence vocabulary shared by allocation resets, usage windows, controls and billing
 * intervals: a unit and a positive whole count. Calendar units step in whole UTC months and keep an
 * anchor day of the month; fixed units step in exact hours. Everything is UTC, so no step ever
 * crosses a daylight-saving change.
 */
export const cadenceUnits = [
	"hour",
	"day",
	"week",
	"month",
	"quarter",
	"semi_annual",
	"year",
] as const;

export type CadenceUnit = (typeof cadenceUnits)[number];

export interface Cadence {
	unit: CadenceUnit;
	count: number;
}

/** The largest count a stored cadence accepts; spans are bounded further where a cadence is used. */
export const maxCadenceCount = 1000;

const calendarUnitMonths: Partial<Record<CadenceUnit, number>> = {
	month: 1,
	quarter: 3,
	semi_annual: 6,
	year: 12,
};

const fixedUnitHours: Partial<Record<CadenceUnit, number>> = {
	hour: 1,
	day: 24,
	week: 168,
};

const hourMs = 3_600_000;

export function isCadenceUnit(value: unknown): value is CadenceUnit {
	return typeof value === "string" && (cadenceUnits as readonly string[]).includes(value);
}

export function isCalendarUnit(unit: CadenceUnit): boolean {
	return calendarUnitMonths[unit] !== undefined;
}

/** Months in one unit for a calendar unit, otherwise null. */
export function unitMonths(unit: CadenceUnit): number | null {
	return calendarUnitMonths[unit] ?? null;
}

/** Hours in one unit for a fixed unit, otherwise null. */
export function unitHours(unit: CadenceUnit): number | null {
	return fixedUnitHours[unit] ?? null;
}

/**
 * The comparable form of a cadence: a calendar cadence in whole months, a fixed one in hours. Two
 * cadences with the same canonical form, such as a quarter and three months, produce identical
 * windows.
 */
export type CanonicalCadence =
	| { kind: "months"; months: number }
	| { kind: "hours"; hours: number };

export function canonicalCadence(cadence: Cadence): CanonicalCadence {
	const months = unitMonths(cadence.unit);
	if (months !== null) return { kind: "months", months: months * cadence.count };
	return { kind: "hours", hours: (unitHours(cadence.unit) ?? 0) * cadence.count };
}

/** A stable key for grouping or comparing cadences by the windows they produce. */
export function cadenceKey(cadence: Cadence): string {
	const canonical = canonicalCadence(cadence);
	return canonical.kind === "months" ? `months:${canonical.months}` : `hours:${canonical.hours}`;
}

export function sameCadence(left: Cadence, right: Cadence): boolean {
	return cadenceKey(left) === cadenceKey(right);
}

/**
 * Adds whole months in UTC, keeping the time of day. The day of month is `anchorDay` clamped to the
 * target month's length, so a Jan 31 anchor lands on Feb 28 (or 29) and recovers Mar 31.
 */
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

/**
 * Adds `steps` cadences. Calendar cadences keep `anchorDay` (see `addUtcMonths`); fixed ones add
 * exact hours.
 */
export function addCadence(
	value: Date,
	cadence: Cadence,
	steps = 1,
	anchorDay = value.getUTCDate(),
): Date {
	const canonical = canonicalCadence(cadence);
	if (canonical.kind === "months") {
		return addUtcMonths(value, canonical.months * steps, anchorDay);
	}
	return new Date(value.getTime() + canonical.hours * steps * hourMs);
}

/** Whole calendar months from `from` to `to`, ignoring days: Jan 31 to Feb 1 is one. */
export function utcMonthIndexDifference(from: Date, to: Date): number {
	return (
		(to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
	);
}

export function cadenceMilliseconds(cadence: Cadence): number | null {
	const canonical = canonicalCadence(cadence);
	return canonical.kind === "hours" ? canonical.hours * hourMs : null;
}

const commonYearMonthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The shortest span, in hours, that `months` consecutive calendar months can cover. Runs of seven
 * common years exist (2097 to 2103), so for spans up to seven years the minimum is taken over a
 * calendar without leap days.
 */
export function minCalendarSpanHours(months: number): number {
	let shortest = Number.POSITIVE_INFINITY;
	for (let first = 0; first < 12; first += 1) {
		let days = 0;
		for (let offset = 0; offset < months; offset += 1) {
			days += commonYearMonthDays[(first + offset) % 12] ?? 0;
		}
		shortest = Math.min(shortest, days);
	}
	return shortest * 24;
}

/**
 * Whether every window of `inner` fits inside one window of `outer`, whichever way the two are
 * aligned. A calendar cadence never fits inside a fixed one: months vary in length, so a
 * month-long window cannot be guaranteed to fit a fixed number of days.
 */
export function cadenceFitsWithin(inner: Cadence, outer: Cadence): boolean {
	const innerCanonical = canonicalCadence(inner);
	const outerCanonical = canonicalCadence(outer);
	if (innerCanonical.kind === "months") {
		return outerCanonical.kind === "months" && innerCanonical.months <= outerCanonical.months;
	}
	if (outerCanonical.kind === "hours") return innerCanonical.hours <= outerCanonical.hours;
	return innerCanonical.hours <= minCalendarSpanHours(outerCanonical.months);
}

/**
 * Whether a reset divides a billing period into more than one window. A fixed reset on a calendar
 * billing interval always does, since no whole number of hours matches every month's length; a
 * reset as long as the billing interval does not.
 */
export function cadenceSplits(reset: Cadence, billing: Cadence | null): boolean {
	if (billing === null) return false;
	const resetCanonical = canonicalCadence(reset);
	const billingCanonical = canonicalCadence(billing);
	if (resetCanonical.kind === "months") {
		return billingCanonical.kind === "months" && resetCanonical.months < billingCanonical.months;
	}
	if (billingCanonical.kind === "months") return true;
	return resetCanonical.hours < billingCanonical.hours;
}

/** A cadence as the API spells it, for messages: `month` or `3 × month`. */
export function describeCadence(cadence: Cadence): string {
	return cadence.count === 1 ? cadence.unit : `${cadence.count} × ${cadence.unit}`;
}
