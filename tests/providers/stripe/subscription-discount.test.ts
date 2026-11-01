import { describe, expect, it } from "bun:test";
import { StripeBillingService } from "../../../src/providers/stripe/service";

const input = {
	promotionId: "promotion-1",
	externalSubscriptionId: "sub_1",
	idempotencyKey: "billing:referral-reward:reward-1",
	retry: false,
};

function fixture(existing: Array<{ id: string; couponId: string | null }>) {
	const writes: Array<{ id: string; params: unknown; key: string }> = [];
	const service = new StripeBillingService({
		config: {
			checkoutSuccessUrl: "https://app.acme.com/success",
			checkoutCancelUrl: "https://app.acme.com/cancel",
			portalReturnUrl: "https://app.acme.com/account",
		},
		client: {
			retrieveSubscriptionDiscounts: async () => existing,
			updateSubscription: async (id: string, params: unknown, key: string) => {
				writes.push({ id, params, key });
				return { id };
			},
		},
		repository: {
			prepareStripeCoupon: async () => ({
				objectId: "object-1",
				status: "ready",
				externalId: "coupon_reward",
				error: null,
			}),
			claimStripePromotionObject: async () => null,
			markStripePromotionObjectOutcome: async () => {},
		},
	} as never);
	return { service, writes };
}

describe("adding a discount to a live subscription", () => {
	it("sends only the discount, so Stripe makes no proration or invoice", async () => {
		const { service, writes } = fixture([]);

		expect(await service.addSubscriptionDiscount(input)).toBe("added");

		expect(writes).toEqual([
			{
				id: "sub_1",
				params: { discounts: [{ coupon: "coupon_reward" }] },
				key: "billing:referral-reward:reward-1",
			},
		]);
	});

	it("leaves a subscription with any discount alone", async () => {
		const { service, writes } = fixture([{ id: "di_1", couponId: "coupon_merchant" }]);

		expect(await service.addSubscriptionDiscount(input)).toBe("already_discounted");
		expect(writes).toEqual([]);
	});

	it("does not take a sibling reward's coupon for its own", async () => {
		const { service, writes } = fixture([{ id: "di_1", couponId: "coupon_reward" }]);

		expect(await service.addSubscriptionDiscount(input)).toBe("already_discounted");
		expect(writes).toEqual([]);
	});

	it("recognizes its own coupon on a retry, without another write", async () => {
		const { service, writes } = fixture([{ id: "di_1", couponId: "coupon_reward" }]);

		expect(await service.addSubscriptionDiscount({ ...input, retry: true })).toBe("added");
		expect(writes).toEqual([]);
	});

	it("does not take another coupon for its own on a retry", async () => {
		const { service, writes } = fixture([{ id: "di_1", couponId: "coupon_merchant" }]);

		expect(await service.addSubscriptionDiscount({ ...input, retry: true })).toBe(
			"already_discounted",
		);
		expect(writes).toEqual([]);
	});
});
