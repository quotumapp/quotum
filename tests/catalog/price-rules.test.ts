import { describe, expect, it } from "bun:test";
import { planVersionCurrency } from "../../src/catalog/price-rules";

describe("plan version currency", () => {
	it("records a currency only with a base amount", () => {
		expect(planVersionCurrency({ currency: "USD", baseAmountMinor: 999 })).toBe("USD");
		// A plan priced only by its items names their currency but has no base price.
		expect(planVersionCurrency({ currency: "USD", baseAmountMinor: null })).toBeNull();
		expect(planVersionCurrency({ currency: null, baseAmountMinor: null })).toBeNull();
	});
});
