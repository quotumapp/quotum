import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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

type Binding = { productKey: string; provider: string; channel: string };

/** A plan whose provider owns the price: only its billing cadence is declared. */
function providerPricedCatalog(
	version: number,
	billingInterval: string,
	binding: Binding,
	billingIntervalCount = 1,
) {
	return {
		features: [
			{
				key: "ai_credits",
				name: "AI credits",
				kind: "metered",
				meterKind: "consumable",
				unit: "credit",
				creditScale: 0,
				filterDimensions: [],
			},
		],
		plans: [
			{
				key: "dash",
				name: "Dashboard priced",
				version,
				kind: "base",
				basePrice: null,
				providerPriced: { billingInterval, billingIntervalCount, providerBindings: [binding] },
				items: [
					{
						itemKind: "allocation",
						featureKey: "ai_credits",
						quantity: "1200",
						reset: { interval: billingInterval, intervalCount: billingIntervalCount },
					},
				],
			},
		],
		topups: [],
		rateCards: [],
	};
}

const stripeBinding = { productKey: "dash_priced", provider: "stripe", channel: "web" };
const appleBinding = { productKey: "dash_apple", provider: "apple", channel: "ios" };
const googleBinding = { productKey: "dash_google", provider: "google", channel: "android" };

localDescribe("provider-priced plan binding cadence", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	/** A subscription store product that sells `period` (a count of that unit), active. */
	async function seedStoreProduct(
		binding: Binding,
		period: string,
		periodCount = 1,
		type: "subscription" | "consumable" = "subscription",
	) {
		await context.sql`
			INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type, active)
			SELECT id, ${binding.productKey}, ${binding.productKey}, 0, ${binding.productKey}, ${type}, true
			FROM projects WHERE key = 'acme'
			ON CONFLICT (project_id, key) DO NOTHING
		`;
		await context.sql`
			INSERT INTO store_products (
				project_id, product_id, provider, channel, external_product_id,
				external_price_id, billing_period, billing_period_count, currency, price_amount, active
			)
			SELECT project.id, product.id, ${binding.provider}, ${binding.channel},
				${`ext_${binding.productKey}`}, ${binding.provider === "stripe" ? `price_${binding.productKey}` : null},
				${period}, ${periodCount}, 'usd', 1200, true
			FROM projects project
			JOIN products product ON product.project_id = project.id AND product.key = ${binding.productKey}
			WHERE project.key = 'acme'
		`;
	}

	function operator() {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = {
			...(authHeaders() as Record<string, string>),
			"content-type": "application/json",
			"x-billing-actor": "binding-cadence-test",
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
		};
		const preview = async (catalog: unknown, expectedRevision: number | null = null) => {
			const response = await testRequest(app, "/v1/admin/catalog/preview", {
				method: "POST",
				headers,
				body: JSON.stringify({ expectedRevision, catalog }),
			});
			return { status: response.status, body: await response.json() };
		};
		const publish = async (
			catalog: unknown,
			previewToken: string,
			expectedRevision: number | null = null,
		) => {
			const response = await testRequest(app, "/v1/admin/catalog/publish", {
				method: "POST",
				headers,
				body: JSON.stringify({ expectedRevision, previewToken, catalog }),
			});
			return { status: response.status, body: await response.json() };
		};
		return { preview, publish };
	}

	it("refuses a yearly plan on a monthly product at preview, for every provider", async () => {
		await seedStoreProduct(stripeBinding, "month");
		await seedStoreProduct(appleBinding, "month");
		await seedStoreProduct(googleBinding, "month");
		const { preview } = operator();
		for (const binding of [stripeBinding, appleBinding, googleBinding]) {
			const refused = await preview(providerPricedCatalog(1, "year", binding));
			expect(refused.status).toBe(409);
			expect(refused.body.error.code).toBe("PROVIDER_BINDING_NOT_READY");
			expect(refused.body.error.message).toBe(
				`Provider binding ${binding.provider}/${binding.channel}/${binding.productKey} sells every month but plan dash bills every year`,
			);
		}
		expect(await context.sql`SELECT id FROM catalog_drafts`).toHaveLength(0);
	});

	it("refuses a binding that sells another count or a one-time purchase", async () => {
		await seedStoreProduct(stripeBinding, "month", 4);
		await seedStoreProduct({ ...stripeBinding, productKey: "dash_once" }, "one_time");
		const { preview } = operator();
		const fourMonths = await preview(providerPricedCatalog(1, "month", stripeBinding, 3));
		expect(fourMonths.status).toBe(409);
		expect(fourMonths.body.error.message).toBe(
			"Provider binding stripe/web/dash_priced sells every 4 × month but plan dash bills every 3 × month",
		);
		const once = await preview(
			providerPricedCatalog(1, "month", { ...stripeBinding, productKey: "dash_once" }),
		);
		expect(once.status).toBe(409);
		expect(once.body.error.message).toBe(
			"Provider binding stripe/web/dash_once sells one_time but plan dash bills every month",
		);
	});

	it("names a binding with no active subscription product", async () => {
		const { preview } = operator();
		const missing = await preview(providerPricedCatalog(1, "month", stripeBinding));
		expect(missing.status).toBe(409);
		expect(missing.body.error).toMatchObject({
			code: "PROVIDER_BINDING_NOT_READY",
			message:
				"Provider binding stripe/web/dash_priced for plan dash is not ready: no active subscription product is mapped",
		});
	});

	it("publishes a plan whose cadence matches, and republishing it changes nothing", async () => {
		await seedStoreProduct(stripeBinding, "year");
		await seedStoreProduct(appleBinding, "month", 3);
		const { preview, publish } = operator();
		const yearly = providerPricedCatalog(1, "year", stripeBinding);
		const previewed = await preview(yearly);
		expect(previewed.status).toBe(200);
		const published = await publish(yearly, previewed.body.data.previewToken);
		expect(published.status).toBe(200);
		// An unchanged plan is not checked again, so a later change to its product cannot block an
		// unrelated publish.
		await context.sql`UPDATE store_products SET billing_period = 'month' WHERE provider = 'stripe'`;
		const again = await preview(yearly, 1);
		expect(again.status).toBe(200);
		expect(again.body.data.impact).toMatchObject({ planVersionsCreated: 0 });
		// A quarter is three months, however the product spells it.
		const quarter = await preview(
			{
				...yearly,
				plans: [
					...yearly.plans,
					{
						...providerPricedCatalog(1, "quarter", appleBinding).plans[0],
						key: "quarterly",
						name: "Quarterly",
					},
				],
			},
			1,
		);
		expect(quarter.status).toBe(200);
	});

	it("refuses at publish a product that changed after the preview", async () => {
		await seedStoreProduct(stripeBinding, "year");
		const { preview, publish } = operator();
		const yearly = providerPricedCatalog(1, "year", stripeBinding);
		const previewed = await preview(yearly);
		expect(previewed.status).toBe(200);
		await context.sql`UPDATE store_products SET billing_period = 'month' WHERE provider = 'stripe'`;
		const refused = await publish(yearly, previewed.body.data.previewToken);
		expect(refused.status).toBe(409);
		expect(refused.body.error.message).toBe(
			"Provider binding stripe/web/dash_priced sells every month but plan dash bills every year",
		);
		expect(await context.sql`SELECT id FROM plans WHERE key = 'dash'`).toHaveLength(0);
		expect(await context.sql`SELECT id FROM provider_plan_bindings`).toHaveLength(0);
	});
});
