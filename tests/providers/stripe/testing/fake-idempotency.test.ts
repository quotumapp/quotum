import { describe, expect, it } from "bun:test";
import { buildStripeConfig } from "../../../../src/providers/stripe/client";
import { FakeStripeBillingClient } from "../../../../src/providers/stripe/testing/fake-client";
import { createFakeStripeIdempotency } from "../../../../src/providers/stripe/testing/fake-idempotency";
import { createFakeStripePromotions } from "../../../../src/providers/stripe/testing/fake-promotions";

const idempotencyError = {
	type: "StripeIdempotencyError",
	rawType: "idempotency_error",
	statusCode: 400,
	message: expect.stringContaining("Try using a key other than 'key_1'"),
};

describe("fake Stripe idempotency", () => {
	it("repeats a request under its key and refuses any other request under it", () => {
		const idempotency = createFakeStripeIdempotency();
		idempotency.claim("key_1", "POST /v1/invoices", { currency: "usd", customer: "cus_1" });

		// Key order in the parameters does not make a different request.
		expect(() =>
			idempotency.claim("key_1", "POST /v1/invoices", { customer: "cus_1", currency: "usd" }),
		).not.toThrow();
		expect(() =>
			idempotency.claim("key_1", "POST /v1/invoices", { currency: "eur", customer: "cus_1" }),
		).toThrow(expect.objectContaining(idempotencyError));
		expect(() => idempotency.claim("key_1", "POST /v1/invoices/in_1/pay")).toThrow(
			expect.objectContaining(idempotencyError),
		);
		expect(() => idempotency.claim(undefined, "POST /v1/invoices/in_1/pay")).not.toThrow();
	});

	it("rejects a client key reused with different parameters", async () => {
		const client = new FakeStripeBillingClient(
			buildStripeConfig({
				secretKey: "sk_test_fake",
				webhookSecret: "whsec_fake",
				checkoutSuccessUrl: "https://app.example.com/success",
				checkoutCancelUrl: "https://app.example.com/cancel",
				portalReturnUrl: "https://app.example.com/account",
			}),
		);
		const first = await client.createInvoice({ customer: "cus_1", currency: "usd" }, "key_1");

		await expect(
			client.createInvoice({ customer: "cus_1", currency: "usd" }, "key_1"),
		).resolves.toEqual(first);
		await expect(
			client.createInvoice({ customer: "cus_2", currency: "usd" }, "key_1"),
		).rejects.toMatchObject(idempotencyError);
		// Keys belong to the account, not to one endpoint.
		await expect(
			client.createCoupon({ id: "coupon_1", percent_off: 10, duration: "once" }, "key_1"),
		).rejects.toMatchObject(idempotencyError);
	});

	it("rejects a promotion key reused with different parameters", async () => {
		const promotions = createFakeStripePromotions();
		await promotions.createCoupon({ id: "coupon_1", percent_off: 10, duration: "once" }, "key_1");

		await expect(
			promotions.createCoupon({ id: "coupon_1", percent_off: 20, duration: "once" }, "key_1"),
		).rejects.toMatchObject(idempotencyError);
		expect(promotions.state.coupons.get("coupon_1")?.percent_off).toBe(10);
	});
});
