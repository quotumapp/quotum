import { describe, expect, it } from "bun:test";
import type { MeteringBalance } from "../../../src/billing/metering";
import {
	type MeterLimitDecision,
	meterLimitReservationSpend,
	meterLimitSpendDelta,
} from "../../../src/db/repository/metering-persistence";

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
