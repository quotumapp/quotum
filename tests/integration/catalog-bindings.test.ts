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

	describe("App Store and Google Play products", () => {
		const apple = {
			provider: "apple" as const,
			productKey: "premium_ios",
			name: "Premium on iOS",
			kind: "subscription" as const,
			entitlementKey: "premium",
			credits: 100,
			externalProductId: "com.acme.premium.monthly",
			billingPeriod: "month" as const,
		};
		const google = {
			provider: "google" as const,
			productKey: "premium_android",
			name: "Premium on Android",
			kind: "subscription" as const,
			entitlementKey: "premium",
			credits: 100,
			externalProductId: "acme_pro_monthly",
			externalPriceId: "monthly-base",
			billingPeriod: "month" as const,
			currency: "USD",
			priceAmountMinor: 999,
		};

		/** A service whose Stripe client fails the test if an adoption ever reaches for it. */
		function nativeService() {
			return new CatalogBindings(
				context.db as never,
				{
					...noRuntimeConnections,
					resolve: async () => {
						throw new Error("A native adoption must not read a connection");
					},
				},
				() => {
					throw new Error("A native adoption must not call a provider");
				},
			);
		}

		it("registers declared products without any store or connection, and replays exactly", async () => {
			const bindings = nativeService();
			const project = integrationProjectContext();
			const ios = await bindings.adopt(project, apple, "operator", "apple-1");
			expect(ios).toMatchObject({
				productKey: "premium_ios",
				provider: "apple",
				channel: "ios",
				externalProductId: "com.acme.premium.monthly",
				externalPriceId: null,
				active: true,
			});
			const android = await bindings.adopt(project, google, "operator", "google-1");
			expect(android).toMatchObject({
				provider: "google",
				channel: "android",
				externalPriceId: "monthly-base",
			});

			expect(await bindings.adopt(project, apple, "operator", "apple-1")).toEqual(ios);
			expect(await bindings.adopt(project, apple, "operator", "apple-2")).toEqual(ios);
			expect(await bindings.list(project)).toEqual(expect.arrayContaining([ios, android]));

			const rows = await context.sql<
				Array<{
					provider: string;
					channel: string;
					billing_period: string;
					billing_period_count: number;
					currency: string | null;
					price_amount: string | null;
					type: string;
				}>
			>`
				SELECT sp.provider, sp.channel, sp.billing_period, sp.billing_period_count, sp.currency,
					sp.price_amount::text, p.type
				FROM store_products sp JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
				WHERE sp.project_id = ${project.projectInstanceId} AND p.key IN ('premium_ios', 'premium_android')
				ORDER BY sp.provider
			`;
			expect(rows).toEqual([
				{
					provider: "apple",
					channel: "ios",
					billing_period: "month",
					billing_period_count: 1,
					currency: null,
					price_amount: null,
					type: "subscription",
				},
				{
					provider: "google",
					channel: "android",
					billing_period: "month",
					billing_period_count: 1,
					currency: "usd",
					price_amount: "999",
					type: "subscription",
				},
			]);
		});

		it("stores a top-up as a one-time consumable", async () => {
			const topup = {
				provider: "apple" as const,
				productKey: "credits_50",
				name: "50 credits",
				kind: "topup" as const,
				entitlementKey: "credits",
				credits: 50,
				externalProductId: "com.acme.credits.50",
			};
			const project = integrationProjectContext();
			await nativeService().adopt(project, topup, "operator", "topup-1");
			const [row] = await context.sql<
				Array<{ type: string; billing_period: string; billing_period_count: number }>
			>`
				SELECT p.type, sp.billing_period, sp.billing_period_count
				FROM store_products sp JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
				WHERE sp.project_id = ${project.projectInstanceId} AND p.key = 'credits_50'
			`;
			expect(row).toEqual({
				type: "consumable",
				billing_period: "one_time",
				billing_period_count: 1,
			});
		});

		it("maps one product key on Stripe and on a native store", async () => {
			const project = integrationProjectContext();
			const stripeResult = await service().adopt(project, input, "operator", "stripe-1");
			const ios = await nativeService().adopt(
				project,
				{
					...apple,
					productKey: input.productKey,
					name: input.name,
					entitlementKey: input.entitlementKey,
					credits: input.credits,
				},
				"operator",
				"apple-1",
			);
			expect(ios.productId).toBe(stripeResult.productId);
			expect(ios.storeProductId).not.toBe(stripeResult.storeProductId);
			const listed = (await nativeService().list(project)).filter(
				(binding) => binding.productKey === input.productKey,
			);
			expect(listed.map((binding) => binding.provider).sort()).toEqual(["apple", "stripe"]);
		});

		it("adds a price to a mapping that has none, and keeps a price once set", async () => {
			const bindings = nativeService();
			const project = integrationProjectContext();
			const priced = { ...apple, currency: "USD", priceAmountMinor: 999 };
			const unpriced = await bindings.adopt(project, apple, "operator", "apple-1");

			expect(await bindings.adopt(project, priced, "operator", "apple-2")).toEqual(unpriced);
			const [row] = await context.sql<Array<{ currency: string; price_amount: string }>>`
				SELECT currency, price_amount::text FROM store_products
				WHERE project_id = ${project.projectInstanceId} AND id = ${unpriced.storeProductId}
			`;
			expect(row).toEqual({ currency: "usd", price_amount: "999" });

			expect(await bindings.adopt(project, priced, "operator", "apple-3")).toEqual(unpriced);
			await expect(
				bindings.adopt(project, { ...priced, priceAmountMinor: 1299 }, "operator", "apple-4"),
			).rejects.toMatchObject({
				code: "STORE_BINDING_INVALID",
				details: { check: "binding", reason: "binding_identity_conflict" },
			});
			await expect(bindings.adopt(project, apple, "operator", "apple-5")).rejects.toMatchObject({
				code: "STORE_BINDING_INVALID",
				details: { check: "binding", reason: "binding_identity_conflict" },
			});
		});

		it("does not add a price when the rest of the mapping differs", async () => {
			const bindings = nativeService();
			const project = integrationProjectContext();
			await bindings.adopt(project, apple, "operator", "apple-1");

			await expect(
				bindings.adopt(
					project,
					{ ...apple, billingPeriod: "year" as const, currency: "USD", priceAmountMinor: 999 },
					"operator",
					"apple-2",
				),
			).rejects.toMatchObject({
				code: "STORE_BINDING_INVALID",
				details: { check: "binding", reason: "binding_identity_conflict" },
			});
		});

		it("refuses a reused key, a changed product and a store product mapped twice", async () => {
			const bindings = nativeService();
			const project = integrationProjectContext();
			await bindings.adopt(project, apple, "operator", "apple-1");

			await expect(
				bindings.adopt(project, { ...apple, name: "changed" }, "operator", "apple-1"),
			).rejects.toMatchObject({
				code: "STORE_BINDING_INVALID",
				details: { check: "binding", reason: "idempotency_key_reused" },
			});
			await expect(
				bindings.adopt(project, { ...apple, entitlementKey: "changed" }, "operator", "apple-2"),
			).rejects.toMatchObject({
				code: "STORE_BINDING_INVALID",
				details: { reason: "product_identity_conflict" },
			});
			// The same store product under another key, or the same key with another store product.
			await expect(
				bindings.adopt(project, { ...apple, productKey: "other_key" }, "operator", "apple-3"),
			).rejects.toThrow();
			await expect(
				bindings.adopt(
					project,
					{ ...apple, externalProductId: "com.acme.premium.yearly" },
					"operator",
					"apple-4",
				),
			).rejects.toMatchObject({ details: { reason: "binding_identity_conflict" } });
			// A declared fact that differs is a different mapping, never a silent rewrite.
			await expect(
				bindings.adopt(
					project,
					{ ...apple, billingPeriod: "year" as const },
					"operator",
					"apple-5",
				),
			).rejects.toMatchObject({ details: { reason: "binding_identity_conflict" } });
		});

		it("answers an adoption recorded before native stores with the provider and channel it implies", async () => {
			const project = integrationProjectContext();
			const bindings = service();
			const first = await bindings.adopt(project, input, "operator", "legacy-1");
			// Receipts written by earlier releases carry neither field.
			await context.sql`
				UPDATE catalog_binding_adoptions
				SET result = result - 'provider' - 'channel'
				WHERE project_id = ${project.projectInstanceId} AND request_key = 'legacy-1'
			`;
			expect(await bindings.adopt(project, input, "operator", "legacy-1")).toEqual(first);
		});
	});
});
