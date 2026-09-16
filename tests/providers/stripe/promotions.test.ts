import { describe, expect, it } from "bun:test";
import type { PromotionStripeSyncJob } from "../../../src/billing/promotions";
import {
	stripeCouponId,
	syncPromotionStripeObject,
} from "../../../src/providers/stripe/promotions";
import { StripeBillingService } from "../../../src/providers/stripe/service";
import { createFakeStripePromotions } from "../../../src/providers/stripe/testing/fake-promotions";

const objectId = "0f0e0d0c-0b0a-4908-8706-050403020100";

function couponJob(
	overrides: Partial<Extract<PromotionStripeSyncJob, { objectKind: "coupon" }>> = {},
): Extract<PromotionStripeSyncJob, { objectKind: "coupon" }> {
	return {
		projectId: "project-1",
		projectKey: "voysee",
		objectId,
		promotionKey: "spring-sale",
		promotionName: "Spring sale for returning customers who upgrade",
		status: "pending",
		externalId: null,
		desiredActive: true,
		desiredGeneration: 0,
		providerActive: null,
		retireRequested: false,
		attempts: 1,
		objectKind: "coupon",
		discount: {
			type: "amount",
			amounts: [
				{ currency: "EUR", amountOffMinor: 450 },
				{ currency: "USD", amountOffMinor: 500 },
			],
			duration: "repeating",
			durationMonths: 3,
		},
		appliesToProducts: ["prod_pro"],
		...overrides,
	};
}

function codeJob(
	overrides: Partial<Extract<PromotionStripeSyncJob, { objectKind: "promotion_code" }>> = {},
): Extract<PromotionStripeSyncJob, { objectKind: "promotion_code" }> {
	return {
		projectId: "project-1",
		projectKey: "voysee",
		objectId: "11111111-2222-4333-8444-555555555555",
		promotionKey: "spring-sale",
		promotionName: "Spring sale",
		status: "pending",
		externalId: null,
		desiredActive: true,
		desiredGeneration: 0,
		providerActive: null,
		retireRequested: false,
		attempts: 1,
		objectKind: "promotion_code",
		code: "SPRING",
		couponExternalId: stripeCouponId(objectId),
		expiresAt: "2099-01-01T00:00:00.000Z",
		maxRedemptions: 50,
		firstPurchaseOnly: true,
		...overrides,
	};
}

describe("Stripe promotion provisioning", () => {
	it("creates a coupon with a Quotum id, multi-currency amounts and product scope", async () => {
		const stripe = createFakeStripePromotions();

		const outcome = await syncPromotionStripeObject(stripe, couponJob());

		expect(outcome).toEqual({
			kind: "ready",
			externalId: "quotum_0f0e0d0c0b0a49088706050403020100",
			providerActive: true,
		});
		expect(stripe.state.coupons.get(stripeCouponId(objectId))?.params).toEqual({
			id: "quotum_0f0e0d0c0b0a49088706050403020100",
			name: "Spring sale for returning customers who",
			duration: "repeating",
			duration_in_months: 3,
			applies_to: { products: ["prod_pro"] },
			metadata: {
				quotumProjectKey: "voysee",
				quotumPromotionKey: "spring-sale",
				quotumProviderObjectId: objectId,
			},
			amount_off: 450,
			currency: "eur",
			currency_options: { usd: { amount_off: 500 } },
		});
	});

	it("adopts its own existing coupon after the idempotency window and rejects foreign terms", async () => {
		const stripe = createFakeStripePromotions();
		await syncPromotionStripeObject(stripe, couponJob());
		const retry = await syncPromotionStripeObject(stripe, {
			...couponJob(),
			// A later retry gets a fresh idempotency window but the same coupon id.
			projectKey: "voysee-after-rotation",
		});
		const percent = await syncPromotionStripeObject(stripe, {
			...couponJob({ projectKey: "voysee-other-key" }),
			discount: { type: "percent", percentOffBps: 1250, duration: "forever", durationMonths: null },
		});

		expect(retry).toMatchObject({ kind: "ready", externalId: stripeCouponId(objectId) });
		expect(percent).toEqual({
			kind: "failed",
			error: `Stripe coupon ${stripeCouponId(objectId)} already exists with different terms`,
			terminal: true,
		});
	});

	it("creates, toggles and retires a hosted promotion code", async () => {
		const stripe = createFakeStripePromotions();
		await syncPromotionStripeObject(stripe, couponJob());

		const created = await syncPromotionStripeObject(stripe, codeJob());
		if (created.kind !== "ready") throw new Error("expected a ready code");
		const deactivated = await syncPromotionStripeObject(
			stripe,
			codeJob({
				status: "ready",
				externalId: created.externalId,
				providerActive: true,
				desiredActive: false,
				desiredGeneration: 1,
			}),
		);
		const retired = await syncPromotionStripeObject(
			stripe,
			codeJob({
				status: "ready",
				externalId: created.externalId,
				providerActive: false,
				retireRequested: true,
			}),
		);

		expect(stripe.state.promotionCodes.get(created.externalId)?.params).toMatchObject({
			promotion: { type: "coupon", coupon: stripeCouponId(objectId) },
			code: "SPRING",
			active: true,
			expires_at: 4070908800,
			max_redemptions: 50,
			restrictions: { first_time_transaction: true },
		});
		expect(deactivated).toEqual({
			kind: "ready",
			externalId: created.externalId,
			providerActive: false,
		});
		expect(retired).toEqual({ kind: "retired", externalId: created.externalId });
		expect(stripe.state.promotionCodes.get(created.externalId)?.active).toBe(false);
	});

	it("skips expired codes, adopts a code it already created, and classifies failures", async () => {
		const stripe = createFakeStripePromotions();
		await syncPromotionStripeObject(stripe, couponJob());
		const first = await syncPromotionStripeObject(stripe, codeJob());

		const expired = await syncPromotionStripeObject(
			stripe,
			codeJob({ expiresAt: "2020-01-01T00:00:00.000Z" }),
		);
		const adopted = await syncPromotionStripeObject(stripe, {
			...codeJob(),
			projectKey: "voysee-retry",
		});
		const missingCoupon = await syncPromotionStripeObject(
			stripe,
			codeJob({ objectId: "99999999-2222-4333-8444-555555555555", couponExternalId: "co_missing" }),
		);
		const rateLimited = await syncPromotionStripeObject(
			{
				...stripe,
				async createCoupon() {
					throw Object.assign(new Error("Too many requests"), {
						type: "StripeRateLimitError",
						code: "rate_limit",
					});
				},
			},
			couponJob({ objectId: "88888888-2222-4333-8444-555555555555" }),
		);

		expect(expired).toEqual({ kind: "retired", externalId: null });
		expect(adopted).toEqual(first);
		expect(missingCoupon).toMatchObject({ kind: "failed", terminal: true });
		expect(rateLimited).toEqual({ kind: "failed", error: "Too many requests", terminal: false });
	});

	it("syncs through the billing service only when the client supports promotions", async () => {
		const withPromotions = new StripeBillingService({
			config: {} as never,
			client: createFakeStripePromotions() as never,
			repository: {} as never,
		});
		const withoutPromotions = new StripeBillingService({
			config: {} as never,
			client: {} as never,
			repository: {} as never,
		});

		expect(await withPromotions.syncPromotionStripeObject(couponJob())).toMatchObject({
			kind: "ready",
			externalId: stripeCouponId(objectId),
		});
		expect(await withoutPromotions.syncPromotionStripeObject(couponJob())).toEqual({
			kind: "failed",
			error: "Stripe promotions are unavailable",
			terminal: true,
		});
	});
});
