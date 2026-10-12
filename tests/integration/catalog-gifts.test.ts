import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AuthoredCatalogIntent, CatalogGiftIntent } from "../../src/catalog/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog, publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const projectId = project.projectInstanceId;
let context: LocalPostgresContext;

const gift: CatalogGiftIntent = {
	key: "gift-12m",
	name: "One year, as a gift",
	promotionKey: "voucher-12m",
	codeCount: 2,
	codeValidDays: 365,
	providerBindings: [{ productKey: "gift_12m", provider: "stripe", channel: "web" }],
};

function withGifts(extra: Partial<AuthoredCatalogIntent>): AuthoredCatalogIntent {
	return { ...aiCreditsCatalog, ...extra };
}

async function publish(catalog: AuthoredCatalogIntent, expectedRevision: number | null) {
	const preview = await context.repository.previewCatalog(project, {
		expectedRevision,
		actor: "catalog-gifts",
		catalog,
	});
	const published = await context.repository.publishCatalog(project, {
		expectedRevision,
		actor: "catalog-gifts",
		previewToken: preview.previewToken,
		catalog,
	});
	return { preview, published };
}

async function failure(work: Promise<unknown>): Promise<{ message: string; code?: string }> {
	try {
		await work;
	} catch (error) {
		const caught = error as { message: string; code?: string };
		return { message: caught.message, code: caught.code };
	}
	throw new Error("The call was expected to fail");
}

/** A credit-free consumable bound to Stripe web, which is what adopting `kind: "gift"` stores. */
async function giftProduct(key = "gift_12m", creditAmount = 0): Promise<void> {
	const [product] = await context.sql<Array<{ id: string }>>`
		INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type)
		VALUES (${projectId}, ${key}, ${key}, ${creditAmount}, 'Gift', 'consumable')
		RETURNING id
	`;
	await context.sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id, external_price_id,
			billing_period, currency, price_amount
		)
		VALUES (${projectId}, ${product?.id}, 'stripe', 'web', ${`prod_${key}`}, ${`price_${key}`},
			'one_time', 'usd', 9900)
	`;
}

async function planGrantPromotion(key = "voucher-12m"): Promise<void> {
	await context.repository.promotions.createPromotion(project, {
		key,
		name: key,
		effect: { kind: "plan_grant", planKey: "premium", durationUnit: "month", durationCount: 12 },
		actor: "operator",
	});
}

localDescribe("Catalog gifts integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("publishes a gift with its promotion, terms and binding, and reads it back", async () => {
		await planGrantPromotion();
		await giftProduct();

		const { preview, published } = await publish(withGifts({ gifts: [gift] }), 1);

		expect(preview.impact).toMatchObject({ giftOptionsCreated: 1, giftsRetired: 0 });
		expect(preview.providerCompatibility).toContainEqual(
			expect.objectContaining({
				target: { kind: "gift", key: "gift-12m" },
				provider: "stripe",
				compatible: true,
			}),
		);
		expect(published.impact.giftOptionsCreated).toBe(1);
		const catalog = (await context.repository.getPublishedCatalog(project)).catalog;
		expect(catalog?.gifts).toEqual([gift]);
		expect(catalog).not.toHaveProperty("retiredGiftKeys");
		const [row] = await context.sql<
			Array<{
				key: string;
				code_count: number;
				code_valid_days: number;
				promotion_key: string;
				status: string;
				provider: string;
				channel: string;
			}>
		>`
			SELECT o.key, o.code_count, o.code_valid_days, p.key AS promotion_key, b.status, b.provider, b.channel
			FROM gift_options o
			JOIN promotions p ON p.project_id = o.project_id AND p.id = o.promotion_id
			JOIN provider_gift_bindings b ON b.project_id = o.project_id AND b.gift_option_id = o.id
			WHERE o.project_id = ${projectId}
		`;
		expect(row).toEqual({
			key: "gift-12m",
			code_count: 2,
			code_valid_days: 365,
			promotion_key: "voucher-12m",
			status: "published",
			provider: "stripe",
			channel: "web",
		});
	});

	it("re-points the binding at the new option when the gift is republished", async () => {
		await planGrantPromotion();
		await giftProduct();
		await publish(withGifts({ gifts: [gift] }), 1);

		await publish(withGifts({ gifts: [{ ...gift, codeCount: 3 }] }), 2);

		const rows = await context.sql<Array<{ code_count: number; revision: number }>>`
			SELECT o.code_count, r.revision
			FROM provider_gift_bindings b
			JOIN gift_options o ON o.project_id = b.project_id AND o.id = b.gift_option_id
			JOIN catalog_revisions r ON r.project_id = o.project_id AND r.id = o.catalog_revision_id
			WHERE b.project_id = ${projectId}
		`;
		expect(rows).toEqual([{ code_count: 3, revision: 3 }]);
	});

	it("refuses a promotion that is missing, archived or not a plan grant", async () => {
		await giftProduct();
		expect((await failure(publish(withGifts({ gifts: [gift] }), 1))).message).toBe(
			"Gift gift-12m names promotion voucher-12m, which does not exist",
		);

		await context.repository.promotions.createPromotion(project, {
			key: "voucher-12m",
			name: "Discount",
			effect: {
				kind: "discount",
				discount: { type: "percent", percentOffBps: 1000, duration: "once", durationMonths: null },
			},
			actor: "operator",
		});
		expect((await failure(publish(withGifts({ gifts: [gift] }), 1))).message).toBe(
			"Gift gift-12m must name a plan_grant promotion; voucher-12m is discount",
		);

		await planGrantPromotion("voucher-archived");
		await context.repository.promotions.archivePromotion(project, "voucher-archived", "operator");
		expect(
			(
				await failure(
					publish(withGifts({ gifts: [{ ...gift, promotionKey: "voucher-archived" }] }), 1),
				)
			).message,
		).toBe("Gift gift-12m names promotion voucher-archived, which is archived");
	});

	it("refuses a binding to a product that is unmapped or sells credits", async () => {
		await planGrantPromotion();

		const unmapped = await failure(publish(withGifts({ gifts: [gift] }), 1));
		expect(unmapped.code).toBe("PROVIDER_BINDING_NOT_READY");
		expect(unmapped.message).toContain("no active credit-free consumable product is mapped");

		await giftProduct("credit_pack", 10);
		const credits = await failure(
			publish(
				withGifts({
					gifts: [
						{
							...gift,
							providerBindings: [{ productKey: "credit_pack", provider: "stripe", channel: "web" }],
						},
					],
				}),
				1,
			),
		);
		expect(credits.code).toBe("PROVIDER_BINDING_NOT_READY");
	});

	it("keeps a gift active until it is retired, and keeps its binding for checkouts in flight", async () => {
		await planGrantPromotion();
		await giftProduct();
		await publish(withGifts({ gifts: [gift] }), 1);

		expect((await failure(publish(withGifts({}), 2))).message).toBe(
			"Active gift gift-12m must remain in the catalog or be explicitly retired",
		);
		expect((await failure(publish(withGifts({ retiredGiftKeys: ["unknown"] }), 2))).message).toBe(
			"Cannot retire unknown gift unknown",
		);

		const { preview, published } = await publish(withGifts({ retiredGiftKeys: ["gift-12m"] }), 2);

		expect(preview.impact.giftsRetired).toBe(1);
		expect(published.impact.giftsRetired).toBe(1);
		const catalog = (await context.repository.getPublishedCatalog(project)).catalog;
		expect(catalog).not.toHaveProperty("gifts");
		expect(catalog?.retiredGiftKeys).toEqual(["gift-12m"]);
		const [binding] = await context.sql<Array<{ status: string; revision: number }>>`
			SELECT b.status, r.revision
			FROM provider_gift_bindings b
			JOIN gift_options o ON o.project_id = b.project_id AND o.id = b.gift_option_id
			JOIN catalog_revisions r ON r.project_id = o.project_id AND r.id = o.catalog_revision_id
			WHERE b.project_id = ${projectId}
		`;
		expect(binding).toEqual({ status: "published", revision: 2 });
	});
});
