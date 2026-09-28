import { describe, expect, it } from "bun:test";
import {
	addCadence,
	type Cadence,
	cadenceFitsWithin,
	cadenceKey,
	cadenceSplits,
	cadenceUnits,
	canonicalCadence,
	describeCadence,
	isCadenceUnit,
	isCalendarUnit,
	minCalendarSpanHours,
	sameCadence,
	utcMonthIndexDifference,
} from "../../src/shared/cadence";

const cadence = (unit: Cadence["unit"], count = 1): Cadence => ({ unit, count });

describe("cadence vocabulary", () => {
	it("recognizes exactly the published units", () => {
		for (const unit of cadenceUnits) expect(isCadenceUnit(unit)).toBe(true);
		for (const value of ["minute", "months", "", null, 1]) expect(isCadenceUnit(value)).toBe(false);
		expect(cadenceUnits.filter(isCalendarUnit)).toEqual([
			"month",
			"quarter",
			"semi_annual",
			"year",
		]);
	});

	it("compares cadences by the windows they produce", () => {
		expect(canonicalCadence(cadence("quarter", 2))).toEqual({ kind: "months", months: 6 });
		expect(canonicalCadence(cadence("week", 2))).toEqual({ kind: "hours", hours: 336 });
		expect(sameCadence(cadence("quarter"), cadence("month", 3))).toBe(true);
		expect(sameCadence(cadence("semi_annual"), cadence("quarter", 2))).toBe(true);
		expect(sameCadence(cadence("year"), cadence("month", 12))).toBe(true);
		expect(sameCadence(cadence("week"), cadence("day", 7))).toBe(true);
		expect(sameCadence(cadence("day"), cadence("hour", 24))).toBe(true);
		// Four weeks is never a month: months vary in length.
		expect(sameCadence(cadence("week", 4), cadence("month"))).toBe(false);
		expect(cadenceKey(cadence("month", 3))).toBe("months:3");
		expect(cadenceKey(cadence("hour", 5))).toBe("hours:5");
	});

	it("adds calendar cadences with an anchor day and fixed cadences in exact hours", () => {
		const start = new Date("2026-01-31T12:34:56.789Z");
		expect(addCadence(start, cadence("month"))).toEqual(new Date("2026-02-28T12:34:56.789Z"));
		expect(addCadence(start, cadence("quarter"))).toEqual(new Date("2026-04-30T12:34:56.789Z"));
		expect(addCadence(start, cadence("semi_annual"))).toEqual(new Date("2026-07-31T12:34:56.789Z"));
		expect(addCadence(new Date("2024-02-29T00:00:00.000Z"), cadence("year"))).toEqual(
			new Date("2025-02-28T00:00:00.000Z"),
		);
		expect(addCadence(new Date("2026-02-28T00:00:00.000Z"), cadence("month"), 1, 31)).toEqual(
			new Date("2026-03-31T00:00:00.000Z"),
		);
		expect(addCadence(start, cadence("week"), 2)).toEqual(new Date("2026-02-14T12:34:56.789Z"));
		expect(addCadence(start, cadence("hour", 5), -1)).toEqual(new Date("2026-01-31T07:34:56.789Z"));
	});

	it("counts calendar months between instants regardless of the day", () => {
		expect(
			utcMonthIndexDifference(
				new Date("2026-01-31T23:59:59.999Z"),
				new Date("2026-02-01T00:00:00.000Z"),
			),
		).toBe(1);
		expect(
			utcMonthIndexDifference(
				new Date("2026-12-01T00:00:00.000Z"),
				new Date("2025-11-30T00:00:00.000Z"),
			),
		).toBe(-13);
	});

	it("finds the shortest run of consecutive months", () => {
		const days = (months: number) => minCalendarSpanHours(months) / 24;
		expect([1, 2, 3, 4, 6, 12, 24, 36].map(days)).toEqual([28, 59, 89, 120, 181, 365, 730, 1095]);
	});

	it("fits a cadence inside another only when every window can", () => {
		expect(cadenceFitsWithin(cadence("month"), cadence("year"))).toBe(true);
		expect(cadenceFitsWithin(cadence("year"), cadence("month"))).toBe(false);
		expect(cadenceFitsWithin(cadence("quarter"), cadence("month", 3))).toBe(true);
		expect(cadenceFitsWithin(cadence("week", 4), cadence("month"))).toBe(true);
		expect(cadenceFitsWithin(cadence("day", 28), cadence("month"))).toBe(true);
		expect(cadenceFitsWithin(cadence("day", 29), cadence("month"))).toBe(false);
		expect(cadenceFitsWithin(cadence("day", 1095), cadence("year", 3))).toBe(true);
		expect(cadenceFitsWithin(cadence("week", 157), cadence("year", 3))).toBe(false);
		expect(cadenceFitsWithin(cadence("hour", 24), cadence("day"))).toBe(true);
		expect(cadenceFitsWithin(cadence("month"), cadence("day", 31))).toBe(false);
	});

	it("splits a billing period only when the reset is shorter", () => {
		expect(cadenceSplits(cadence("month"), cadence("year"))).toBe(true);
		expect(cadenceSplits(cadence("month"), cadence("month"))).toBe(false);
		expect(cadenceSplits(cadence("quarter"), cadence("month", 3))).toBe(false);
		expect(cadenceSplits(cadence("week"), cadence("month"))).toBe(true);
		expect(cadenceSplits(cadence("day", 28), cadence("month"))).toBe(true);
		expect(cadenceSplits(cadence("day"), cadence("week"))).toBe(true);
		expect(cadenceSplits(cadence("week"), cadence("day", 7))).toBe(false);
		expect(cadenceSplits(cadence("month"), cadence("day", 90))).toBe(false);
		expect(cadenceSplits(cadence("day"), null)).toBe(false);
	});

	it("describes a cadence as the API spells it", () => {
		expect(describeCadence(cadence("month"))).toBe("month");
		expect(describeCadence(cadence("semi_annual", 2))).toBe("2 × semi_annual");
	});
});
