import { describe, expect, it } from "bun:test";
import {
	calculateRateCardQuantity,
	calculateTieredUsageCharge,
	calculateUsageCharge,
	classifySubscriptionChange,
	defaultChangeTiming,
	stripeProrationForChange,
} from "../../src/billing/pricing";

describe("recurring pricing", () => {
	it("prices aggregate overage once with integer minor-unit rounding", () => {
		expect(
			calculateUsageCharge({
				usageQuantity: "1250.5",
				includedQuantity: "1000",
				billingUnits: "100",
				unitAmountMinor: 25n,
			}),
		).toEqual({
			usageQuantity: "1250.5",
			includedQuantity: "1000",
			billableQuantity: "250.5",
			amountMinor: 63n,
		});
	});

	it("never produces a negative overage", () => {
		expect(
			calculateUsageCharge({
				usageQuantity: "2",
				includedQuantity: "10",
				billingUnits: "1",
				unitAmountMinor: 50n,
			}),
		).toMatchObject({ billableQuantity: "0", amountMinor: 0n });
	});

	it("prices graduated tiers marginally and rounds the aggregate once", () => {
		expect(
			calculateTieredUsageCharge({
				usageQuantity: "275.5",
				includedQuantity: "25",
				billingUnits: "10",
				pricingModel: "graduated",
				tiers: [
					{ upToQuantity: "100", unitAmountMinor: 20n, flatAmountMinor: 5n },
					{ upToQuantity: "200", unitAmountMinor: 15n },
					{ upToQuantity: null, unitAmountMinor: 10n },
				],
			}),
		).toEqual({
			usageQuantity: "275.5",
			includedQuantity: "25",
			billableQuantity: "250.5",
			amountMinor: 406n,
		});
	});

	it("prices all volume in the matching tier", () => {
		expect(
			calculateTieredUsageCharge({
				usageQuantity: "250",
				includedQuantity: "0",
				billingUnits: "10",
				pricingModel: "volume",
				tiers: [
					{ upToQuantity: "100", unitAmountMinor: 20n },
					{ upToQuantity: "500", unitAmountMinor: 12n, flatAmountMinor: 40n },
					{ upToQuantity: null, unitAmountMinor: 8n },
				],
			}),
		).toMatchObject({ billableQuantity: "250", amountMinor: 340n });
	});

	it("rejects tier gaps and non-final unbounded tiers", () => {
		expect(() =>
			calculateTieredUsageCharge({
				usageQuantity: "1",
				includedQuantity: "0",
				billingUnits: "1",
				pricingModel: "graduated",
				tiers: [{ upToQuantity: "10", unitAmountMinor: 1n }],
			}),
		).toThrow("final pricing tier must be unbounded");
	});

	it("converts graduated rate cards marginally and rounds once", () => {
		expect(
			calculateRateCardQuantity({
				quantity: "12.5",
				pricingModel: "graduated",
				ratePerUnit: "1",
				tiers: [
					{ upToQuantity: "10", ratePerUnit: "2" },
					{ upToQuantity: null, ratePerUnit: "1.25" },
				],
				meterScale: 1,
				walletScale: 2,
			}),
		).toBe("23.13");
	});

	it("keeps flat rate-card conversion exact", () => {
		expect(
			calculateRateCardQuantity({
				quantity: "3.25",
				pricingModel: "flat",
				ratePerUnit: "1.2",
				meterScale: 2,
				walletScale: 2,
			}),
		).toBe("3.9");
	});

	it("classifies tier and quantity changes deterministically", () => {
		expect(
			classifySubscriptionChange({
				fromPlanVersionId: "1",
				toPlanVersionId: "2",
				fromTierRank: 10,
				toTierRank: 20,
				quantitiesChanged: false,
			}),
		).toBe("upgrade");
		expect(defaultChangeTiming("downgrade")).toBe("period_end");
		expect(defaultChangeTiming("upgrade")).toBe("immediate");
		expect(defaultChangeTiming("quantity")).toBe("immediate");
		expect(
			classifySubscriptionChange({
				fromPlanVersionId: "2",
				toPlanVersionId: "1",
				fromTierRank: 20,
				toTierRank: 10,
				quantitiesChanged: false,
			}),
		).toBe("downgrade");
		expect(
			stripeProrationForChange({
				kind: "upgrade",
				upgrade: "always_invoice",
				downgrade: "none",
			}),
		).toBe("always_invoice");
		expect(
			stripeProrationForChange({
				kind: "downgrade",
				upgrade: "always_invoice",
				downgrade: "none",
			}),
		).toBe("none");
	});
});
