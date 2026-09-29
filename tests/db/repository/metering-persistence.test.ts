import { describe, expect, it } from "bun:test";
import type { MeteringBalance } from "../../../src/billing/metering";
import {
	type AllocationRow,
	calculateWalletQuantity,
	type FeatureRow,
	type MeterLimitDecision,
	meterLimitReservationSpend,
	meterLimitSpendDelta,
	planConfirmation,
	type RateDecision,
} from "../../../src/db/repository/metering-persistence";
import { FakeDatabase } from "../repository-fixture";

const meter: MeterLimitDecision = {
	feature: {
		id: "1",
		key: "calls",
		unit: "call",
		credit_scale: 1,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	},
	subscriptionId: "subscription",
	planItemId: "1",
	limit: "25",
	overagePolicy: "allowed",
	windowStartAt: new Date("2026-09-01"),
	windowEndAt: new Date("2026-10-01"),
	overagePrice: {
		priceComponentId: "1",
		pricingModel: "volume",
		billingUnits: "10",
		unitAmountMinor: 0n,
		currency: "USD",
		tiers: [
			{ upToQuantity: "100.3", unitAmountMinor: 20n, flatAmountMinor: 0n },
			{ upToQuantity: "110.7", unitAmountMinor: 12n, flatAmountMinor: 40n },
			{ upToQuantity: null, unitAmountMinor: 8n, flatAmountMinor: 0n },
		],
	},
};

function balance(consumed: string, held = "0"): MeteringBalance {
	return {
		featureKey: "calls",
		unit: "call",
		scale: 1,
		granted: "25",
		consumed,
		held,
		available: "0",
		breakdown: [],
	};
}

describe("meter-limit spend rating", () => {
	it("earns discounts only from committed consumption", () => {
		expect(meterLimitSpendDelta(meter, balance("125.3", "10"), "0.1")).toEqual({
			spendMinorDelta: "-41",
			currency: "USD",
		});
	});

	it.each(["0.6", "1", "20"])(
		"quotes the rounded fractional tier peak for quantity %s",
		(quantity) => {
			// 124.7 costs 199; the inclusive 125.3 boundary costs 201 before the tier drops.
			expect(meterLimitReservationSpend(meter, balance("124.7", "100"), quantity)).toEqual({
				spendMinorDelta: "2",
				currency: "USD",
			});
		},
	);

	it("checks every intermediate tier, including a flat-fee peak", () => {
		const price = meter.overagePrice;
		if (price === null) throw new Error("Expected volume price");
		const withFlatFee: MeterLimitDecision = {
			...meter,
			overagePrice: {
				...price,
				tiers: price.tiers.map((tier, index) => ({
					...tier,
					flatAmountMinor: index === 1 ? 500n : 0n,
				})),
			},
		};
		// At 135.7, 110.7 billable units cost 633; the final tier then drops below the starting 199.
		expect(meterLimitReservationSpend(withFlatFee, balance("124.7"), "20").spendMinorDelta).toBe(
			"434",
		);
	});

	it("never quotes a negative hold across a discount", () => {
		expect(meterLimitReservationSpend(meter, balance("125.3"), "1").spendMinorDelta).toBe("0");
	});
});

describe("rate-card wallet charges", () => {
	function feature(key: string): FeatureRow {
		return {
			id: key,
			key,
			unit: key,
			credit_scale: 0,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		};
	}

	it("restarts graduated tiers on every request", async () => {
		const rate: RateDecision = {
			meter: feature("tokens"),
			wallet: feature("credits"),
			path: "additive",
			revision: 1,
			revisionId: "1",
			entryId: "1",
			pricingModel: "graduated",
			ratePerUnit: "2",
			tiers: [
				{ upToQuantity: "10", ratePerUnit: "2" },
				{ upToQuantity: null, ratePerUnit: "1" },
			],
		};
		// Strict with nothing scripted: the charge cannot read earlier usage in the period.
		const database = new FakeDatabase([], { strict: true });
		expect(await calculateWalletQuantity(database as never, rate, "20")).toBe("30");
		// Two requests of 10 each start in the first tier, so together they cost 40, not 30.
		expect(await calculateWalletQuantity(database as never, rate, "10")).toBe("20");
		expect(await calculateWalletQuantity(database as never, rate, "10")).toBe("20");
		expect(database.queries).toHaveLength(0);
	});
});

describe("reservation confirmation plan", () => {
	function allocation(
		id: string,
		values: { quantity: string; reversed?: string; consumed?: string; held?: string },
	): AllocationRow {
		return {
			id,
			quantity: values.quantity,
			reversed_quantity: values.reversed ?? "0",
			consumed_quantity: values.consumed ?? "0",
			held_quantity: values.held ?? "0",
			source_kind: "topup",
			source_key: `topup:${id}`,
			expires_at: null,
			created_at: "2026-09-01T00:00:00.000Z",
			reversed_at: null,
			entity_external_id: null,
			rollover_origin_allocation_id: null,
			carry_over_origin_allocation_id: null,
			rollover_policy_revision: null,
			period_start_at: null,
			period_end_at: null,
		};
	}

	it("settles extra consumption only from quantity a partial refund left", () => {
		// Allocation 1 holds the reservation's 4; a partial refund reversed 8 of its other 10.
		const plan = planConfirmation(
			[
				allocation("1", { quantity: "20", reversed: "8", consumed: "6", held: "4" }),
				allocation("2", { quantity: "10" }),
			],
			[{ allocation_id: "1", held_quantity: "4", consumed_quantity: "0" }],
			0,
			"12",
		);

		expect(plan.changes).toEqual([
			{ allocationId: "1", consume: 6n, release: 4n, hasHold: true },
			{ allocationId: "2", consume: 6n, release: 0n, hasHold: false },
		]);
	});

	it("refuses extra consumption that only reversed quantity could cover", () => {
		expect(() =>
			planConfirmation(
				[allocation("1", { quantity: "10", reversed: "6", held: "4" })],
				[{ allocation_id: "1", held_quantity: "4", consumed_quantity: "0" }],
				0,
				"6",
			),
		).toThrow(expect.objectContaining({ code: "INSUFFICIENT_BALANCE", status: 409 }));
	});
});
