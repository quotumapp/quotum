import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import { CatalogBindings } from "../../src/catalog/bindings";
import { noRuntimeConnections } from "../../src/projects/connections";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;
const input = {
	productKey: "adopted",
	name: "Adopted",
	kind: "subscription" as const,
	entitlementKey: "premium",
	credits: 100,
	externalProductId: "prod_adopted",
	externalPriceId: "price_adopted",
};
localDescribe("operator binding adoption", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});
	function service(price: Record<string, unknown> = {}) {
		return new CatalogBindings(
			context.db as never,
			{ ...noRuntimeConnections, resolve: async () => ({ secretKey: "test" }) as never },
			() =>
				({
					prices: {
						retrieve: async () => ({
							id: input.externalPriceId,
							product: input.externalProductId,
							active: true,
							livemode: true,
							billing_scheme: "per_unit",
							unit_amount: 1000,
							currency: "usd",
							type: "recurring",
							recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
							...price,
						}),
					},
					products: {
						retrieve: async () => ({ id: input.externalProductId, active: true, livemode: true }),
					},
				}) as unknown as Stripe,
		);
	}
	it("adopts after publication, records the actor, and replays exact requests", async () => {
		await publishAiCreditsCatalog(context.repository);
		const bindings = service();
		const project = integrationProjectContext();
		const result = await bindings.adopt(project, input, "operator", "adopt-1");
		expect(await bindings.adopt(project, input, "operator", "adopt-1")).toEqual(result);
		expect(await bindings.adopt(project, input, "operator", "adopt-2")).toEqual(result);
		expect(await bindings.list(project)).toContainEqual(result);
		const rows = await context.sql<
			Array<{ actor: string }>
		>`SELECT actor FROM catalog_binding_adoptions WHERE project_id = ${project.projectInstanceId}`;
		expect(rows.map((row) => row.actor)).toEqual(["operator", "operator"]);
		await expect(
			bindings.adopt(project, { ...input, name: "changed" }, "operator", "adopt-1"),
		).rejects.toMatchObject({ details: { reason: "idempotency_key_reused" } });
		await expect(
			bindings.adopt(project, { ...input, entitlementKey: "changed" }, "operator", "adopt-3"),
		).rejects.toMatchObject({ details: { reason: "product_identity_conflict" } });
	});
	it("accepts an exact repeat when the product also holds a retired mapping", async () => {
		const bindings = service();
		const project = integrationProjectContext();
		const result = await bindings.adopt(project, input, "operator", "adopt-1");
		await context.sql`INSERT INTO store_products (project_id, product_id, provider, channel, external_product_id, external_price_id, billing_period, billing_period_count, currency, price_amount, active) VALUES (${project.projectInstanceId}, ${result.productId}, 'stripe', 'web', ${input.externalProductId}, 'price_retired', 'month', 1, 'usd', 500, false)`;
		// Rewriting the exact row moves it behind the retired one in heap order.
		await context.sql`UPDATE store_products SET updated_at = now() WHERE id = ${result.storeProductId}`;
		expect(await bindings.adopt(project, input, "operator", "adopt-2")).toEqual(result);
	});
	it("adopts a gift as a credit-free consumable without an entitlement key", async () => {
		const bindings = service({ type: "one_time", recurring: null, unit_amount: 9900 });
		const project = integrationProjectContext();
		const gift = {
			productKey: "gift_12m",
			name: "One year, as a gift",
			kind: "gift" as const,
			externalProductId: input.externalProductId,
			externalPriceId: input.externalPriceId,
		};

		const result = await bindings.adopt(project, gift, "operator", "gift-1");

		expect(await bindings.adopt(project, gift, "operator", "gift-1")).toEqual(result);
		const [row] = await context.sql<
			Array<{
				type: string;
				credit_amount: number;
				entitlement_key: string;
				billing_period: string;
				price_amount: string;
			}>
		>`
			SELECT p.type, p.credit_amount, p.entitlement_key, sp.billing_period, sp.price_amount::text
			FROM products p JOIN store_products sp ON sp.project_id = p.project_id AND sp.product_id = p.id
			WHERE p.project_id = ${project.projectInstanceId} AND p.key = 'gift_12m'
		`;
		expect(row).toEqual({
			type: "consumable",
			credit_amount: 0,
			entitlement_key: "gift_12m",
			billing_period: "one_time",
			price_amount: "9900",
		});
	});

	it("refuses a gift priced at zero or on a recurring price", async () => {
		const project = integrationProjectContext();
		const gift = {
			productKey: "gift_12m",
			name: "One year, as a gift",
			kind: "gift" as const,
			externalProductId: input.externalProductId,
			externalPriceId: input.externalPriceId,
		};

		await expect(
			service({ type: "one_time", recurring: null, unit_amount: 0 }).adopt(
				project,
				gift,
				"operator",
				"free",
			),
		).rejects.toMatchObject({ details: { reason: "unsupported_price_shape" } });
		await expect(service().adopt(project, gift, "operator", "recurring")).rejects.toMatchObject({
			details: { reason: "unsupported_price_shape" },
		});
	});

	it("refuses a live price for a sandbox instance", async () => {
		await expect(
			service().adopt(
				{ ...integrationProjectContext(), environment: "sandbox" },
				input,
				"operator",
				"mode",
			),
		).rejects.toMatchObject({ details: { reason: "product_price_or_environment_mismatch" } });
	});
});
