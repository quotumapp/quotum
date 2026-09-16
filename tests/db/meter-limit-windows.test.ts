import { describe, expect, it } from "bun:test";
import { meterLimitWindowBounds } from "../../src/db/repository/meter-limit-windows";

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
