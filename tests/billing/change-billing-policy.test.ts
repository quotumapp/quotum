import { describe, expect, it } from "bun:test";
import {
	changeBillingPolicyFromStripe,
	type StripeProrationBehavior,
	stripeProrationBehaviors,
	stripeProrationFor,
} from "../../src/billing/pricing";
import { changeBillingPolicies } from "../../src/shared/provider-capabilities";

describe("change billing policy", () => {
	it("maps each Stripe proration behavior to one billing and collection pair", () => {
		expect(stripeProrationBehaviors.map(changeBillingPolicyFromStripe)).toEqual([
			{ billing: "prorated", collection: "immediate" },
			{ billing: "prorated", collection: "next_renewal" },
			{ billing: "none", collection: "next_renewal" },
		]);
	});

	it("round-trips every Stripe proration behavior", () => {
		for (const behavior of stripeProrationBehaviors) {
			expect(stripeProrationFor(changeBillingPolicyFromStripe(behavior))).toBe(behavior);
		}
	});

	it("returns null for the policies Stripe cannot express", () => {
		const unexpressed = changeBillingPolicies.filter(
			(policy) => stripeProrationFor(policy) === null,
		);

		expect(unexpressed).toEqual([
			{ billing: "full", collection: "immediate" },
			{ billing: "full", collection: "next_renewal" },
			{ billing: "none", collection: "immediate" },
		]);
	});

	it("returns a fresh policy the caller cannot use to change the mapping", () => {
		const policy = changeBillingPolicyFromStripe("always_invoice");
		policy.billing = "full";

		expect(changeBillingPolicyFromStripe("always_invoice")).toEqual({
			billing: "prorated",
			collection: "immediate",
		});
	});

	it("rejects an unknown Stripe proration behavior", () => {
		expect(() => changeBillingPolicyFromStripe("prorate_later" as StripeProrationBehavior)).toThrow(
			"Unknown Stripe proration behavior: prorate_later",
		);
		expect(() => changeBillingPolicyFromStripe("toString" as StripeProrationBehavior)).toThrow(
			"Unknown Stripe proration behavior: toString",
		);
	});
});
