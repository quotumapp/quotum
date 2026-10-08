import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { StripeBillingService } from "../../src/providers/stripe/service";
import {
	deliveryShape,
	publishedDeliveryExamples,
	validateDocumentedDelivery,
} from "../helpers/projection-contract";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createFakeStripeBillingClient,
	stripeCheckoutSessionObject,
	stripeRefundObject,
	stripeSubscriptionObject,
	stripeSubscriptionPeriod,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
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

	/** Applies one Stripe event, delivers what it queued, and holds it to the published example. */
	function stripeFlow() {
		const service = new StripeBillingService({
			config: {
				projectKey: "acme",
				checkoutSuccessUrl:
					"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.integration.test/billing",
				portalReturnUrl: "https://app.integration.test/account/billing",
			},
			client: createFakeStripeBillingClient().client,
			repository: context.repository.forProject(integrationProjectContext("acme")),
		});
		let created = Math.floor(Date.now() / 1000) - 3600;
		return async (example: string, type: string, object: Delivery): Promise<Delivery> => {
			created += 10;
			await service.handleVerifiedAppEvent({
				id: `evt_${example}`,
				type,
				created,
				data: { object },
			});
			const projection = createRecordingProjectionFetch();
			await runProjectionWorkerOnce({
				env: context.env,
				repository: context.repository,
				fetch: projection.fetch,
			});
			expect(projection.requests).toHaveLength(1);
			const delivery = projection.requests[0].body;
			const published = publishedDeliveryExamples[example].delivery;

			validateDocumentedDelivery(delivery);
			expect([example, validateDocumentedDelivery.errors ?? []]).toEqual([example, []]);
			expect([example, deliveryShape(delivery)]).toEqual([example, deliveryShape(published)]);
			expect([example, facts(delivery)]).toEqual([example, facts(published)]);
			return delivery;
		};
	}

	// capability: subscription.sync
	it("publishes what a Stripe subscription delivers from purchase to its end", async () => {
		const deliver = stripeFlow();
		const start = Math.floor(Date.now() / 1000) - 86_400;
		const renewed = start + 30 * 86_400;
		const period = stripeSubscriptionPeriod(start, renewed);
		const nextPeriod = stripeSubscriptionPeriod(renewed, renewed + 30 * 86_400);

		const purchase = await deliver(
			"stripe_subscription_purchase",
			"customer.subscription.created",
			stripeSubscriptionObject(period),
		);
		const renewal = await deliver(
			"stripe_subscription_renewal",
			"customer.subscription.updated",
			stripeSubscriptionObject(nextPeriod),
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
		expect([purchase.sequence, renewal.sequence, ended.sequence]).toEqual([1, 2, 4]);
		expect((renewal.subscription as Delivery).expiresAt).toBe(
			new Date((renewed + 30 * 86_400) * 1000).toISOString(),
		);
	});

	// capability: catalog.trial
	it("publishes what a Stripe trial delivers when it starts and before it ends", async () => {
		const deliver = stripeFlow();
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
		const deliver = stripeFlow();

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
});
