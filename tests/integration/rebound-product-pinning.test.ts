import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CatalogIntent } from "../../src/catalog/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

/** One plan sold through the seeded `premium_monthly` product on Stripe and the App Store. */
function catalogWith(planKey: string, quantity: string, retiredPlanKeys: string[] = []) {
	const [template] = aiCreditsCatalog.plans;
	if (template === undefined) throw new Error("the fixture catalog has no plan");
	const [allowance] = template.items;
	if (allowance === undefined) throw new Error("the fixture plan has no allowance");
	return {
		...aiCreditsCatalog,
		plans: [{ ...template, key: planKey, name: planKey, items: [{ ...allowance, quantity }] }],
		topups: [],
		retiredPlanKeys,
	} as CatalogIntent;
}

localDescribe("a store product re-bound to another plan", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	async function publish(catalog: CatalogIntent, expectedRevision: number | null) {
		const preview = await context.repository.previewCatalog(project, {
			expectedRevision,
			actor: "integration-test",
			catalog,
		});
		await context.repository.publishCatalog(project, {
			expectedRevision,
			actor: "integration-test",
			previewToken: preview.previewToken,
			catalog,
		});
		return preview;
	}

	/** A Stripe update for the subscription, still on the price it was bought at. */
	async function stripeUpdate(billingAccountId: string, subscriptionId: string, order: number) {
		const start = new Date(Date.UTC(2099, order, 1));
		const end = new Date(Date.UTC(2099, order + 1, 1));
		await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
			billingAccountId,
			stripeCustomerId: `cus_${subscriptionId}`,
			stripeSubscriptionId: subscriptionId,
			invoiceId: null,
			externalProductId: "prod_stripe_premium",
			externalPriceId: "price_premium_monthly",
			subscriptionStatus: "active",
			purchasedAt: start,
			startsAt: start,
			expiresAt: end,
			currentPeriodStart: start,
			currentPeriodEnd: end,
			autoRenew: true,
			rawPayload: {},
			eventType: "customer.subscription.updated",
			externalEventId: `evt_${subscriptionId}_${order}`,
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: `evt_${subscriptionId}_${order}:projection`,
			providerEventCreated: order,
		});
	}

	/** An App Store transaction of the subscription: its purchase, then each renewal. */
	async function appleTransaction(billingAccountId: string, order: number) {
		await context.repository.recordStoreKitTransactionAndEnqueueProjection(project, {
			billingAccountId,
			appAccountToken: null,
			channel: "ios",
			externalProductId: "premium_monthly",
			purchaseKind: "subscription",
			transactionId: `20000000000000${order}`,
			originalTransactionId: "100000000000001",
			webOrderLineItemId: `20000000000000${order}_line`,
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			purchasedAt: new Date(Date.UTC(2099, order, 1)),
			expiresAt: new Date(Date.UTC(2099, order + 1, 1)),
			autoRenew: true,
			invalidatedAt: null,
			invalidationReason: null,
			rawPayload: { transactionId: `20000000000000${order}` },
			eventType: order === 0 ? "SUBSCRIBED" : "DID_RENEW",
			externalEventId: `apple_event_${order}`,
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: `apple:${order}`,
		});
	}

	async function pinnedPlans() {
		const rows = await context.sql<Array<{ account: string; plan: string }>>`
			SELECT customer.billing_account_id AS account, plan.key AS plan
			FROM subscriptions subscription
			JOIN customers customer ON customer.id = subscription.customer_id
			JOIN plan_versions version ON version.id = subscription.plan_version_id
			JOIN plans plan ON plan.id = version.plan_id
			ORDER BY customer.billing_account_id`;
		return Object.fromEntries(rows.map((row) => [row.account, row.plan]));
	}

	const allowances = async (billingAccountId: string) =>
		[
			...new Set(
				(
					await context.repository.getMeteringBalance(project, billingAccountId, "ai_credits")
				).breakdown.map((allocation) => allocation.quantity),
			),
		].sort();

	it("keeps existing subscribers on their plan and gives the product to new ones", async () => {
		await publish(catalogWith("alpha", "1000"), null);
		await stripeUpdate("stripe-subscriber", "sub_alpha", 0);
		await appleTransaction("apple-subscriber", 0);
		expect(await pinnedPlans()).toEqual({
			"apple-subscriber": "alpha",
			"stripe-subscriber": "alpha",
		});

		// Alpha is retired and beta takes over its store product on both providers.
		const preview = await publish(catalogWith("beta", "5000", ["alpha"]), 1);
		expect(preview.impact).toMatchObject({
			plansRetired: 1,
			existingSubscriptionsGrandfathered: 2,
		});

		// Each provider reports the next period of the same product: nobody asked to switch.
		await stripeUpdate("stripe-subscriber", "sub_alpha", 1);
		await appleTransaction("apple-subscriber", 1);
		expect(await pinnedPlans()).toEqual({
			"apple-subscriber": "alpha",
			"stripe-subscriber": "alpha",
		});
		expect(await allowances("stripe-subscriber")).toEqual(["1000"]);
		expect(await allowances("apple-subscriber")).toEqual(["1000"]);

		// A customer who buys the product now gets the plan it is bound to.
		await stripeUpdate("new-subscriber", "sub_beta", 2);
		expect((await pinnedPlans())["new-subscriber"]).toBe("beta");
		expect(await allowances("new-subscriber")).toEqual(["5000"]);
	});
});
