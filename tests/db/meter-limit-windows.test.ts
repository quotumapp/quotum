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

	it("splits a long billing period into reset sub-windows anchored at the period start", () => {
		expect(
			meterLimitWindowBounds(
				"2026-01-01T00:00:00.000Z",
				"2027-01-01T00:00:00.000Z",
				"month",
				new Date("2026-09-22T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-09-01T00:00:00.000Z"),
			end: new Date("2026-10-01T00:00:00.000Z"),
		});
		// The first sub-window is the period start itself, and a future period starts on its first one.
		expect(
			meterLimitWindowBounds(
				"2026-01-01T00:00:00.000Z",
				"2027-01-01T00:00:00.000Z",
				"month",
				new Date("2026-01-15T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-01-01T00:00:00.000Z"),
			end: new Date("2026-02-01T00:00:00.000Z"),
		});
		expect(
			meterLimitWindowBounds(
				"2026-03-01T00:00:00.000Z",
				"2027-03-01T00:00:00.000Z",
				"month",
				new Date("2026-02-20T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-03-01T00:00:00.000Z"),
			end: new Date("2026-04-01T00:00:00.000Z"),
		});
	});

	it("keeps the period's anchor day for every reset sub-window", () => {
		const periodStart = "2026-01-31T00:00:00.000Z";
		const periodEnd = "2027-01-31T00:00:00.000Z";
		expect(
			meterLimitWindowBounds(
				periodStart,
				periodEnd,
				"month",
				new Date("2026-02-10T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-01-31T00:00:00.000Z"),
			end: new Date("2026-02-28T00:00:00.000Z"),
		});
		// The third sub-window is computed from the anchor, not from the clamped February end.
		expect(
			meterLimitWindowBounds(
				periodStart,
				periodEnd,
				"month",
				new Date("2026-03-05T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-02-28T00:00:00.000Z"),
			end: new Date("2026-03-31T00:00:00.000Z"),
		});
		expect(
			meterLimitWindowBounds(
				periodStart,
				periodEnd,
				"month",
				new Date("2027-01-30T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-12-31T00:00:00.000Z"),
			end: new Date("2027-01-31T00:00:00.000Z"),
		});
	});

	it("clamps the last reset sub-window to an unaligned period end", () => {
		expect(
			meterLimitWindowBounds(
				"2026-01-15T00:00:00.000Z",
				"2026-12-01T00:00:00.000Z",
				"month",
				new Date("2026-11-20T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-11-15T00:00:00.000Z"),
			end: new Date("2026-12-01T00:00:00.000Z"),
		});
	});

	it("rolls forward from the period end by the reset interval once the period is over", () => {
		expect(
			meterLimitWindowBounds(
				"2026-01-01T00:00:00.000Z",
				"2027-01-01T00:00:00.000Z",
				"month",
				new Date("2027-02-10T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2027-02-01T00:00:00.000Z"),
			end: new Date("2027-03-01T00:00:00.000Z"),
		});
	});

	it("rolls an expired unaligned split period from its end", () => {
		expect(
			meterLimitWindowBounds(
				"2026-01-15T00:00:00.000Z",
				"2026-12-01T00:00:00.000Z",
				"month",
				new Date("2026-12-10T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-12-01T00:00:00.000Z"),
			end: new Date("2027-01-01T00:00:00.000Z"),
		});
		expect(
			meterLimitWindowBounds(
				"2026-01-15T00:00:00.000Z",
				"2026-12-01T00:00:00.000Z",
				"month",
				new Date("2027-02-03T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2027-02-01T00:00:00.000Z"),
			end: new Date("2027-03-01T00:00:00.000Z"),
		});
	});

	it("keeps the provider period when the reset interval is not shorter than the billing interval", () => {
		// Monthly billing with a monthly reset follows the provider's month-end anchoring as is.
		expect(
			meterLimitWindowBounds(
				"2026-01-31T00:00:00.000Z",
				"2026-02-28T00:00:00.000Z",
				"month",
				new Date("2026-02-10T00:00:00.000Z"),
				"month",
			),
		).toEqual({
			start: new Date("2026-01-31T00:00:00.000Z"),
			end: new Date("2026-02-28T00:00:00.000Z"),
		});
		expect(
			meterLimitWindowBounds(
				"2026-02-28T00:00:00.000Z",
				"2026-03-31T00:00:00.000Z",
				"month",
				new Date("2026-03-10T00:00:00.000Z"),
				"month",
			),
		).toEqual({
			start: new Date("2026-02-28T00:00:00.000Z"),
			end: new Date("2026-03-31T00:00:00.000Z"),
		});
		// A yearly reset on a monthly plan counts against the current month.
		expect(
			meterLimitWindowBounds(
				"2026-09-10T00:00:00.000Z",
				"2026-10-10T00:00:00.000Z",
				"year",
				new Date("2026-09-16T12:00:00.000Z"),
				"month",
			),
		).toEqual({
			start: new Date("2026-09-10T00:00:00.000Z"),
			end: new Date("2026-10-10T00:00:00.000Z"),
		});
		// Without a billing interval, or for an open-ended period, the period is the window.
		expect(
			meterLimitWindowBounds(
				"2026-01-01T00:00:00.000Z",
				"2027-01-01T00:00:00.000Z",
				"month",
				new Date("2026-09-22T00:00:00.000Z"),
			),
		).toEqual({
			start: new Date("2026-01-01T00:00:00.000Z"),
			end: new Date("2027-01-01T00:00:00.000Z"),
		});
		expect(
			meterLimitWindowBounds(
				"2026-01-01T00:00:00.000Z",
				null,
				"month",
				new Date("2026-09-22T00:00:00.000Z"),
				"year",
			),
		).toEqual({
			start: new Date("2026-09-01T00:00:00.000Z"),
			end: new Date("2026-10-01T00:00:00.000Z"),
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
