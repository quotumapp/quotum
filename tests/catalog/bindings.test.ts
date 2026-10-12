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
});
