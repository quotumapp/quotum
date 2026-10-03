import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCatalogImports } from "../../src/catalog/import-config";
import { syncConfiguredCatalog } from "../../src/catalog/provision";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	stripeEvent,
	stripeSubscriptionItemObject,
	stripeSubscriptionObject,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);

let context: LocalPostgresContext;

/** A file of the quickstart, read the way the guide's shell commands read it. */
function quickstartFile(name: string): string {
	return readFileSync(join(process.cwd(), "examples", "quickstart", name), "utf8");
}

/** The operator headers the guide sends with its catalog calls. */
function operatorHeaders(auth: HeadersInit): HeadersInit {
	return {
		...auth,
		"content-type": "application/json",
		"x-billing-actor": "quickstart@example.com",
		"x-billing-operator-key": context.env.operatorApiKey ?? "",
	};
}

/** Previews and publishes a catalog the way the guide does, failing on either refusal. */
async function publishCatalog(
	app: ReturnType<typeof createIntegrationApp>["app"],
	headers: HeadersInit,
	expectedRevision: number | null,
	catalog: unknown,
) {
	const preview = await testRequest(app, "/v1/admin/catalog/preview", {
		method: "POST",
		headers,
		body: JSON.stringify({ expectedRevision, catalog }),
	});
	const previewBody = await preview.json();
	expect({ status: preview.status, error: previewBody.error }).toEqual({
		status: 200,
		error: undefined,
	});
	const published = await testRequest(app, "/v1/admin/catalog/publish", {
		method: "POST",
		headers,
		body: JSON.stringify({
			expectedRevision,
			previewToken: previewBody.data.previewToken,
			catalog,
		}),
	});
	const publishedBody = await published.json();
	expect({ status: published.status, error: publishedBody.error }).toEqual({
		status: 200,
		error: undefined,
	});
	return { preview: previewBody.data, published: publishedBody.data };
}

localDescribe("quickstart examples", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("publishes the starter catalog and then the plan examples, in canonical spelling", async () => {
		// Step 3: the development import creates every store product both catalogs bind to.
		await syncConfiguredCatalog(
			parseCatalogImports(quickstartFile("catalog-import.json")),
			context.projectContextResolver,
			context.db,
		);
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = operatorHeaders(authHeaders());
		const publish = (expectedRevision: number | null, catalog: unknown) =>
			publishCatalog(app, headers, expectedRevision, catalog);

		// Step 5: the starter catalog.
		const starter = await publish(null, JSON.parse(quickstartFile("catalog.json")));
		expect(starter.published.revision).toBe(1);

		// Step 8: the plan examples, which keep everything the starter catalog published.
		const plans = JSON.parse(quickstartFile("catalog-plans.json"));
		const examples = await publish(1, plans);
		expect(examples.published.revision).toBe(2);
		// Written in the canonical spelling: nothing to deprecate and no advice.
		expect(examples.preview.deprecations).toEqual([]);
		expect(examples.preview.advisories).toEqual([]);
		expect(examples.preview.impact).toMatchObject({
			featuresCreated: 2,
			plansCreated: 4,
			planVersionsCreated: 4,
			featuresRetired: 0,
			plansRetired: 0,
			topupsRetired: 0,
		});
		// One example of each item kind the guide describes, plus a calendar-expiry top-up.
		const kinds = plans.plans.flatMap((plan: { items: Array<{ itemKind: string }> }) =>
			plan.items.map((item) => item.itemKind),
		);
		expect(new Set(kinds)).toEqual(
			new Set(["allocation", "meter_limit", "licensed_quantity", "unlimited_usage"]),
		);

		// The read-back previews unchanged: the examples publish exactly what they say.
		const read = await testRequest(app, "/v1/admin/catalog", { headers: authHeaders() });
		const readData = (await read.json()).data;
		expect(readData).toMatchObject({ revision: 2, intentHash: examples.published.intentHash });
		expect(readData.catalog.defaultPlan).toEqual({
			planKey: "free",
			entitlementKeys: ["free_tier"],
		});
		expect(
			readData.catalog.topups.find((topup: { key: string }) => topup.key === "credits_1000").expiry,
		).toEqual({ mode: "after", interval: "year", intervalCount: 1 });
		const again = await testRequest(app, "/v1/admin/catalog/preview", {
			method: "POST",
			headers,
			body: JSON.stringify({ expectedRevision: 2, catalog: readData.catalog }),
		});
		const againData = (await again.json()).data;
		expect(againData.intentHash).toBe(examples.published.intentHash);
		expect(againData.impact).toMatchObject({ plansCreated: 0, planVersionsCreated: 0 });

		// A new account holds the free default plan once it is created: API calls draw on its monthly
		// AI credits through the rate card.
		const created = await testRequest(app, "/v1/billing-accounts/user_2", {
			method: "PUT",
			headers: authHeaders(),
		});
		expect(created.status).toBe(200);
		const consume = await testRequest(app, "/v1/billing-accounts/user_2/usage/consume", {
			method: "POST",
			headers: {
				...authHeaders(),
				"content-type": "application/json",
				"idempotency-key": "quickstart-free-consume-1",
			},
			body: JSON.stringify({ featureId: "api_calls", value: "3" }),
		});
		expect(consume.status).toBe(200);
		expect((await consume.json()).data).toMatchObject({ allowed: true });
		const balance = await testRequest(app, "/v1/billing-accounts/user_2/balances/ai_credits", {
			headers: authHeaders(),
		});
		expect((await balance.json()).data).toMatchObject({
			granted: "100",
			consumed: "3",
			available: "97",
		});
		// Its daily quota of 10 exports applies too.
		const exports = await testRequest(app, "/v1/billing-accounts/user_2/usage/check", {
			method: "POST",
			headers: { ...authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ featureId: "exports", value: "11" }),
		});
		expect((await exports.json()).data).toMatchObject({
			allowed: false,
			balance: { granted: "10", available: "10", scope: "account" },
		});
	});

	it("pins a seat-only team subscription to its plan version and grants its allowances", async () => {
		await syncConfiguredCatalog(
			parseCatalogImports(quickstartFile("catalog-import.json")),
			context.projectContextResolver,
			context.db,
		);
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = operatorHeaders(authHeaders());
		await publishCatalog(app, headers, null, JSON.parse(quickstartFile("catalog.json")));
		await publishCatalog(app, headers, 1, JSON.parse(quickstartFile("catalog-plans.json")));
		const created = await testRequest(app, "/v1/billing-accounts/user_3", {
			method: "PUT",
			headers: authHeaders(),
		});
		expect(created.status).toBe(200);

		// `team` has no base price: its one Stripe product is the seat price's, so that is the
		// product a subscription to it reports, with the metadata Checkout stamps for the plan.
		const periodStart = Math.floor(Date.now() / 1000) - 86_400;
		const deliverTeamSubscription = async (billingAccountId: string, subscriptionId: string) => {
			const [team] = await context.sql<Array<{ id: string }>>`
				SELECT version.id::text AS id
				FROM plans plan
				JOIN plan_versions version
					ON version.project_id = plan.project_id AND version.id = plan.active_version_id
				WHERE plan.key = 'team'
			`;
			const event = stripeEvent(
				"customer.subscription.updated",
				stripeSubscriptionObject({
					id: subscriptionId,
					customer: `cus_${billingAccountId}`,
					metadata: {
						billingAccountId,
						productKey: "team",
						planKey: "team",
						planVersionId: team?.id ?? "",
						purchaseKind: "subscription",
						billingEnvironment: "web",
						externalProductId: "prod_quickstart_team_seat",
						externalPriceId: "price_quickstart_team_seat",
					},
					items: {
						object: "list",
						data: [
							stripeSubscriptionItemObject({
								id: `si_${subscriptionId}`,
								quantity: 5,
								price: { id: "price_quickstart_team_seat", product: "prod_quickstart_team_seat" },
								current_period_start: periodStart,
								current_period_end: periodStart + 30 * 86_400,
							}),
						],
					},
				}),
			);
			stripe.setWebhookEvent(event);
			const webhook = await testRequest(app, "/v1/projects/acme/webhooks/stripe", {
				method: "POST",
				headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=test" },
				body: JSON.stringify(event),
			});
			expect(webhook.status).toBe(200);
			expect((await webhook.json()).data).toMatchObject({ status: "processed" });
		};
		const pinned = async (subscriptionId: string) => {
			const [row] = await context.sql<
				Array<{ status: string; plan_key: string | null; version: number | null }>
			>`
				SELECT subscription.status, plan.key AS plan_key, version.version
				FROM subscriptions subscription
				LEFT JOIN plan_versions version
					ON version.project_id = subscription.project_id
					AND version.id = subscription.plan_version_id
				LEFT JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
				WHERE subscription.external_subscription_id = ${subscriptionId}
			`;
			return row;
		};
		const credits = async (billingAccountId: string) => {
			const balance = await testRequest(
				app,
				`/v1/billing-accounts/${billingAccountId}/balances/ai_credits`,
				{ headers: authHeaders() },
			);
			const { granted, consumed, available } = (await balance.json()).data;
			return { granted, consumed, available };
		};

		await deliverTeamSubscription("user_3", "sub_quickstart_team");

		// The subscription is pinned to the plan's published version.
		expect(await pinned("sub_quickstart_team")).toEqual({
			status: "active",
			plan_key: "team",
			version: 1,
		});

		// Its seat line is tracked under the plan's seat price, at the quantity Stripe reports.
		expect(
			await context.sql<Array<{ price_key: string; quantity: number; active: boolean }>>`
				SELECT price.key AS price_key, item.quantity, item.active
				FROM subscription_items item
				JOIN price_components price
					ON price.project_id = item.project_id AND price.id = item.price_component_id
				WHERE item.provider_subscription_item_id = 'si_sub_quickstart_team'
			`,
		).toEqual([{ price_key: "team_seat", quantity: 5, active: true }]);

		// So the account holds the plan's 5,000 monthly AI credits and can spend them.
		expect(await credits("user_3")).toEqual({
			granted: "5000",
			consumed: "0",
			available: "5000",
		});
		const check = await testRequest(app, "/v1/billing-accounts/user_3/usage/check", {
			method: "POST",
			headers: { ...authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ featureId: "api_calls", value: "3" }),
		});
		expect((await check.json()).data).toMatchObject({ allowed: true });
		// Its daily quota of 5,000 exports replaces the free plan's 10.
		const exports = await testRequest(app, "/v1/billing-accounts/user_3/usage/check", {
			method: "POST",
			headers: { ...authHeaders(), "content-type": "application/json" },
			body: JSON.stringify({ featureId: "exports", value: "11" }),
		});
		expect((await exports.json()).data).toMatchObject({
			allowed: true,
			balance: { granted: "5000", scope: "account" },
		});

		// A new version of the plan keeps the seat price and takes over its product. The subscriber
		// stays on the version they bought through an ordinary renewal event; a new one gets the new
		// version's allowance.
		const nextPlans = JSON.parse(quickstartFile("catalog-plans.json"));
		const nextTeam = nextPlans.plans.find((plan: { key: string }) => plan.key === "team");
		nextTeam.version = 2;
		nextTeam.items.find(
			(item: { featureKey: string }) => item.featureKey === "ai_credits",
		).quantity = "6000";
		const next = await publishCatalog(app, headers, 2, nextPlans);
		expect(next.preview.impact).toMatchObject({
			planVersionsCreated: 1,
			existingSubscriptionsGrandfathered: 1,
		});
		await deliverTeamSubscription("user_3", "sub_quickstart_team");
		expect(await pinned("sub_quickstart_team")).toMatchObject({ plan_key: "team", version: 1 });
		expect(await credits("user_3")).toMatchObject({ granted: "5000" });

		const second = await testRequest(app, "/v1/billing-accounts/user_4", {
			method: "PUT",
			headers: authHeaders(),
		});
		expect(second.status).toBe(200);
		await deliverTeamSubscription("user_4", "sub_quickstart_team_next");
		expect(await pinned("sub_quickstart_team_next")).toEqual({
			status: "active",
			plan_key: "team",
			version: 2,
		});
		expect(await credits("user_4")).toMatchObject({ granted: "6000" });
	});
});
