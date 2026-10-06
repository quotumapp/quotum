import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

// biome-ignore lint/suspicious/noExplicitAny: catalog bodies and responses are asserted field by field
type Json = Record<string, any>;

const feature = (key: string) => ({
	key,
	name: key,
	kind: "metered",
	meterKind: "consumable",
	unit: "credit",
	creditScale: 3,
	filterDimensions: [] as string[],
});

/** A priced plan that allocates `ai_credits`, sold through the seeded Stripe product. */
const sold: Json = {
	features: [feature("ai_credits")],
	plans: [
		{
			key: "premium",
			name: "Premium",
			version: 1,
			kind: "base",
			basePrice: {
				key: "premium_monthly",
				currency: "USD",
				unitAmountMinor: 999,
				billingUnits: "1",
				billingInterval: "month",
				minimumQuantity: 1,
				maximumQuantity: 1,
				taxBehavior: "exclusive",
				providerBindings: [{ productKey: "premium_monthly", provider: "stripe", channel: "web" }],
			},
			providerPriced: null,
			items: [
				{
					itemKind: "allocation",
					featureKey: "ai_credits",
					quantity: "1000",
					reset: { interval: "month", intervalCount: 1 },
				},
			],
		},
	],
	topups: [],
	rateCards: [],
};

/** The same project with the plan and its feature retired. */
const retired: Json = {
	features: [feature("other_credits")],
	plans: [],
	topups: [],
	rateCards: [],
	retiredFeatureKeys: ["ai_credits"],
	retiredPlanKeys: ["premium"],
};

localDescribe("retiring a feature", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	function operator() {
		const { app, authHeaders } = createIntegrationApp({
			env: { ...context.env, rateLimit: { ...context.env.rateLimit, adminLimit: 1_000_000 } },
			repository: context.repository,
		});
		const headers = {
			...(authHeaders() as Record<string, string>),
			"content-type": "application/json",
			"x-billing-actor": "retirement-test",
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
		};
		const call = async (path: string, init: RequestInit = {}) => {
			const response = await testRequest(app, path, { ...init, headers });
			return { status: response.status, body: (await response.json()) as Json };
		};
		const post = (path: string, body: unknown) =>
			call(path, { method: "POST", body: JSON.stringify(body) });
		return {
			call,
			preview: (catalog: Json, expectedRevision: number | null) =>
				post("/v1/admin/catalog/preview", { expectedRevision, catalog }),
			publish: (catalog: Json, previewToken: string, expectedRevision: number | null) =>
				post("/v1/admin/catalog/publish", { expectedRevision, previewToken, catalog }),
		};
	}

	async function subscribe(): Promise<void> {
		const start = new Date();
		const end = new Date(start.getTime() + 30 * 86_400_000);
		await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
			billingAccountId: "subscriber",
			stripeCustomerId: "cus_subscriber",
			stripeSubscriptionId: "sub_subscriber",
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
			externalEventId: "evt_subscriber",
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: "evt_subscriber:projection",
			providerEventCreated: 1,
		});
	}

	it("is refused while a live subscription still holds it, and allowed once it has ended", async () => {
		const { call, preview, publish } = operator();
		const first = await preview(sold, null);
		expect((await publish(sold, first.body.data.previewToken, null)).status).toBe(200);
		await subscribe();
		const balance = () => call("/v1/billing-accounts/subscriber/balances/ai_credits");
		expect((await balance()).body.data).toMatchObject({ available: "1000" });

		// Retiring the plan stops new sales, but its subscriber stays pinned to it and still holds
		// the feature: retiring that too would leave them with a balance they cannot read or spend.
		const blocked = {
			code: "FEATURE_RETIREMENT_BLOCKED",
			message:
				"Feature ai_credits cannot be retired: 1 live subscription still holds it through plan premium version 1; migrate them to a version without it, or retire it after they end",
		};
		const refusedPreview = await preview(retired, 1);
		expect(refusedPreview.status).toBe(409);
		expect(refusedPreview.body.error).toMatchObject(blocked);
		// Publishing checks it again: a subscription may have started since the preview.
		await context.sql`UPDATE subscriptions SET status = 'expired' WHERE project_id = ${project.projectInstanceId}`;
		const allowedPreview = await preview(retired, 1);
		expect(allowedPreview.status).toBe(200);
		await context.sql`UPDATE subscriptions SET status = 'active' WHERE project_id = ${project.projectInstanceId}`;
		const refusedPublish = await publish(retired, allowedPreview.body.data.previewToken, 1);
		expect(refusedPublish.status).toBe(409);
		expect(refusedPublish.body.error).toMatchObject(blocked);
		expect((await balance()).body.data).toMatchObject({ available: "1000" });
		const [state] = await context.sql`
			SELECT (SELECT max(revision)::int FROM catalog_revisions) AS revision,
				(SELECT active FROM features WHERE key = 'ai_credits') AS feature_active`;
		expect(state).toEqual({ revision: 1, feature_active: true });

		// Retiring only the plan is still allowed: the feature stays, and so does the subscriber.
		const planOnly = { ...sold, plans: [], retiredPlanKeys: ["premium"] };
		const planPreview = await preview(planOnly, 1);
		expect(planPreview.status).toBe(200);
		expect((await publish(planOnly, planPreview.body.data.previewToken, 1)).status).toBe(200);
		expect((await balance()).body.data).toMatchObject({ available: "1000" });

		// Once the subscription has ended nobody holds the feature and it can go.
		await context.sql`UPDATE subscriptions SET status = 'expired' WHERE project_id = ${project.projectInstanceId}`;
		const featureOnly = { ...retired, retiredPlanKeys: [] };
		const lastPreview = await preview(featureOnly, 2);
		expect(lastPreview.status).toBe(200);
		expect((await publish(featureOnly, lastPreview.body.data.previewToken, 2)).status).toBe(200);
	});
});
