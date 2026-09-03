import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import { syncConfiguredProjectsAndCatalog } from "../../src/catalog/provision";
import { checkPostgresHealth } from "../../src/db/client";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("local Postgres billing integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("keeps health public", async () => {
		const app = createApp({ env: context.env });
		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("checks current Postgres health for every readiness request", async () => {
		let checks = 0;
		const app = createApp({
			env: context.env,
			readinessCheck: async () => {
				checks += 1;
				return await checkPostgresHealth(context.sql);
			},
		});

		const livez = await app.request("/livez");
		const ready = await app.request("/ready");
		const readyAgain = await app.request("/ready");

		expect(livez.status).toBe(200);
		expect(await livez.json()).toEqual({ status: "ok" });
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ok" });
		expect(readyAgain.status).toBe(200);
		expect(checks).toBe(2);
	});

	it("seeds public projects and catalog rows", async () => {
		const rows = await context.sql<{ key: string; name: string }[]>`
			SELECT key, name
			FROM projects
			ORDER BY key
		`;
		const storeProductCount = await context.sql<{ count: string }[]>`
			SELECT count(*)::text AS count
			FROM store_products
		`;

		expect(rows).toEqual([
			{ key: "voysee", name: "Voysee" },
			{ key: "wiseley", name: "Wiseley" },
		]);
		expect(Number(storeProductCount[0]?.count ?? "0")).toBe(12);
	});

	it("synchronizes a configured project and Stripe catalog idempotently", async () => {
		const configured = {
			projects: [
				{
					key: "thru",
					apiKey: "thru-integration-api-key",
					active: true,
					projectionUrl: "https://thru.projection.integration.test",
					projectionSecret: "thru-projection-secret",
					projectionContract: "billing_state_v1" as const,
					catalog: [
						{
							key: "creator_monthly",
							name: "Creator Monthly",
							kind: "subscription" as const,
							plan: "creator",
							currency: "USD",
							amountCents: 1900,
							credits: 500,
							interval: "month" as const,
							entitlementKey: "paid",
							externalProductId: "prod_thru_creator",
							externalPriceId: "price_thru_creator",
							active: true,
						},
					],
				},
			],
		};

		await syncConfiguredProjectsAndCatalog(configured, context.db);
		await syncConfiguredProjectsAndCatalog(configured, context.db);

		const rows = await context.sql<
			{
				project_key: string;
				product_key: string;
				credit_amount: number;
				external_product_id: string;
				external_price_id: string;
			}[]
		>`
			SELECT projects.key AS project_key, products.key AS product_key,
				products.credit_amount, store_products.external_product_id,
				store_products.external_price_id
			FROM projects
			JOIN products ON products.project_id = projects.id
			JOIN store_products ON store_products.project_id = projects.id
				AND store_products.product_id = products.id
			WHERE projects.key = 'thru'
		`;
		expect(rows).toEqual([
			{
				project_key: "thru",
				product_key: "creator_monthly",
				credit_amount: 500,
				external_product_id: "prod_thru_creator",
				external_price_id: "price_thru_creator",
			},
		]);
	});
});
