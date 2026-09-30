import { describe, expect, it } from "bun:test";
import {
	combineMeterLimits,
	type MeterLimitRow,
	meterLimitBounds,
	meterLimitsJoin,
} from "../../src/db/repository/meter-limit-sources";

function row(overrides: Partial<MeterLimitRow>): MeterLimitRow {
	return {
		plan_item_id: "1",
		subscription_id: "sub-base",
		plan_grant_id: null,
		quantity: "100.000000000",
		overage_policy: "blocked",
		reset_interval: "day",
		reset_interval_count: 1,
		billing_interval: "month",
		billing_interval_count: 1,
		period_start_at: "2026-09-01T00:00:00Z",
		period_end_at: "2026-10-01T00:00:00Z",
		plan_kind: "base",
		sort_at: "2026-09-01T00:00:00Z",
		...overrides,
	};
}

const base = row({});
const addOn = row({
	plan_item_id: "2",
	subscription_id: "sub-add-on",
	plan_kind: "addon",
	quantity: "50",
	sort_at: "2026-09-10T00:00:00Z",
});

describe("combined meter limits", () => {
	it("adds an add-on's limit to the base plan's, which anchors the window", () => {
		expect(combineMeterLimits([base, addOn], 0)).toEqual({ anchor: base, quantity: "150" });
		expect(combineMeterLimits([addOn, base, { ...addOn, plan_item_id: "3" }], 0)).toEqual({
			anchor: base,
			quantity: "200",
		});
	});

	it("keeps an add-on that cannot join the anchor's window out of the sum", () => {
		for (const other of [
			{ ...addOn, reset_interval: "month" as const },
			{ ...addOn, reset_interval_count: 2 },
			{ ...addOn, overage_policy: "allowed" as const },
		]) {
			expect(combineMeterLimits([base, other], 0)).toEqual({ anchor: base, quantity: "100" });
		}
		const postpaid = { ...base, overage_policy: "allowed" as const };
		expect(combineMeterLimits([postpaid, addOn], 0)).toEqual({ anchor: postpaid, quantity: "100" });
	});

	it("anchors on the newest base plan, or the newest add-on without one", () => {
		const newerBase = { ...base, plan_item_id: "4", subscription_id: "sub-newer", quantity: "70" };
		expect(
			combineMeterLimits([base, { ...newerBase, sort_at: "2026-09-20T00:00:00Z" }], 0),
		).toMatchObject({ anchor: { subscription_id: "sub-newer" }, quantity: "70" });
		const newerAddOn = { ...addOn, subscription_id: "sub-newer-add-on", quantity: "5" };
		expect(
			combineMeterLimits([addOn, { ...newerAddOn, sort_at: "2026-09-20T00:00:00Z" }], 0),
		).toMatchObject({ anchor: { subscription_id: "sub-newer-add-on" }, quantity: "55" });
	});

	it("takes a paying subscription's limit before a plan grant's, and the first grant alone", () => {
		const grant = { ...base, subscription_id: null, plan_grant_id: "grant-1", quantity: "10" };
		expect(combineMeterLimits([grant, base], 0)).toEqual({ anchor: base, quantity: "100" });
		expect(combineMeterLimits([grant, { ...grant, plan_grant_id: "grant-2" }], 0)).toEqual({
			anchor: grant,
			quantity: "10",
		});
		expect(combineMeterLimits([], 0)).toBeNull();
	});

	it("sums at the feature's scale", () => {
		expect(
			combineMeterLimits(
				[
					{ ...base, quantity: "0.25" },
					{ ...addOn, quantity: "0.5" },
				],
				2,
			),
		).toMatchObject({ quantity: "0.75" });
	});

	it("joins only hard caps with the same reset", () => {
		expect(meterLimitsJoin(base, addOn)).toBe(true);
		expect(meterLimitsJoin(base, { ...addOn, reset_interval: "week" })).toBe(false);
	});

	it("windows a subscription within its period and a grant from its start", () => {
		const now = new Date("2026-09-15T12:00:00Z");
		expect(meterLimitBounds(base, now)).toEqual({
			start: new Date("2026-09-15T00:00:00Z"),
			end: new Date("2026-09-16T00:00:00Z"),
		});
		const grant = {
			...base,
			subscription_id: null,
			plan_grant_id: "grant-1",
			period_start_at: "2026-09-14T06:00:00Z",
			period_end_at: null,
		};
		expect(meterLimitBounds(grant, now)).toEqual({
			start: new Date("2026-09-15T06:00:00Z"),
			end: new Date("2026-09-16T06:00:00Z"),
		});
	});
});
