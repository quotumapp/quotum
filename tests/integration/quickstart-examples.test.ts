import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCatalogImports } from "../../src/catalog/import-config";
import { syncConfiguredCatalog } from "../../src/catalog/provision";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
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
		const headers = {
			...authHeaders(),
			"content-type": "application/json",
			"x-billing-actor": "quickstart@example.com",
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
		};
		const publish = async (expectedRevision: number | null, catalog: unknown) => {
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
		};

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
});
