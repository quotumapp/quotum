import { describe, expect, it } from "bun:test";
import { classifyBillingError } from "../../src/billing/errors";
import {
	planNotPurchasableViaStripe,
	productNotPurchasableViaStripe,
} from "../../src/db/repository/stripe-purchasability";

describe("Stripe purchasability errors", () => {
	it("answers an unpriced plan as a 409 conflict naming the plan", () => {
		expect(classifyBillingError(planNotPurchasableViaStripe("free"))).toMatchObject({
			status: 409,
			code: "PLAN_NOT_PURCHASABLE_VIA_STRIPE",
			message: "Plan free has no Stripe price",
			classification: "persistence_conflict",
		});
	});

	it("answers a product without an amount and currency as a 409 conflict", () => {
		expect(classifyBillingError(productNotPurchasableViaStripe("credits_10"))).toMatchObject({
			status: 409,
			code: "PRODUCT_NOT_PURCHASABLE_VIA_STRIPE",
			message: "Stripe product credits_10 has no price amount and currency",
			classification: "persistence_conflict",
		});
	});
});
