import { describe, expect, it } from "bun:test";
import { normalizeVerifiedStoreKitTransaction } from "../../../src/providers/apple/normalizer";
import { normalizeGoogleSubscriptionPurchase } from "../../../src/providers/google/normalizer";
import {
	normalizeStripeCheckoutSession,
	normalizeStripeRefund,
	normalizeStripeSubscription,
} from "../../../src/providers/stripe/normalizer";
import {
	createFakeAppleStoreKitClient,
	createFakeGooglePlayClient,
	createFakeStripeBillingClient,
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeRefundObject,
	stripeSubscriptionObject,
} from "./fake-provider-clients";

describe("fake provider clients", () => {
	it("lets Apple tests set the app account token after DB token creation", async () => {
		const fake = createFakeAppleStoreKitClient({
			transactionId: "txn_1",
			originalTransactionId: "orig_1",
		});

		fake.setAppAccountToken("11111111-1111-1111-1111-111111111111");
		const verified = await fake.client.verifyTransaction("txn_1");

		expect(verified.transaction.appAccountToken).toBe("11111111-1111-1111-1111-111111111111");
		expect(fake.calls).toEqual(["verifyTransaction:txn_1"]);
	});

	it("returns deterministic Apple defaults for token and web order line item", async () => {
		const fake = createFakeAppleStoreKitClient({
			transactionId: "txn_1",
			originalTransactionId: "orig_1",
		});

		const verified = await fake.client.verifyTransaction("txn_1");

		expect(verified.transaction.appAccountToken).toBe("00000000-0000-0000-0000-000000000000");
		expect(verified.renewalInfo.appAccountToken).toBe("00000000-0000-0000-0000-000000000000");
		expect(verified.transaction.webOrderLineItemId).toBe("orig_1_line");
	});

	it("normalizes Apple subscription payloads as active with deterministic far-future expiry", async () => {
		const fake = createFakeAppleStoreKitClient({
			transactionId: "txn_1",
			originalTransactionId: "orig_1",
		});

		const verified = await fake.client.verifyTransaction("txn_1");
		const normalized = normalizeVerifiedStoreKitTransaction({
			billingAccountId: "integration_user",
			expectedBundleId: "com.voysee.app",
			expectedEnvironment: "sandbox",
			renewalInfo: verified.renewalInfo,
			transaction: verified.transaction,
		});

		expect(normalized.subscriptionStatus).toBe("active");
		expect(normalized.expiresAt?.toISOString()).toBe("2099-06-30T00:00:00.000Z");
		expect(normalized.externalProductId).toBe("premium_monthly");
		expect(normalized.appAccountToken).toBe("00000000-0000-0000-0000-000000000000");
	});

	it("records Google consume calls after product verification", async () => {
		const fake = createFakeGooglePlayClient({ obfuscatedAccountId: "account_1" });

		await fake.client.getProductPurchase("token_1");
		await fake.client.consumeProductPurchase("echo_credits_10", "token_1");

		expect(fake.calls).toEqual([
			"getProductPurchase:token_1",
			"consumeProductPurchase:echo_credits_10:token_1",
		]);
	});

	it("uses the local Google subscription base plan by default", async () => {
		const fake = createFakeGooglePlayClient({ obfuscatedAccountId: "account_1" });

		const purchase = await fake.client.getSubscriptionPurchase("sub_token_1");

		expect(purchase.lineItems[0].offerDetails.basePlanId).toBe("monthly-base");
	});

	it("normalizes Google subscription payloads as active with local catalog IDs", async () => {
		const fake = createFakeGooglePlayClient({ obfuscatedAccountId: "account_1" });

		const purchase = await fake.client.getSubscriptionPurchase("sub_token_1");
		const normalized = normalizeGoogleSubscriptionPurchase({
			billingAccountId: "integration_user",
			purchase,
			purchaseToken: "sub_token_1",
		});

		expect(normalized?.subscriptionStatus).toBe("active");
		expect(normalized?.expiresAt?.toISOString()).toBe("2099-06-30T00:00:00.000Z");
		expect(normalized?.externalProductId).toBe("premium_monthly");
		expect(normalized?.externalPriceId).toBe("monthly-base");
	});

	it("returns configured Stripe events", async () => {
		const event = stripeEvent("refund.created", stripeRefundObject());
		const fake = createFakeStripeBillingClient({ event });

		expect(fake.client.constructWebhookEvent("{}", "sig")).toEqual(event);
		await expect(fake.client.retrieveSubscription("sub_1")).resolves.toEqual(
			stripeSubscriptionObject(),
		);
	});

	it("can simulate Stripe signature verification failures", () => {
		const fake = createFakeStripeBillingClient({
			constructWebhookError: new Error("invalid signature"),
		});

		expect(() => fake.client.constructWebhookEvent("{}", "bad-signature")).toThrow(
			"invalid signature",
		);
		expect(fake.calls).toEqual(["constructWebhookEvent:{}:bad-signature"]);
	});

	it("creates stable Stripe customer ids per billing account", async () => {
		const fake = createFakeStripeBillingClient();

		await expect(
			fake.client.createCustomer({ billingAccountId: "integration_user", email: null }),
		).resolves.toEqual({ id: "cus_integration" });
		await expect(
			fake.client.createCustomer({
				billingAccountId: "user 2@example.com",
				email: "user2@test.dev",
			}),
		).resolves.toEqual({ id: "cus_user_2_example_com" });
		expect(fake.calls).toEqual([
			"createCustomer:integration_user",
			"createCustomer:user 2@example.com",
		]);
	});

	it("lets tests override fake Stripe customer ids", async () => {
		const fake = createFakeStripeBillingClient({
			createCustomerId: ({ billingAccountId }) => `cus_override_${billingAccountId}`,
		});

		await expect(
			fake.client.createCustomer({ billingAccountId: "user_1", email: null }),
		).resolves.toEqual({ id: "cus_override_user_1" });
	});

	it("uses seeded Stripe subscription catalog IDs by default", () => {
		const subscription = stripeSubscriptionObject();

		expect(subscription.metadata.externalProductId).toBe("prod_stripe_premium");
		expect(subscription.items.data[0].price.product).toBe("prod_stripe_premium");
		expect(subscription.metadata.externalPriceId).toBe("price_premium_monthly");
		expect(subscription.items.data[0].price.id).toBe("price_premium_monthly");
	});

	it("normalizes Stripe subscription payloads as active with local catalog IDs", () => {
		const normalized = normalizeStripeSubscription({
			eventId: "evt_subscription",
			eventType: "customer.subscription.updated",
			subscription: stripeSubscriptionObject(),
		});

		expect(normalized.subscriptionStatus).toBe("active");
		expect(normalized.expiresAt?.toISOString()).toBe("2099-06-30T00:00:00.000Z");
		expect(normalized.externalProductId).toBe("prod_stripe_premium");
		expect(normalized.externalPriceId).toBe("price_premium_monthly");
	});

	it("uses seeded Stripe checkout catalog IDs and required timestamps by default", () => {
		const session = stripeCheckoutSessionObject();
		const refund = stripeRefundObject();

		expect(session.created).toBe(1_779_840_000);
		expect(session.amount_total).toBe(499);
		expect(session.metadata.externalProductId).toBe("prod_stripe_credits_10");
		expect(session.metadata.externalPriceId).toBe("price_credits_10");
		expect(refund.amount).toBe(499);
	});

	it("normalizes Stripe checkout and refund payloads with deterministic fields", () => {
		const session = stripeCheckoutSessionObject();
		const checkout = normalizeStripeCheckoutSession({
			eventId: "evt_checkout",
			session,
		});
		const refund = normalizeStripeRefund({
			eventId: "evt_refund",
			refund: stripeRefundObject(),
		});

		expect(checkout.kind).toBe("credit_purchase");
		if (checkout.kind === "credit_purchase") {
			expect(checkout.externalProductId).toBe("prod_stripe_credits_10");
			expect(checkout.externalPriceId).toBe("price_credits_10");
			expect(checkout.amountPaidCents).toBe(499);
			expect(checkout.currency).toBe("usd");
			expect(checkout.purchasedAt.toISOString()).toBe(
				new Date(session.created * 1000).toISOString(),
			);
		}
		expect(refund.kind).toBe("credit_reversal");
		if (refund.kind === "credit_reversal") {
			expect(refund.reversalReason).toBe("refund");
			expect(refund.paymentIntentId).toBe("pi_integration");
			expect(refund.reversalAmount).toBe(499);
			expect(refund.reversalCurrency).toBe("usd");
		}
	});

	it("captures Stripe Checkout and Portal request params", async () => {
		const fake = createFakeStripeBillingClient();
		const checkoutParams = {
			cancel_url: "https://voysee.test/cancel",
			client_reference_id: "integration_user",
			line_items: [{ price: "price_credits_10", quantity: 1 }],
			mode: "payment" as const,
			success_url: "https://voysee.test/success",
		};
		const portalParams = {
			customer: "cus_integration",
			return_url: "https://voysee.test/account",
		};

		await fake.client.createCheckoutSession(checkoutParams);
		await fake.client.createPortalSession(portalParams);

		expect(fake.calls).toEqual(["createCheckoutSession", "createPortalSession"]);
		expect(fake.checkoutSessionParams).toEqual([checkoutParams]);
		expect(fake.portalSessionParams).toEqual([portalParams]);
	});
});
