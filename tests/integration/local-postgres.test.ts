import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import { syncConfiguredCatalog } from "../../src/catalog/provision";
import { createBillingReadinessCheck } from "../../src/composition/runtime-readiness";
import { checkPostgresHealth } from "../../src/db/client";
import { testRequest } from "../helpers/openapi";
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
		const response = await testRequest(app, "/health");

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

		const livez = await testRequest(app, "/livez");
		const ready = await testRequest(app, "/ready");
		const readyAgain = await testRequest(app, "/ready");

		expect(livez.status).toBe(200);
		expect(await livez.json()).toEqual({ status: "ok" });
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ok" });
		expect(readyAgain.status).toBe(200);
		expect(checks).toBe(2);
	});

	it("is ready with no configured customer connections", async () => {
		await expect(createBillingReadinessCheck(context.sql)()).resolves.toBe(true);
	});

	it("bounds statements, idle transactions and whole transactions", async () => {
		const limits = await context.sql<{ statement: string; idle: string; transaction: string }[]>`
			SELECT current_setting('statement_timeout') AS statement,
				current_setting('idle_in_transaction_session_timeout') AS idle,
				current_setting('transaction_timeout') AS transaction
		`;

		expect(limits).toEqual([{ statement: "30s", idle: "30s", transaction: "2min" }]);
	});

	it("generates billing keys as UUIDv7 and platform keys as random UUIDs", async () => {
		const defaults = await context.sql<{ platform: boolean; expression: string }[]>`
			SELECT (relation.relname LIKE 'platform\\_%' OR relation.relname = 'projects') AS platform,
				pg_get_expr(defaults.adbin, defaults.adrelid) AS expression
			FROM pg_attrdef defaults
			JOIN pg_attribute attribute
				ON attribute.attrelid = defaults.adrelid AND attribute.attnum = defaults.adnum
			JOIN pg_class relation ON relation.oid = defaults.adrelid
			WHERE relation.relnamespace = current_schema()::regnamespace
				AND attribute.attname = 'id'
				AND attribute.atttypid = 'uuid'::regtype
			GROUP BY 1, 2
			ORDER BY 1, 2
		`;
		const created = await context.sql<{ version: number; extensions: number }[]>`
			WITH account AS (
				INSERT INTO customers (project_id, billing_account_id)
				SELECT id, 'uuid-default' FROM projects WHERE key = 'acme'
				RETURNING id
			)
			SELECT uuid_extract_version(account.id)::int AS version,
				(SELECT count(*)::int FROM pg_extension WHERE extname = 'uuid-ossp') AS extensions
			FROM account
		`;

		expect(defaults).toEqual([
			{ platform: false, expression: "uuidv7()" },
			{ platform: true, expression: "gen_random_uuid()" },
		]);
		expect(created).toEqual([{ version: 7, extensions: 0 }]);
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
			{ key: "acme", name: "Acme" },
			{ key: "acme-sandbox", name: "Acme" },
			{ key: "billing-internal", name: "Billing Internal" },
			{ key: "globex", name: "Globex" },
			{ key: "globex-sandbox", name: "Globex" },
		]);
		expect(Number(storeProductCount[0]?.count ?? "0")).toBe(12);
	});

	it("imports a catalog only for an existing mapped project instance", async () => {
		const configured = [
			{
				projectInstanceKey: "acme",
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
						intervalCount: 1,
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
			WHERE projects.key = 'acme'
				AND products.key = 'creator_monthly'
		`;
		expect(rows).toEqual([
			{
				project_key: "acme",
				product_key: "creator_monthly",
				credit_amount: 500,
				external_product_id: "prod_thru_creator",
				external_price_id: "price_thru_creator",
			},
		]);
	});
});
