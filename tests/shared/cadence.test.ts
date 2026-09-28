import { describe, expect, it } from "bun:test";
import {
	addCadence,
	type Cadence,
	cadenceFitsWithin,
	cadenceKey,
	cadenceSplits,
	cadenceUnits,
	calendarWindow,
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

	it("aligns calendar windows to the UTC calendar", () => {
		const now = new Date("2026-09-17T13:45:10.000Z"); // a Thursday
		const window = (unit: Cadence["unit"], count = 1) => {
			const { start, end } = calendarWindow(cadence(unit, count), now);
			return [start.toISOString(), end.toISOString()];
		};
		expect(window("hour")).toEqual(["2026-09-17T13:00:00.000Z", "2026-09-17T14:00:00.000Z"]);
		// Multi-hour windows count from the epoch, so five-hour windows drift across midnight.
		expect(window("hour", 5)).toEqual(["2026-09-17T13:00:00.000Z", "2026-09-17T18:00:00.000Z"]);
		expect(window("day")).toEqual(["2026-09-17T00:00:00.000Z", "2026-09-18T00:00:00.000Z"]);
		expect(window("week")).toEqual(["2026-09-14T00:00:00.000Z", "2026-09-21T00:00:00.000Z"]);
		expect(window("day", 7)).toEqual(window("week"));
		expect(window("hour", 24)).toEqual(window("day"));
		expect(window("month")).toEqual(["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
		expect(window("quarter")).toEqual(["2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
		expect(window("month", 3)).toEqual(window("quarter"));
		expect(window("semi_annual")).toEqual(["2026-07-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
		expect(window("year")).toEqual(["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
		expect(window("year", 2)).toEqual(["2026-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z"]);
	});

	it("keeps month and year windows where calendar controls always had them", () => {
		for (const iso of [
			"2024-02-29T23:59:59.999Z",
			"2026-01-01T00:00:00.000Z",
			"2026-12-31T23:59:59.999Z",
			"2031-07-15T08:00:00.000Z",
		]) {
			const now = new Date(iso);
			expect(calendarWindow(cadence("month"), now)).toEqual({
				start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
				end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
			});
			expect(calendarWindow(cadence("year"), now)).toEqual({
				start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
				end: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)),
			});
		}
	});

	it("contains now and tiles into the next calendar window", () => {
		const cadences = cadenceUnits.flatMap((unit) =>
			[1, 2, 3, 7].map((count) => cadence(unit, count)),
		);
		for (let offset = 0; offset < 200; offset += 1) {
			const now = new Date(Date.UTC(2026, 0, 1) + offset * 7_919_000_017);
			for (const each of cadences) {
				const { start, end } = calendarWindow(each, now);
				expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
				expect(end.getTime()).toBeGreaterThan(now.getTime());
				expect(calendarWindow(each, end).start).toEqual(end);
				expect(calendarWindow(each, new Date(end.getTime() - 1))).toEqual({ start, end });
			}
		}
	});
});
