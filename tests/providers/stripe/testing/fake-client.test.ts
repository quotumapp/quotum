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
