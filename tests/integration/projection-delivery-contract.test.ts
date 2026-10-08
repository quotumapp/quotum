import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { testRequest } from "../helpers/openapi";
import {
	deliveryShape,
	publishedDeliveryExamples,
	validateDocumentedDelivery,
} from "../helpers/projection-contract";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createFakeStripeBillingClient,
	stripeCheckoutSessionObject,
	stripeRefundObject,
	stripeSubscriptionInvoiceObject,
	stripeSubscriptionObject,
	stripeSubscriptionPeriod,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { createRecordingProjectionFetch, runProjectionWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

type Delivery = Record<string, unknown>;

/** What a receiver branches on: the same in the example and in the real delivery. */
function facts(delivery: Delivery) {
	const pick = (value: unknown, keys: string[]) =>
		value === undefined
			? undefined
			: Object.fromEntries(keys.map((key) => [key, (value as Delivery)[key]]));
	const snapshot = delivery.entitlements as {
		entitlements: Array<{ active: boolean; metadata: Delivery }>;
	};
	return {
		schemaVersion: delivery.schemaVersion,
		reason: delivery.reason,
		balances: delivery.balances,
		entitlements: snapshot.entitlements.map(({ active, metadata }) => ({
			active,
			source: metadata.source,
			status: metadata.status,
			provider: metadata.provider,
			channel: metadata.channel,
		})),
		subscription: pick(delivery.subscription, [
			"provider",
			"channel",
			"planKey",
			"status",
			"providerStatus",
			"cancelAtPeriodEnd",
			"cancellationReason",
		]),
		trial: pick(delivery.trial, ["event", "source", "provider", "channel", "autoRenew"]),
		purchase: pick(delivery.purchase, [
			"provider",
			"channel",
			"purchaseKind",
			"creditAmount",
			"totalCreditAmount",
			"quantity",
			"refundableQuantity",
		]),
		reversal: pick(delivery.reversal, [
			"provider",
			"channel",
			"reason",
			"creditAmount",
			"totalCreditAmount",
			"quantity",
		]),
	};
}

localDescribe("projection delivery contract", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	/** Runs the projection worker and returns the one delivery it sent. */
	async function deliverQueued(name: string): Promise<Delivery> {
		const projection = createRecordingProjectionFetch();
		await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
		});
		expect([name, projection.requests.length]).toEqual([name, 1]);
		return projection.requests[0].body;
	}

	/** Holds a real delivery to the published schema and to the example of the same name. */
	function expectPublished(example: string, delivery: Delivery): Delivery {
		const published = publishedDeliveryExamples[example].delivery;
		validateDocumentedDelivery(delivery);
		expect([example, validateDocumentedDelivery.errors ?? []]).toEqual([example, []]);
		expect([example, deliveryShape(delivery)]).toEqual([example, deliveryShape(published)]);
		expect([example, facts(delivery)]).toEqual([example, facts(published)]);
		return delivery;
	}

	/**
	 * `deliver` applies one Stripe event, delivers what it queued, and holds it to the published
	 * example; `apply` does the same for an event that has no example of its own.
	 */
	function stripeFlow(clientOptions: Parameters<typeof createFakeStripeBillingClient>[0] = {}) {
		const service = new StripeBillingService({
			config: {
				projectKey: "acme",
				checkoutSuccessUrl:
					"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.integration.test/billing",
				portalReturnUrl: "https://app.integration.test/account/billing",
			},
			client: createFakeStripeBillingClient(clientOptions).client,
			repository: context.repository.forProject(integrationProjectContext("acme")),
		});
		let created = Math.floor(Date.now() / 1000) - 3600;
		const apply = async (name: string, type: string, object: Delivery): Promise<Delivery> => {
			created += 10;
			await service.handleVerifiedAppEvent({
				id: `evt_${name}`,
				type,
				created,
				data: { object },
			});
			return await deliverQueued(name);
		};
		const deliver = async (example: string, type: string, object: Delivery): Promise<Delivery> =>
			expectPublished(example, await apply(example, type, object));
		return { apply, deliver };
	}

	/** Verifies a store purchase through the route and holds its delivery to the example. */
	async function verifyStorePurchase(
		example: string,
		purchase: Delivery,
		prepare: (fixture: ReturnType<typeof createIntegrationApp>) => Promise<void> = async () => {},
	): Promise<Delivery> {
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		await prepare(fixture);
		const response = await testRequest(fixture.app, "/v1/purchases/verify", {
			method: "POST",
			headers: { ...fixture.authHeaders("acme"), "content-type": "application/json" },
			body: JSON.stringify({ billingAccountId: "integration_user", ...purchase }),
		});
		expect([example, response.status]).toEqual([example, 200]);
		return expectPublished(example, await deliverQueued(example));
	}

	// capability: subscription.sync
	it("publishes what a Stripe subscription delivers from purchase to its end", async () => {
		const { apply, deliver } = stripeFlow({
			invoicePayments: { pi_subscription: "in_subscription" },
		});
		const start = Math.floor(Date.now() / 1000) - 86_400;
		const renewed = start + 30 * 86_400;
		const period = stripeSubscriptionPeriod(start, renewed);
		const nextPeriod = stripeSubscriptionPeriod(renewed, renewed + 30 * 86_400);

		const purchase = await deliver(
			"stripe_subscription_purchase",
			"customer.subscription.created",
			stripeSubscriptionObject(period),
		);
		// The paid invoice is what a later refund of its payment is attributed to.
		await apply(
			"invoice_paid",
			"invoice.paid",
			stripeSubscriptionInvoiceObject({ start, end: renewed }),
		);
		const renewal = await deliver(
			"stripe_subscription_renewal",
			"customer.subscription.updated",
			stripeSubscriptionObject(nextPeriod),
		);
		const refund = await deliver(
			"stripe_subscription_refund",
			"refund.created",
			stripeRefundObject({ id: "re_subscription", payment_intent: "pi_subscription", amount: 999 }),
		);
		await deliver(
			"stripe_subscription_cancel_scheduled",
			"customer.subscription.updated",
			stripeSubscriptionObject({
				cancel_at_period_end: true,
				cancellation_details: { reason: "cancellation_requested" },
				...nextPeriod,
			}),
		);
		const ended = await deliver(
			"stripe_subscription_ended",
			"customer.subscription.deleted",
			stripeSubscriptionObject({
				status: "canceled",
				cancellation_details: { reason: "cancellation_requested" },
				...stripeSubscriptionPeriod(start, Math.floor(Date.now() / 1000) - 60),
			}),
		);

		expect(purchase.idempotencyKey).toBe(
			"stripe:subscription:sub_1:customer.subscription.created:evt_stripe_subscription_purchase:projection",
		);
		expect([purchase.sequence, renewal.sequence, refund.sequence, ended.sequence]).toEqual([
			1, 3, 4, 6,
		]);
		expect(refund.idempotencyKey).toBe("stripe:refund:re_subscription:reversal");
		expect((refund.reversal as Delivery).originalTransactionId).toBe("pi_subscription");
		expect((renewal.subscription as Delivery).expiresAt).toBe(
			new Date((renewed + 30 * 86_400) * 1000).toISOString(),
		);
	});

	// capability: catalog.trial
	it("publishes what a Stripe trial delivers when it starts and before it ends", async () => {
		const { deliver } = stripeFlow();
		const now = Math.floor(Date.now() / 1000);
		const trialing = stripeSubscriptionObject({
			status: "trialing",
			trial_start: now - 86_400,
			trial_end: now + 2 * 86_400,
			...stripeSubscriptionPeriod(now - 86_400, now + 2 * 86_400),
		});

		await deliver("stripe_trial_started", "customer.subscription.created", trialing);
		const ending = await deliver(
			"stripe_trial_ending",
			"customer.subscription.trial_will_end",
			trialing,
		);

		expect((ending.trial as Delivery).trialEndsAt).toBe(
			new Date((now + 2 * 86_400) * 1000).toISOString(),
		);
	});

	// capability: refund.sync
	it("publishes what a one-time Stripe purchase and its refund deliver", async () => {
		const { deliver } = stripeFlow();

		const purchase = await deliver(
			"stripe_one_time_purchase",
			"checkout.session.completed",
			stripeCheckoutSessionObject(),
		);
		const refund = await deliver("stripe_one_time_refund", "refund.created", stripeRefundObject());

		expect(purchase.idempotencyKey).toBe("stripe:payment:pi_integration:projection");
		expect(refund.idempotencyKey).toBe("stripe:refund:re_integration:reversal");
		expect((refund.reversal as Delivery).originalTransactionId).toBe(
			(purchase.purchase as Delivery).transactionId,
		);
	});

	// capability: purchase.verify
	it("publishes what a verified App Store subscription delivers", async () => {
		const delivery = await verifyStorePurchase(
			"apple_subscription_purchase",
			{ provider: "apple", transactionId: "200000000000001" },
			async ({ app, apple, authHeaders }) => {
				const token = await testRequest(
					app,
					"/v1/billing-accounts/integration_user/providers/apple/account-token",
					{ headers: authHeaders("acme") },
				);
				apple.setAppAccountToken((await token.json()).data.appAccountToken);
			},
		);

		expect(delivery.idempotencyKey).toBe("apple:200000000000001:purchase_verified");
	});

	// capability: purchase.verify
	it("publishes what a verified Google Play subscription delivers", async () => {
		const delivery = await verifyStorePurchase("google_subscription_purchase", {
			provider: "google",
			purchaseKind: "subscription",
			purchaseToken: "purchase_token_1",
		});

		expect(delivery.idempotencyKey).toBe("google:purchase_token_1:purchase_verified");
	});

	// capability: purchase.verify
	it("publishes what a verified Google Play consumable delivers", async () => {
		const delivery = await verifyStorePurchase("google_consumable_purchase", {
			provider: "google",
			purchaseKind: "consumable",
			purchaseToken: "purchase_token_1",
			productId: "echo_credits_10",
		});

		expect((delivery.purchase as Delivery).transactionId).toBe("purchase_token_1");
	});

	it("publishes what a usage snapshot delivers", async () => {
		const project = integrationProjectContext();
		await publishAiCreditsCatalog(context.repository);
		await context.sql`
			INSERT INTO metering_settings (project_id, projection_usage_debounce_ms)
			SELECT id, 0 FROM projects WHERE key = 'acme'
			ON CONFLICT (project_id) DO UPDATE SET projection_usage_debounce_ms = 0
		`;
		await context.repository.grantAllocation(project, {
			billingAccountId: "integration_user",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "credit_grant",
			sourceKey: "contract-example",
		});
		await context.repository.consumeUsage(project, {
			billingAccountId: "integration_user",
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "contract-example",
		});

		const delivery = expectPublished("usage_snapshot", await deliverQueued("usage_snapshot"));

		expect(delivery.idempotencyKey).toMatch(/^usage:[0-9a-f-]{36}:1$/);
		expect(delivery.sequence).toBe(1);
	});
});
