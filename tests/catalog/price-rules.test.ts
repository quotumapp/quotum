import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "../../src/billing/errors";
import { assertBaseAmountHasCurrency, planVersionCurrency } from "../../src/catalog/price-rules";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";

function plan(overrides: Partial<CatalogPlanIntent>): CatalogPlanIntent {
	return {
		key: "team",
		name: "Team",
		version: 1,
		currency: null,
		baseAmountMinor: null,
		billingInterval: "month",
		trialDays: null,
		kind: "base",
		basePrice: null,
		items: [],
		providerBindings: [],
		...overrides,
	};
}

function catalog(plans: CatalogPlanIntent[]): CatalogIntent {
	return { features: [], plans, topups: [], rateCards: [] };
}

describe("plan version currency", () => {
	it("records a currency only with a base amount", () => {
		expect(planVersionCurrency({ currency: "USD", baseAmountMinor: 999 })).toBe("USD");
		// A plan priced only by its items names their currency but has no base price.
		expect(planVersionCurrency({ currency: "USD", baseAmountMinor: null })).toBeNull();
		expect(planVersionCurrency({ currency: null, baseAmountMinor: null })).toBeNull();
	});

	it("refuses a base amount without a currency", () => {
		expect(() =>
			assertBaseAmountHasCurrency(catalog([plan({ currency: "USD", baseAmountMinor: null })])),
		).not.toThrow();
		expect(() =>
			assertBaseAmountHasCurrency(catalog([plan({ currency: "USD", baseAmountMinor: 500 })])),
		).not.toThrow();
		const refused = () =>
			assertBaseAmountHasCurrency(catalog([plan({ currency: null, baseAmountMinor: 500 })]));
		expect(refused).toThrow(InvalidRequestError);
		expect(refused).toThrow("Plan team baseAmountMinor requires a currency");
	});
});
