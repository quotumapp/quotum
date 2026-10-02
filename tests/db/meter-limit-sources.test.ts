import { describe, expect, it } from "bun:test";
import {
	combineMeterLimits,
	type MeterLimitRow,
	meterLimitBounds,
	meterLimitsJoin,
	mixedScopeSources,
	unlimitedLiftsCap,
} from "../../src/db/repository/meter-limit-sources";

function row(overrides: Partial<MeterLimitRow>): MeterLimitRow {
	return {
		plan_item_id: "1",
		item_kind: "meter_limit",
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
		allocation_scope: "account",
		plan_key: "pro",
		plan_version: 1,
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

	it("joins only hard caps with the same reset and declared scope", () => {
		expect(meterLimitsJoin(base, addOn)).toBe(true);
		expect(meterLimitsJoin(base, { ...addOn, reset_interval: "week" })).toBe(false);
		expect(meterLimitsJoin(base, { ...addOn, allocation_scope: "entity" })).toBe(false);
		// An add-on with another scope leaves the anchor's quantity alone.
		expect(combineMeterLimits([base, { ...addOn, allocation_scope: "entity" }], 0)).toEqual({
			anchor: base,
			quantity: "100",
		});
	});

	it("names paying sources that mix scopes, but not a plan grant", () => {
		const entityAddOn = { ...addOn, allocation_scope: "entity" as const };
		expect(mixedScopeSources([base, addOn], base)).toEqual([]);
		expect(mixedScopeSources([base, entityAddOn], base)).toEqual([base, entityAddOn]);
		const grant = { ...entityAddOn, subscription_id: null, plan_grant_id: "grant-1" };
		expect(mixedScopeSources([base, grant], base)).toEqual([]);
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

describe("unlimited usage sources", () => {
	const unlimited = row({
		plan_item_id: "9",
		item_kind: "unlimited_usage",
		subscription_id: "sub-unlimited",
		quantity: null,
		plan_kind: "addon",
	});

	it("leaves an unlimited item out of the finite sum and lets it lift a hard cap", () => {
		expect(combineMeterLimits([base, unlimited], 0)).toMatchObject({
			anchor: base,
			quantity: "100",
		});
		expect(combineMeterLimits([unlimited], 0)).toBeNull();
		expect(unlimitedLiftsCap([base, unlimited], base)).toBe(true);
		expect(unlimitedLiftsCap([unlimited], null)).toBe(true);
		expect(unlimitedLiftsCap([base], base)).toBe(false);
	});

	it("never lifts a postpaid limit, which has no cap to lift", () => {
		const postpaid = row({ overage_policy: "allowed" });
		expect(unlimitedLiftsCap([postpaid, unlimited], postpaid)).toBe(false);
	});

	it("counts a plan grant's unlimited item only while no subscription is paying", () => {
		const granted = { ...unlimited, subscription_id: null, plan_grant_id: "grant-1" };
		expect(unlimitedLiftsCap([granted], null)).toBe(true);
		expect(unlimitedLiftsCap([base, granted], base)).toBe(false);
	});
});

describe("unlimited usage and declared scope", () => {
	const unlimitedAddOn = row({
		plan_item_id: "4",
		item_kind: "unlimited_usage",
		subscription_id: "sub-unlimited",
		plan_kind: "addon",
		quantity: "0",
		allocation_scope: "account",
	});

	it("lifts only a cap of the unlimited source's own scope", () => {
		expect(unlimitedLiftsCap([base, unlimitedAddOn], base)).toBe(true);
		const entityCap = row({ allocation_scope: "entity" });
		expect(unlimitedLiftsCap([entityCap, unlimitedAddOn], entityCap)).toBe(false);
		// With no finite cap there is nothing of another scope to conflict with.
		expect(unlimitedLiftsCap([unlimitedAddOn], null)).toBe(true);
	});

	it("reports an unlimited source of another scope than the cap as a mixed scope", () => {
		const entityCap = row({ allocation_scope: "entity" });
		expect(mixedScopeSources([entityCap, unlimitedAddOn], entityCap)).toEqual([
			entityCap,
			unlimitedAddOn,
		]);
		expect(mixedScopeSources([base, unlimitedAddOn], base)).toEqual([]);
	});
});
