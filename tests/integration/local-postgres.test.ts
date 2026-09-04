import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import { syncConfiguredCatalog } from "../../src/catalog/provision";
import { checkProjectRuntimeConfiguration } from "../../src/composition/project-instance-persistence";
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

	it("requires an exact runtime directory for readiness", async () => {
		const firstRuntime = context.env.projectRuntime[0];
		if (firstRuntime === undefined) throw new Error("Expected a configured project runtime");

		await expect(
			checkProjectRuntimeConfiguration(context.env.projectRuntime, context.sql),
		).resolves.toBe(true);
		await expect(
			checkProjectRuntimeConfiguration(context.env.projectRuntime.slice(0, 1), context.sql),
		).resolves.toBe(false);
		await expect(
			checkProjectRuntimeConfiguration(
				[
					...context.env.projectRuntime,
					{
						...firstRuntime,
						projectInstanceKey: "unknown",
					},
				],
				context.sql,
			),
		).resolves.toBe(false);
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
			{ key: "billing-internal", name: "Billing Internal" },
			{ key: "voysee", name: "Voysee" },
			{ key: "voysee-sandbox", name: "Voysee" },
			{ key: "wiseley", name: "Wiseley" },
			{ key: "wiseley-sandbox", name: "Wiseley" },
		]);
		expect(Number(storeProductCount[0]?.count ?? "0")).toBe(12);
	});

	it("imports a catalog only for an existing mapped project instance", async () => {
		const configured = [
			{
				projectInstanceKey: "voysee",
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
		];
		const firstConfiguredProject = configured[0];
		if (firstConfiguredProject === undefined)
			throw new Error("Expected a configured catalog project");

		await syncConfiguredCatalog(configured, context.projectContextResolver, context.db);
		await syncConfiguredCatalog(configured, context.projectContextResolver, context.db);
		await expect(
			syncConfiguredCatalog(
				[{ ...firstConfiguredProject, projectInstanceKey: "unmapped" }],
				context.projectContextResolver,
				context.db,
			),
		).rejects.toThrow("Catalog import project instance unmapped is not available");

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
			WHERE projects.key = 'voysee'
				AND products.key = 'creator_monthly'
		`;
		expect(rows).toEqual([
			{
				project_key: "voysee",
				product_key: "creator_monthly",
				credit_amount: 500,
				external_product_id: "prod_thru_creator",
				external_price_id: "price_thru_creator",
			},
		]);
	});
});
