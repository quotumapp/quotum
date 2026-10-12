import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	deactivateGiftCodesForPurchaseInTx,
	GIFT_MINT_ACTOR,
	mintGiftCodesForPurchaseInTx,
} from "../../src/db/repository/gifts";
import type { QueryExecutor, TransactionalQueryExecutor } from "../../src/db/repository/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const projectId = integrationProjectContext().projectInstanceId;
const purchasedAt = new Date("2026-10-12T12:00:00.000Z");
const day = 86_400_000;
let context: LocalPostgresContext;

interface GiftFixture {
	storeProductId: string;
	customerId: string;
	promotionId: string;
	optionId: string;
}

/** A published gift: one promotion, one revision, an option of `codeCount` codes, a Stripe binding. */
async function seedGift(options: { codeCount: number; bound?: boolean }): Promise<GiftFixture> {
	const { sql } = context;
	const [product] = await sql<Array<{ id: string }>>`
		INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type)
		VALUES (${projectId}, 'gift_12m', 'gift', 0, 'One year, as a gift', 'consumable')
		RETURNING id
	`;
	const [storeProduct] = await sql<Array<{ id: string }>>`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id, external_price_id,
			billing_period, currency, price_amount
		)
		VALUES (
			${projectId}, ${product?.id}, 'stripe', 'web', 'prod_gift', 'price_gift', 'one_time', 'usd', 9900
		)
		RETURNING id
	`;
	const [customer] = await sql<Array<{ id: string }>>`
		INSERT INTO customers (project_id, billing_account_id)
		VALUES (${projectId}, 'buyer')
		RETURNING id
	`;
	const [promotion] = await sql<Array<{ id: string }>>`
		INSERT INTO promotions (project_id, key, name, effect_kind, terms_hash, created_by)
		VALUES (${projectId}, 'voucher-12m', 'Voucher', 'feature_grant', ${"a".repeat(64)}, 'operator')
		RETURNING id
	`;
	const [revision] = await sql<Array<{ id: string }>>`
		INSERT INTO catalog_revisions (project_id, revision, status, intent_hash, created_by)
		VALUES (${projectId}, 1, 'ready', ${"b".repeat(64)}, 'operator')
		RETURNING id
	`;
	const [option] = await sql<Array<{ id: string }>>`
		INSERT INTO gift_options (
			project_id, catalog_revision_id, key, name, promotion_id, code_count, code_valid_days
		)
		VALUES (
			${projectId}, ${revision?.id}, 'gift-12m', 'One year', ${promotion?.id}, ${options.codeCount}, 730
		)
		RETURNING id
	`;
	if (options.bound !== false) {
		await sql`
			INSERT INTO provider_gift_bindings (
				project_id, gift_option_id, store_product_id, provider, channel, status
			)
			VALUES (${projectId}, ${option?.id}, ${storeProduct?.id}, 'stripe', 'web', 'published')
		`;
	}
	if (
		storeProduct === undefined ||
		customer === undefined ||
		promotion === undefined ||
		option === undefined
	) {
		throw new Error("The gift fixture was not seeded");
	}
	return {
		storeProductId: storeProduct.id,
		customerId: customer.id,
		promotionId: promotion.id,
		optionId: option.id,
	};
}

async function purchase(
	gift: GiftFixture,
	transactionId: string,
	status: "completed" | "refunded" = "completed",
): Promise<string> {
	const [row] = await context.sql<Array<{ id: string; product_id: string }>>`
		INSERT INTO purchases (
			project_id, customer_id, product_id, store_product_id, provider, channel, purchase_kind,
			transaction_id, status, purchased_at
		)
		SELECT
			${projectId}, ${gift.customerId}, store_products.product_id, store_products.id, 'stripe',
			'web', 'consumable', ${transactionId}, ${status}, ${purchasedAt.toISOString()}::timestamptz
		FROM store_products
		WHERE store_products.id = ${gift.storeProductId}
		RETURNING id, product_id
	`;
	if (row === undefined) throw new Error("The purchase was not seeded");
	return row.id;
}

async function inTransaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
	const database = context.db as unknown as TransactionalQueryExecutor;
	return await database.transaction(work);
}

function mint(
	gift: GiftFixture,
	purchaseId: string,
	generateCode?: () => string,
): ReturnType<typeof mintGiftCodesForPurchaseInTx> {
	return inTransaction((tx) =>
		mintGiftCodesForPurchaseInTx(tx, {
			projectId,
			purchaseId,
			storeProductId: gift.storeProductId,
			purchasedAt,
			generateCode,
		}),
	);
}

interface CodeRow {
	code: string;
	normalized_code: string;
	gift_ordinal: number;
	active: boolean;
	max_redemptions: number;
	max_redemptions_per_customer: number;
	billing_account_id: string | null;
	hosted_checkout_enabled: boolean;
	first_purchase_only: boolean;
	created_by: string;
	expires_at: Date;
	deactivated_by: string | null;
}

async function codesOf(purchaseId: string): Promise<CodeRow[]> {
	return await context.sql<CodeRow[]>`
		SELECT code, normalized_code, gift_ordinal, active, max_redemptions, max_redemptions_per_customer,
			billing_account_id, hosted_checkout_enabled, first_purchase_only, created_by, expires_at,
			deactivated_by
		FROM promotion_codes
		WHERE project_id = ${projectId} AND gift_purchase_id = ${purchaseId}
		ORDER BY gift_ordinal
	`;
}

localDescribe("Gift code minting integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("mints one single-use code per ordinal, expiring after the validity from the purchase", async () => {
		const gift = await seedGift({ codeCount: 2 });
		const purchaseId = await purchase(gift, "pi_gift_1");

		expect(await mint(gift, purchaseId)).toEqual({ kind: "minted", codeCount: 2 });

		const codes = await codesOf(purchaseId);
		expect(codes.map((row) => row.gift_ordinal)).toEqual([1, 2]);
		expect(new Set(codes.map((row) => row.code)).size).toBe(2);
		for (const row of codes) {
			expect(row.code).toMatch(/^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){4}$/);
			expect(row).toMatchObject({
				normalized_code: row.code,
				active: true,
				max_redemptions: 1,
				max_redemptions_per_customer: 1,
				billing_account_id: null,
				hosted_checkout_enabled: false,
				first_purchase_only: false,
				created_by: GIFT_MINT_ACTOR,
				deactivated_by: null,
			});
			expect(row.expires_at.getTime()).toBe(purchasedAt.getTime() + 730 * day);
		}
	});

	it("is idempotent by purchase and ordinal, and keeps the terms it snapshotted", async () => {
		const gift = await seedGift({ codeCount: 2 });
		const purchaseId = await purchase(gift, "pi_gift_1");
		await mint(gift, purchaseId);
		const first = (await codesOf(purchaseId)).map((row) => row.code);

		// A catalog published since raises the count and shortens the validity.
		await context.sql`
			UPDATE gift_options SET code_count = 5, code_valid_days = 30 WHERE id = ${gift.optionId}
		`;
		expect(await mint(gift, purchaseId)).toEqual({ kind: "minted", codeCount: 2 });

		const after = await codesOf(purchaseId);
		expect(after.map((row) => row.code)).toEqual(first);
		expect(after[0]?.expires_at.getTime()).toBe(purchasedAt.getTime() + 730 * day);
		const [row] = await context.sql<Array<{ count: string }>>`
			SELECT count(*)::text AS count FROM gift_purchases WHERE project_id = ${projectId}
		`;
		expect(row?.count).toBe("1");
	});

	it("fills only the ordinals that are missing", async () => {
		const gift = await seedGift({ codeCount: 3 });
		const purchaseId = await purchase(gift, "pi_gift_1");
		await mint(gift, purchaseId);
		const before = await codesOf(purchaseId);
		await context.sql`
			DELETE FROM promotion_codes
			WHERE project_id = ${projectId} AND gift_purchase_id = ${purchaseId} AND gift_ordinal = 2
		`;

		await mint(gift, purchaseId);

		const after = await codesOf(purchaseId);
		expect(after.map((row) => row.gift_ordinal)).toEqual([1, 2, 3]);
		expect(after[0]?.code).toBe(before[0]?.code);
		expect(after[2]?.code).toBe(before[2]?.code);
	});

	it("draws again when a code is already taken, and leaves the other code alone", async () => {
		const gift = await seedGift({ codeCount: 1 });
		await context.sql`
			INSERT INTO promotion_codes (project_id, promotion_id, code, normalized_code, created_by)
			VALUES (${projectId}, ${gift.promotionId}, 'TAKEN-CODE', 'TAKEN-CODE', 'operator')
		`;
		const purchaseId = await purchase(gift, "pi_gift_1");
		const draws = ["taken-code", "K7Q2-M9XD-4TRW-P8HB-3NCF"];

		const outcome = await mint(gift, purchaseId, () => draws.shift() ?? "UNEXPECTED-EXTRA-DRAW");

		expect(outcome).toEqual({ kind: "minted", codeCount: 1 });
		expect((await codesOf(purchaseId)).map((row) => row.code)).toEqual([
			"K7Q2-M9XD-4TRW-P8HB-3NCF",
		]);
		const [operator] = await context.sql<
			Array<{ created_by: string; gift_purchase_id: string | null }>
		>`
			SELECT created_by, gift_purchase_id FROM promotion_codes
			WHERE project_id = ${projectId} AND normalized_code = 'TAKEN-CODE'
		`;
		expect(operator).toEqual({ created_by: "operator", gift_purchase_id: null });
	});

	it("gives up with an error rather than a purchase with fewer codes than it sold", async () => {
		const gift = await seedGift({ codeCount: 1 });
		await context.sql`
			INSERT INTO promotion_codes (project_id, promotion_id, code, normalized_code, created_by)
			VALUES (${projectId}, ${gift.promotionId}, 'SAME-CODE', 'SAME-CODE', 'operator')
		`;
		const purchaseId = await purchase(gift, "pi_gift_1");

		let failure: unknown = null;
		try {
			await mint(gift, purchaseId, () => "SAME-CODE");
		} catch (error) {
			failure = error;
		}

		expect(String(failure)).toContain("could not be minted");
	});

	it("mints nothing for a product that is not a gift or a purchase that is not completed", async () => {
		const unbound = await seedGift({ codeCount: 1, bound: false });
		const plain = await purchase(unbound, "pi_plain");
		expect(await mint(unbound, plain)).toEqual({ kind: "not_a_gift" });

		await context.sql`
			INSERT INTO provider_gift_bindings (
				project_id, gift_option_id, store_product_id, provider, channel, status
			)
			VALUES (${projectId}, ${unbound.optionId}, ${unbound.storeProductId}, 'stripe', 'web', 'published')
		`;
		const refunded = await purchase(unbound, "pi_refunded", "refunded");
		expect(await mint(unbound, refunded)).toEqual({ kind: "purchase_not_completed" });

		const [row] = await context.sql<Array<{ count: string }>>`
			SELECT count(*)::text AS count FROM promotion_codes WHERE gift_purchase_id IS NOT NULL
		`;
		expect(row?.count).toBe("0");
	});

	it("deactivates the unredeemed codes of a reversed purchase and keeps a redeemed one", async () => {
		const gift = await seedGift({ codeCount: 3 });
		const purchaseId = await purchase(gift, "pi_gift_1");
		await mint(gift, purchaseId);
		await context.sql`
			UPDATE promotion_codes SET redeemed_count = 1
			WHERE project_id = ${projectId} AND gift_purchase_id = ${purchaseId} AND gift_ordinal = 2
		`;

		const reversal = await inTransaction((tx) =>
			deactivateGiftCodesForPurchaseInTx(tx, {
				projectId,
				purchaseId,
				reason: "refund",
				reversedAt: new Date("2026-10-13T08:00:00.000Z"),
				actor: "provider:stripe",
			}),
		);

		expect(reversal).toEqual({ deactivated: 2 });
		const codes = await codesOf(purchaseId);
		expect(codes.map((row) => [row.gift_ordinal, row.active, row.deactivated_by])).toEqual([
			[1, false, "provider:stripe"],
			[2, true, null],
			[3, false, "provider:stripe"],
		]);
		const [state] = await context.sql<Array<{ reversed_at: Date; reversal_reason: string }>>`
			SELECT reversed_at, reversal_reason FROM gift_purchases
			WHERE project_id = ${projectId} AND purchase_id = ${purchaseId}
		`;
		expect(state?.reversal_reason).toBe("refund");
		expect(state?.reversed_at.toISOString()).toBe("2026-10-13T08:00:00.000Z");
		const [audit] = await context.sql<Array<{ count: string }>>`
			SELECT count(*)::text AS count FROM promotion_audit_events
			WHERE project_id = ${projectId} AND action = 'code_deactivated' AND actor = 'provider:stripe'
		`;
		expect(audit?.count).toBe("2");
	});

	it("records a reversal once, and a late replay of the completion mints nothing", async () => {
		const gift = await seedGift({ codeCount: 2 });
		const purchaseId = await purchase(gift, "pi_gift_1");
		await mint(gift, purchaseId);
		const reverse = () =>
			inTransaction((tx) =>
				deactivateGiftCodesForPurchaseInTx(tx, {
					projectId,
					purchaseId,
					reason: "dispute",
					reversedAt: purchasedAt,
					actor: "provider:stripe",
				}),
			);

		expect(await reverse()).toEqual({ deactivated: 2 });
		expect(await reverse()).toBeNull();
		// With every ordinal missing, a replay would have codes to mint were it not for the reversal.
		await context.sql`
			DELETE FROM promotion_audit_events
			WHERE promotion_code_id IN (
				SELECT id FROM promotion_codes WHERE gift_purchase_id = ${purchaseId}
			)
		`;
		await context.sql`DELETE FROM promotion_codes WHERE gift_purchase_id = ${purchaseId}`;
		expect(await mint(gift, purchaseId)).toEqual({ kind: "reversed" });
		expect(await codesOf(purchaseId)).toHaveLength(0);
	});

	it("answers null for a purchase that is not a gift", async () => {
		const gift = await seedGift({ codeCount: 1, bound: false });
		const purchaseId = await purchase(gift, "pi_plain");

		const reversal = await inTransaction((tx) =>
			deactivateGiftCodesForPurchaseInTx(tx, {
				projectId,
				purchaseId,
				reason: "refund",
				reversedAt: purchasedAt,
				actor: "provider:stripe",
			}),
		);

		expect(reversal).toBeNull();
	});

	it("refuses a gift code that is not single use or that a hosted checkout could take", async () => {
		const gift = await seedGift({ codeCount: 1 });
		const purchaseId = await purchase(gift, "pi_gift_1");
		await mint(gift, purchaseId);
		const attempt = async (
			assignment: "max_redemptions = 5" | "hosted_checkout_enabled = true",
		) => {
			try {
				if (assignment === "max_redemptions = 5") {
					await context.sql`
						UPDATE promotion_codes SET max_redemptions = 5 WHERE gift_purchase_id = ${purchaseId}
					`;
				} else {
					await context.sql`
						UPDATE promotion_codes SET hosted_checkout_enabled = true
						WHERE gift_purchase_id = ${purchaseId}
					`;
				}
				return null;
			} catch (error) {
				return (error as { errno?: string; code?: string }).errno ?? "unknown";
			}
		};

		expect(await attempt("max_redemptions = 5")).toBe("23514");
		expect(await attempt("hosted_checkout_enabled = true")).toBe("23514");
	});
});
