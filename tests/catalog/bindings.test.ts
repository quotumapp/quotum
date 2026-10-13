import { describe, expect, it } from "bun:test";
import { bindingAdoptionSchema } from "../../src/catalog/bindings";

const base = {
	productKey: "adopted",
	name: "Adopted",
	externalProductId: "prod_adopted",
	externalPriceId: "price_adopted",
};

function issues(input: unknown): Array<{ path: string; message: string }> {
	const result = bindingAdoptionSchema.safeParse(input);
	if (result.success) return [];
	return result.error.issues.map((issue) => ({
		path: issue.path.join("."),
		message: issue.message,
	}));
}

describe("binding adoption input", () => {
	it("still requires an entitlement key and credits for a subscription and a top-up", () => {
		expect(
			issues({ ...base, kind: "subscription", entitlementKey: "premium", credits: 0 }),
		).toEqual([]);
		expect(issues({ ...base, kind: "topup", entitlementKey: "ai", credits: 10 })).toEqual([]);
		for (const kind of ["subscription", "topup"]) {
			expect(issues({ ...base, kind })).toEqual([
				{ path: "entitlementKey", message: "An entitlement key is required" },
				{ path: "credits", message: "Credits are required" },
			]);
		}
	});

	it("still requires positive credits for a top-up", () => {
		expect(issues({ ...base, kind: "topup", entitlementKey: "ai", credits: 0 })).toEqual([
			{ path: "credits", message: "Top-ups require positive credits" },
		]);
	});

	it("takes a gift with neither an entitlement key nor credits", () => {
		expect(issues({ ...base, kind: "gift" })).toEqual([]);
		expect(issues({ ...base, kind: "gift", credits: 0, entitlementKey: "gift" })).toEqual([]);
	});

	it("refuses a gift that carries credits", () => {
		expect(issues({ ...base, kind: "gift", credits: 10 })).toEqual([
			{ path: "credits", message: "A gift carries no credits" },
		]);
	});

	it("refuses an unknown kind and unknown fields", () => {
		expect(issues({ ...base, kind: "coupon" })).not.toEqual([]);
		expect(issues({ ...base, kind: "gift", extra: true })).not.toEqual([]);
	});

	it("reads a file without a provider as Stripe, and accepts it spelled out", () => {
		const stripe = {
			...base,
			kind: "subscription" as const,
			entitlementKey: "premium",
			credits: 1,
		};
		expect(bindingAdoptionSchema.parse(stripe)).toEqual(stripe);
		expect(bindingAdoptionSchema.parse({ ...stripe, provider: "stripe" })).toMatchObject({
			provider: "stripe",
		});
		// Stripe's id formats still apply to Stripe files.
		expect(issues({ ...stripe, externalProductId: "com.acme.premium" })).not.toEqual([]);
	});
});

const appleSubscription = {
	provider: "apple",
	productKey: "premium_ios",
	name: "Premium on iOS",
	kind: "subscription",
	entitlementKey: "premium",
	credits: 100,
	externalProductId: "com.acme.premium.monthly",
	billingPeriod: "month",
};

describe("native store adoption input", () => {
	it("takes an Apple or Google Play subscription with its billing period", () => {
		expect(issues(appleSubscription)).toEqual([]);
		expect(
			issues({
				...appleSubscription,
				provider: "google",
				externalProductId: "premium_monthly",
				externalPriceId: "monthly-base",
				billingPeriodCount: 3,
				currency: "usd",
				priceAmountMinor: 999,
			}),
		).toEqual([]);
	});

	it("needs a billing period for a subscription and refuses one on a top-up", () => {
		const { billingPeriod: _period, ...withoutPeriod } = appleSubscription;
		expect(issues(withoutPeriod)).toEqual([
			{ path: "billingPeriod", message: "A subscription needs the billing period it renews on" },
		]);
		expect(issues({ ...appleSubscription, kind: "topup", billingPeriod: "month" })).toEqual([
			{
				path: "billingPeriod",
				message: "A top-up is a one-time purchase and has no billing period",
			},
		]);
		const { billingPeriod: _unused, ...topup } = appleSubscription;
		expect(issues({ ...topup, kind: "topup", credits: 50 })).toEqual([]);
		expect(issues({ ...topup, kind: "topup", credits: 0 })).toEqual([
			{ path: "credits", message: "Top-ups require positive credits" },
		]);
	});

	it("takes currency and price together or not at all", () => {
		expect(issues({ ...appleSubscription, currency: "usd" })).toEqual([
			{
				path: "priceAmountMinor",
				message: "currency and priceAmountMinor are given together or not at all",
			},
		]);
		expect(issues({ ...appleSubscription, priceAmountMinor: 999 })).toEqual([
			{
				path: "currency",
				message: "currency and priceAmountMinor are given together or not at all",
			},
		]);
	});

	it("leaves a gift and a base plan to the stores that support them", () => {
		expect(issues({ ...appleSubscription, kind: "gift" })).not.toEqual([]);
		// Apple has no base plan; only a Google subscription names one.
		expect(issues({ ...appleSubscription, externalPriceId: "monthly-base" })).not.toEqual([]);
		expect(issues({ ...appleSubscription, extra: true })).not.toEqual([]);
		expect(issues({ ...appleSubscription, billingPeriod: "hour" })).not.toEqual([]);
		expect(issues({ ...appleSubscription, provider: "paddle" })).not.toEqual([]);
	});
});
