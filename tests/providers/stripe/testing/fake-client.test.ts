import { describe, expect, it } from "bun:test";
import { buildStripeConfig } from "../../../../src/providers/stripe/client";
import { FakeStripeBillingClient } from "../../../../src/providers/stripe/testing/fake-client";

function fakeClient() {
	return new FakeStripeBillingClient(
		buildStripeConfig({
			secretKey: "sk_test_fake",
			webhookSecret: "whsec_fake",
			checkoutSuccessUrl: "https://app.example.com/success",
			checkoutCancelUrl: "https://app.example.com/cancel",
			portalReturnUrl: "https://app.example.com/account",
		}),
	);
}

describe("fake Stripe subscription creation", () => {
	it("starts a trial or an active subscription with the requested items", async () => {
		const client = fakeClient();

		const trial = await client.createSubscription(
			{
				customer: "cus_1",
				items: [{ price: "price_seat", quantity: 5 }, { price: "price_base" }],
				trial_period_days: 14,
				metadata: { externalProductId: "prod_pro", quotumPaymentSetupId: "setup_1" },
			},
			"key_trial",
		);
		const active = await client.createSubscription(
			{ customer: "cus_2", items: [{ price: "price_base" }] },
			"key_active",
		);

		expect(trial).toMatchObject({
			customer: "cus_1",
			status: "trialing",
			metadata: { quotumPaymentSetupId: "setup_1" },
			items: {
				data: [
					{ quantity: 5, price: { id: "price_seat", product: "prod_pro" } },
					{ quantity: 1, price: { id: "price_base", product: "prod_pro" } },
				],
			},
		});
		expect(active).toMatchObject({
			status: "active",
			metadata: {},
			items: { data: [{ quantity: 1, price: { id: "price_base", product: "prod_fake" } }] },
		});
		expect(await client.retrieveSubscription(String(trial.id))).toBe(trial);
		expect(await client.listCustomerSubscriptions("cus_2")).toEqual([active]);
		expect(client.subscriptionCreates.map((create) => create.idempotencyKey)).toEqual([
			"key_trial",
			"key_active",
		]);
	});

	it("replays an idempotency key and keeps a subscription whose response was lost", async () => {
		const client = fakeClient();
		const params = { customer: "cus_1", items: [{ price: "price_base" }] };
		client.loseNextSubscriptionCreate = true;

		await expect(client.createSubscription(params, "key_1")).rejects.toThrow(
			"Fake Stripe subscription create response was lost",
		);
		const [lost] = await client.listCustomerSubscriptions("cus_1");
		expect(lost).toMatchObject({ customer: "cus_1", status: "active" });
		expect(await client.createSubscription(params, "key_1")).toBe(lost as Record<string, unknown>);
		expect(client.subscriptionCreates).toHaveLength(1);
		expect(client.loseNextSubscriptionCreate).toBe(false);
	});

	it("fails the next create or listing on request", async () => {
		const client = fakeClient();
		client.failNext("createSubscription", new Error("create unavailable"));
		client.failNext("listCustomerSubscriptions", new Error("listing unavailable"));

		await expect(
			client.createSubscription({ customer: "cus_1", items: [] }, "key_1"),
		).rejects.toThrow("create unavailable");
		await expect(client.listCustomerSubscriptions("cus_1")).rejects.toThrow("listing unavailable");
		expect(client.subscriptionCreates).toHaveLength(0);
		expect(await client.listCustomerSubscriptions("cus_1")).toEqual([]);
	});
});

describe("fake Stripe invoice payments", () => {
	it("names the invoice a PaymentIntent settled", async () => {
		const client = fakeClient();
		const { id } = await client.createInvoice({ customer: "cus_1" }, "key_invoice");
		const paid = (await client.payInvoice(id, "key_pay")) as {
			payments: { data: Array<{ payment: { payment_intent: string } }> };
		};
		client.attachInvoicePayment("pi_subscription", "in_subscription");

		expect(
			await client.findInvoiceIdForPaymentIntent(paid.payments.data[0].payment.payment_intent),
		).toBe(id);
		expect(await client.findInvoiceIdForPaymentIntent("pi_subscription")).toBe("in_subscription");
		expect(await client.findInvoiceIdForPaymentIntent("pi_one_time")).toBeNull();
		client.failNext("findInvoiceIdForPaymentIntent", new Error("denied"));
		await expect(client.findInvoiceIdForPaymentIntent("pi_subscription")).rejects.toThrow("denied");
	});
});

describe("fake Stripe Checkout sessions", () => {
	it("answers an unknown session id the way stripe-node does", async () => {
		const client = fakeClient();
		for (const lookup of [
			() => client.retrieveCheckoutSession("cs_missing"),
			() => client.retrieveSetupCheckoutSession("cs_missing"),
		]) {
			await expect(lookup()).rejects.toMatchObject({
				type: "StripeInvalidRequestError",
				code: "resource_missing",
				statusCode: 404,
				message: "No such checkout.session: 'cs_missing'",
			});
		}
	});
});
