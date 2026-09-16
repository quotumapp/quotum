import { describe, expect, it } from "bun:test";
import {
	addUtcInterval,
	addUtcMonths,
	meterLimitWindowBounds,
} from "../../src/db/repository/meter-limit-windows";

describe("meter-limit window bounds", () => {
	it("uses the subscription period while it is current", () => {
		expect(
			meterLimitWindowBounds(
				"2026-09-10T00:00:00.000Z",
				"2026-10-10T00:00:00.000Z",
				"month",
				new Date("2026-09-16T12:00:00.000Z"),
			),
		).toEqual({
			start: new Date("2026-09-10T00:00:00.000Z"),
			end: new Date("2026-10-10T00:00:00.000Z"),
		});
	});

	it("rolls past periods forward by the reset interval, including an open-ended period", () => {
		const now = new Date("2026-12-11T00:00:00.000Z");
		expect(
			meterLimitWindowBounds("2026-09-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z", "month", now),
		).toEqual({
			start: new Date("2026-12-10T00:00:00.000Z"),
			end: new Date("2027-01-10T00:00:00.000Z"),
		});
		expect(meterLimitWindowBounds("2025-12-11T00:00:00.000Z", null, "year", now)).toEqual({
			start: new Date("2026-12-11T00:00:00.000Z"),
			end: new Date("2027-12-11T00:00:00.000Z"),
		});
	});

	it("clamps monthly arithmetic to the target month's final day", () => {
		expect(addUtcInterval(new Date("2026-01-31T12:34:56.789Z"), "month")).toEqual(
			new Date("2026-02-28T12:34:56.789Z"),
		);
		expect(addUtcMonths(new Date("2024-01-31T12:34:56.789Z"), 1)).toEqual(
			new Date("2024-02-29T12:34:56.789Z"),
		);
		expect(addUtcInterval(new Date("2024-02-29T12:34:56.789Z"), "year")).toEqual(
			new Date("2025-02-28T12:34:56.789Z"),
		);
	});

	it("preserves the subscription day through repeated month-end and leap-day rollovers", () => {
		expect(
			meterLimitWindowBounds(
				"2026-01-31T00:00:00.000Z",
				"2026-02-28T00:00:00.000Z",
				"month",
				new Date("2026-04-01T00:00:00.000Z"),
			),
		).toEqual({
			start: new Date("2026-03-31T00:00:00.000Z"),
			end: new Date("2026-04-30T00:00:00.000Z"),
		});
		expect(
			meterLimitWindowBounds(
				"2024-02-29T00:00:00.000Z",
				"2025-02-28T00:00:00.000Z",
				"year",
				new Date("2028-02-28T00:00:00.000Z"),
			),
		).toEqual({
			start: new Date("2027-02-28T00:00:00.000Z"),
			end: new Date("2028-02-29T00:00:00.000Z"),
		});
	});

	it("rejects empty or inverted periods", () => {
		expect(() =>
			meterLimitWindowBounds(
				"2026-10-10T00:00:00.000Z",
				"2026-10-10T00:00:00.000Z",
				"month",
				new Date("2026-10-11T00:00:00.000Z"),
			),
		).toThrow("Meter-limit subscription has invalid period bounds");
	});
});
