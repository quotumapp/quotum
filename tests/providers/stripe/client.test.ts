import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import { buildStripeConfig, StripeBillingClient } from "../../../src/providers/stripe/client";

const stripeEnv = {
	secretKey: "sk_test_123",
	webhookSecret: "whsec_123",
	checkoutSuccessUrl: "https://app.voysee.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://app.voysee.com/billing",
	portalReturnUrl: "https://app.voysee.com/account/billing",
};

function stripeFixture(options: { asyncWebhook?: boolean } = {}) {
	const calls: unknown[] = [];
	const requestOptions: Array<{ method: string; options?: Stripe.RequestOptions }> = [];
	const event = { id: "evt_123", object: "event" } as Stripe.Event;
	const asyncEvent = { id: "evt_async", object: "event" } as Stripe.Event;
	const stripe = {
		customers: {
			create(params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions) {
				calls.push({ method: "customers.create", params });
				requestOptions.push({ method: "customers.create", options });
				return Promise.resolve({ id: "cus_123" } as Stripe.Customer);
			},
		},
		checkout: {
			sessions: {
				create(params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) {
					calls.push({ method: "checkout.sessions.create", params });
					requestOptions.push({ method: "checkout.sessions.create", options });
					return Promise.resolve({ id: "cs_123" } as Stripe.Checkout.Session);
				},
				retrieve(sessionId: string, params: Stripe.Checkout.SessionRetrieveParams) {
					calls.push({ method: "checkout.sessions.retrieve", sessionId, params });
					return Promise.resolve({ id: sessionId } as Stripe.Checkout.Session);
				},
			},
		},
		billingPortal: {
			sessions: {
				create(params: Stripe.BillingPortal.SessionCreateParams, options?: Stripe.RequestOptions) {
					calls.push({ method: "billingPortal.sessions.create", params });
					requestOptions.push({ method: "billingPortal.sessions.create", options });
					return Promise.resolve({ id: "bps_123" } as Stripe.BillingPortal.Session);
				},
			},
		},
		subscriptions: {
			retrieve(subscriptionId: string, params: Stripe.SubscriptionRetrieveParams) {
				calls.push({ method: "subscriptions.retrieve", subscriptionId, params });
				return Promise.resolve({ id: subscriptionId } as Stripe.Subscription);
			},
		},
		webhooks: {
			constructEvent(rawBody: string, signature: string, secret: string) {
				calls.push({ method: "webhooks.constructEvent", rawBody, signature, secret });
				return event;
			},
			...(options.asyncWebhook === true
				? {
						async constructEventAsync(rawBody: string, signature: string, secret: string) {
							calls.push({ method: "webhooks.constructEventAsync", rawBody, signature, secret });
							return asyncEvent;
						},
					}
				: {}),
		},
	};

	return {
		asyncEvent,
		calls,
		client: new StripeBillingClient(buildStripeConfig(stripeEnv), stripe),
		event,
		requestOptions,
	};
}

describe("StripeBillingClient", () => {
	it("builds config from Stripe env", () => {
		const config = buildStripeConfig(stripeEnv);

		expect(config.secretKey).toBe("sk_test_123");
		expect(config.webhookSecret).toBe("whsec_123");
		expect(config).toMatchObject({ apiVersion: "2026-07-29.dahlia" });
	});

	it("creates customers with billing account metadata without requiring an email", async () => {
		const { calls, client } = stripeFixture();

		const customer = await client.createCustomer({
			billingAccountId: "user_1",
			email: null,
		});

		expect(customer.id).toBe("cus_123");
		expect(calls).toEqual([
			{
				method: "customers.create",
				params: {
					email: undefined,
					metadata: { billingAccountId: "user_1" },
				},
			},
		]);
	});

	it("passes Checkout Session creation params through to Stripe", async () => {
		const { calls, client } = stripeFixture();
		const params = {
			mode: "payment",
			line_items: [{ price: "price_123", quantity: 1 }],
			success_url: stripeEnv.checkoutSuccessUrl,
			cancel_url: stripeEnv.checkoutCancelUrl,
		} satisfies Stripe.Checkout.SessionCreateParams;

		const session = await client.createCheckoutSession(params);

		expect(session.id).toBe("cs_123");
		expect(calls).toEqual([{ method: "checkout.sessions.create", params }]);
	});

	it("passes Billing Portal Session creation params through to Stripe", async () => {
		const { calls, client } = stripeFixture();
		const params = {
			customer: "cus_123",
			return_url: stripeEnv.portalReturnUrl,
		} satisfies Stripe.BillingPortal.SessionCreateParams;

		const session = await client.createPortalSession(params);

		expect(session.id).toBe("bps_123");
		expect(calls).toEqual([{ method: "billingPortal.sessions.create", params }]);
	});

	it("uses stable customer and unique operation idempotency keys on Stripe create calls", async () => {
		const { client, requestOptions } = stripeFixture();

		await client.createCustomer({ billingAccountId: "user_1", email: "reader@example.com" });
		await client.createCheckoutSession({
			mode: "payment",
			line_items: [{ price: "price_123", quantity: 1 }],
			success_url: stripeEnv.checkoutSuccessUrl,
			cancel_url: stripeEnv.checkoutCancelUrl,
			client_reference_id: "user_1",
		});
		await client.createPortalSession({
			customer: "cus_123",
			return_url: stripeEnv.portalReturnUrl,
		});
		await client.createCheckoutSession({
			mode: "payment",
			line_items: [{ price: "price_123", quantity: 1 }],
			success_url: stripeEnv.checkoutSuccessUrl,
			cancel_url: stripeEnv.checkoutCancelUrl,
			client_reference_id: "user_1",
		});

		expect(requestOptions).toEqual([
			{
				method: "customers.create",
				options: { idempotencyKey: expect.stringMatching(/^quotum-api:customers:create:/) },
			},
			{
				method: "checkout.sessions.create",
				options: {
					idempotencyKey: expect.stringMatching(/^quotum-api:checkout-sessions:create:/),
				},
			},
			{
				method: "billingPortal.sessions.create",
				options: {
					idempotencyKey: expect.stringMatching(/^quotum-api:portal-sessions:create:/),
				},
			},
			{
				method: "checkout.sessions.create",
				options: {
					idempotencyKey: expect.stringMatching(/^quotum-api:checkout-sessions:create:/),
				},
			},
		]);
		expect(requestOptions[1]?.options?.idempotencyKey).not.toBe(
			requestOptions[3]?.options?.idempotencyKey,
		);
	});

	it("retrieves Checkout Sessions with payment and subscription expansions", async () => {
		const { calls, client } = stripeFixture();

		const session = await client.retrieveCheckoutSession("cs_123");

		expect(session.id).toBe("cs_123");
		expect(calls).toEqual([
			{
				method: "checkout.sessions.retrieve",
				sessionId: "cs_123",
				params: { expand: ["payment_intent", "subscription"] },
			},
		]);
	});

	it("retrieves subscriptions with latest invoice expansion", async () => {
		const { calls, client } = stripeFixture();

		const subscription = await client.retrieveSubscription("sub_123");

		expect(subscription.id).toBe("sub_123");
		expect(calls).toEqual([
			{
				method: "subscriptions.retrieve",
				subscriptionId: "sub_123",
				params: { expand: ["latest_invoice"] },
			},
		]);
	});

	it("constructs webhook events with the configured webhook secret", async () => {
		const { calls, client, event } = stripeFixture();

		const result = await client.constructWebhookEvent("raw", "sig");

		expect(result).toBe(event);
		expect(calls).toEqual([
			{
				method: "webhooks.constructEvent",
				rawBody: "raw",
				signature: "sig",
				secret: "whsec_123",
			},
		]);
	});

	it("prefers async webhook event construction when the Stripe client provides it", async () => {
		const { asyncEvent, calls, client } = stripeFixture({ asyncWebhook: true });

		const result = await client.constructWebhookEvent("raw", "sig");

		expect(result).toBe(asyncEvent);
		expect(calls).toEqual([
			{
				method: "webhooks.constructEventAsync",
				rawBody: "raw",
				signature: "sig",
				secret: "whsec_123",
			},
		]);
	});
});
