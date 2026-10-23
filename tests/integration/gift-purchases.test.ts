import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AuthoredCatalogIntent } from "../../src/catalog/types";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeRefundObject,
} from "./helpers/fake-provider-clients";
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
const day = 86_400_000;
const price = 9900;
let context: LocalPostgresContext;
let revision = 1;
let giftSequence = 0;

const gift = {
	key: "gift-12m",
	name: "One year, as a gift",
	promotionKey: "voucher-12m",
	codeCount: 2,
	codeValidDays: 365,
	providerBindings: [
		{ productKey: "gift_12m", provider: "stripe" as const, channel: "web" as const },
	],
};

async function publish(catalog: AuthoredCatalogIntent): Promise<void> {
	const preview = await context.repository.previewCatalog(project, {
		expectedRevision: revision,
		actor: "gift-purchases",
		catalog,
	});
	await context.repository.publishCatalog(project, {
		expectedRevision: revision,
		actor: "gift-purchases",
		previewToken: preview.previewToken,
		catalog,
	});
	revision += 1;
}

/** A published gift: the catalog, a plan grant promotion, and a credit-free Stripe product. */
async function seedGift(): Promise<void> {
	await publishAiCreditsCatalog(context.repository);
	revision = 1;
	await context.repository.promotions.createPromotion(project, {
		key: "voucher-12m",
		name: "Voucher",
		effect: { kind: "plan_grant", planKey: "premium", durationUnit: "month", durationCount: 12 },
		actor: "operator",
	});
	const [product] = await context.sql<Array<{ id: string }>>`
		INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type)
		VALUES (${projectId}, 'gift_12m', 'gift_12m', 0, 'One year, as a gift', 'consumable')
		RETURNING id
	`;
	await context.sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id, external_price_id,
			billing_period, currency, price_amount
		)
		VALUES (${projectId}, ${product?.id}, 'stripe', 'web', 'prod_gift_12m', 'price_gift_12m',
			'one_time', 'usd', ${price})
	`;
	await publish({ ...aiCreditsCatalog, gifts: [gift] });
}

function session(overrides: Record<string, unknown> = {}, paymentIntent = "pi_gift_1") {
	return stripeCheckoutSessionObject({
		amount_total: price,
		client_reference_id: "buyer",
		customer: "cus_buyer",
		id: `cs_gift_${paymentIntent}`,
		metadata: {
			billingAccountId: "buyer",
			externalPriceId: "price_gift_12m",
			externalProductId: "prod_gift_12m",
			productKey: "gift_12m",
			purchaseKind: "consumable",
		},
		payment_intent: {
			id: paymentIntent,
			latest_charge: `ch_${paymentIntent}`,
			metadata: { billingAccountId: "buyer" },
			object: "payment_intent",
		},
		...overrides,
	});
}

async function webhook(
	type:
		| "checkout.session.completed"
		| "checkout.session.async_payment_succeeded"
		| "refund.created",
	object: Record<string, unknown>,
	id: string,
): Promise<Response> {
	const { app } = createIntegrationApp({
		env: context.env,
		repository: context.repository,
		stripeEvent: stripeEvent(type, object, id),
	});
	return await testRequest(app, "/v1/projects/acme/webhooks/stripe", {
		method: "POST",
		headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
		body: JSON.stringify({ id, type, data: { object: {} } }),
	});
}

async function buy(paymentIntent = "pi_gift_1", overrides: Record<string, unknown> = {}) {
	giftSequence += 1;
	const response = await webhook(
		"checkout.session.completed",
		session(overrides, paymentIntent),
		`evt_gift_${giftSequence}`,
	);
	expect(response.status).toBe(200);
	return response;
}

async function refund(paymentIntent: string, amount: number, id: string): Promise<void> {
	const response = await webhook(
		"refund.created",
		stripeRefundObject({
			amount,
			charge: `ch_${paymentIntent}`,
			id: `re_${id}`,
			payment_intent: paymentIntent,
			metadata: { billingAccountId: "buyer", productKey: "gift_12m" },
		}),
		`evt_${id}`,
	);
	expect(response.status).toBe(200);
}

interface CodeRow {
	code: string;
	gift_ordinal: number;
	active: boolean;
	redeemed_count: number;
	expires_at: Date;
}

async function codes(paymentIntent = "pi_gift_1"): Promise<CodeRow[]> {
	return await context.sql<CodeRow[]>`
		SELECT c.code, c.gift_ordinal, c.active, c.redeemed_count, c.expires_at
		FROM promotion_codes c
		JOIN purchases pu ON pu.project_id = c.project_id AND pu.id = c.gift_purchase_id
		WHERE c.project_id = ${projectId} AND pu.transaction_id = ${paymentIntent}
		ORDER BY c.gift_ordinal
	`;
}

function api() {
	const { app, authHeaders } = createIntegrationApp({
		env: context.env,
		repository: context.repository,
	});
	const request = async (method: string, path: string, body?: unknown, key?: string) => {
		const response = await testRequest(app, path, {
			method,
			headers: {
				...authHeaders("acme"),
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(key === undefined ? {} : { "idempotency-key": key }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		// biome-ignore lint/suspicious/noExplicitAny: test responses are asserted field by field
		return { status: response.status, body: (await response.json()) as any };
	};
	return {
		redeem: (account: string, code: string, key: string) =>
			request(
				"POST",
				`/v1/billing-accounts/${account}/promotion-redemptions`,
				{ code, channel: "web" },
				key,
			),
		get: (path: string) => request("GET", path),
		previewProduct: (productKey: string) =>
			request("POST", "/v1/billing-accounts/buyer/commercial-actions/preview", {
				intent: { kind: "checkout_product", productKey },
			}),
	};
}

localDescribe("Gift purchases integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedGift();
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("blocks feature retirement while a redeemed gift still grants its pinned plan", async () => {
		await buy();
		const [code] = await codes();
		expect(code).toBeDefined();
		const redeemed = await api().redeem("recipient", code?.code ?? "", "redeem-gift");
		expect(redeemed.status).toBe(200);
		expect(redeemed.body.data).toMatchObject({ kind: "plan_granted", duplicate: false });
		await expect(
			context.repository.previewCatalog(project, {
				expectedRevision: revision,
				actor: "gift-purchases",
				catalog: {
					features: aiCreditsCatalog.features.filter((feature) => feature.key !== "ai_credits"),
					plans: [],
					topups: [],
					rateCards: [],
					gifts: [],
					retiredFeatureKeys: ["ai_credits"],
					retiredPlanKeys: ["premium"],
					retiredTopupKeys: ["ai_credits_10"],
					retiredGiftKeys: [gift.key],
				},
			}),
		).rejects.toMatchObject({
			code: "FEATURE_RETIREMENT_BLOCKED",
			status: 409,
			details: {
				featureKey: "ai_credits",
				holders: [
					{ kind: "plan_grant", origin: "promotion", planKey: "premium", planVersion: 1, count: 1 },
				],
			},
		});
		expect(
			await context.repository.usageApi.check(project, {
				billingAccountId: "recipient",
				featureId: "ai_credits",
				value: "1",
			}),
		).toMatchObject({ allowed: true });
	});

	it("mints a purchase's codes once, however many events report it completed", async () => {
		await buy();

		const minted = await codes();
		expect(minted.map((row) => row.gift_ordinal)).toEqual([1, 2]);
		expect(new Set(minted.map((row) => row.code)).size).toBe(2);
		const [purchase] = await context.sql<Array<{ purchased_at: Date; kind: string }>>`
			SELECT purchased_at, purchase_kind AS kind FROM purchases
			WHERE project_id = ${projectId} AND transaction_id = 'pi_gift_1'
		`;
		expect(purchase?.kind).toBe("consumable");
		for (const row of minted) {
			expect(row.expires_at.getTime()).toBe((purchase?.purchased_at.getTime() ?? 0) + 365 * day);
		}
		// The buyer pays for codes, not for access.
		const entitlements = await api().get("/v1/billing-accounts/buyer/entitlements");
		expect(entitlements.body.data.entitlements).toEqual([]);

		// The same event again, then the second event Stripe sends for one asynchronous payment.
		const replay = await webhook(
			"checkout.session.completed",
			session(),
			`evt_gift_${giftSequence}`,
		);
		expect(replay.status).toBe(200);
		const settled = await webhook(
			"checkout.session.async_payment_succeeded",
			session(),
			"evt_gift_async",
		);
		expect(settled.status).toBe(200);

		expect((await codes()).map((row) => row.code)).toEqual(minted.map((row) => row.code));
		const [counts] = await context.sql<Array<{ purchases: string; gifts: string }>>`
			SELECT
				(SELECT count(*) FROM purchases WHERE project_id = ${projectId} AND transaction_id = 'pi_gift_1')::text AS purchases,
				(SELECT count(*) FROM gift_purchases WHERE project_id = ${projectId})::text AS gifts
		`;
		expect(counts).toEqual({ purchases: "1", gifts: "1" });
	});

	it("mints a code for a fully discounted purchase like any other", async () => {
		await buy("pi_gift_free", {
			amount_total: 0,
			payment_status: "no_payment_required",
			payment_intent: null,
			id: "cs_gift_free",
		});

		const [row] = await context.sql<Array<{ count: string }>>`
			SELECT count(*)::text AS count
			FROM promotion_codes c
			JOIN purchases pu ON pu.project_id = c.project_id AND pu.id = c.gift_purchase_id
			WHERE c.project_id = ${projectId} AND pu.transaction_id = 'cs_gift_free'
		`;
		expect(row?.count).toBe("2");
	});

	it("redeems like any promotion code, and a refused redemption leaves the other code valid", async () => {
		await buy();
		const [first, second] = await codes();
		const client = api();

		const redeemed = await client.redeem("reader", (first as CodeRow).code, "redeem-1");
		expect(redeemed.status).toBe(200);
		expect(redeemed.body.data).toMatchObject({ kind: "plan_granted", duplicate: false });
		const exhausted = await client.redeem("other", (first as CodeRow).code, "redeem-2");
		expect([exhausted.status, exhausted.body.error.code]).toEqual([
			409,
			"PROMOTION_CODE_EXHAUSTED",
		]);
		const held = await client.redeem("reader", (second as CodeRow).code, "redeem-3");
		expect([held.status, held.body.error.code]).toEqual([409, "PROMOTION_PLAN_GRANT_ACTIVE"]);

		expect((await codes()).map((row) => [row.redeemed_count, row.active])).toEqual([
			[1, true],
			[0, true],
		]);
	});

	it("withdraws what a full refund leaves unredeemed and keeps a redeemed code's grant", async () => {
		await buy();
		const [first, second] = await codes();
		const client = api();
		await client.redeem("reader", (first as CodeRow).code, "redeem-1");

		await refund("pi_gift_1", price, "full");

		expect(
			(await codes()).map((row) => [row.gift_ordinal, row.active, row.redeemed_count]),
		).toEqual([
			[1, true, 1],
			[2, false, 0],
		]);
		const refused = await client.redeem("friend", (second as CodeRow).code, "redeem-2");
		expect([refused.status, refused.body.error.code]).toEqual([409, "PROMOTION_CODE_INACTIVE"]);
		const entitlements = await client.get("/v1/billing-accounts/reader/entitlements");
		expect(entitlements.body.data.entitlements).toMatchObject([{ key: "premium", active: true }]);
		const [state] = await context.sql<Array<{ reason: string; status: string }>>`
			SELECT g.reversal_reason AS reason, pu.status
			FROM gift_purchases g
			JOIN purchases pu ON pu.project_id = g.project_id AND pu.id = g.purchase_id
			WHERE g.project_id = ${projectId}
		`;
		expect(state).toEqual({ reason: "refund", status: "refunded" });
	});

	it("shows the buyer each code with its status, and never who redeemed it", async () => {
		await buy();
		const [first, second] = await codes();
		const client = api();
		const gifts = async () => {
			const response = await client.get("/v1/billing-accounts/buyer/gifts");
			expect(response.status).toBe(200);
			return response.body;
		};

		const before = await gifts();
		expect(before.pagination).toEqual({ nextCursor: null });
		expect(before.data).toHaveLength(1);
		expect(before.data[0]).toMatchObject({
			productKey: "gift_12m",
			reversedAt: null,
			reversalReason: null,
		});
		expect(before.data[0].codes.map((entry: { status: string }) => entry.status)).toEqual([
			"available",
			"available",
		]);
		expect(before.data[0].codes.map((entry: { code: string }) => entry.code)).toEqual([
			(first as CodeRow).code,
			(second as CodeRow).code,
		]);

		await client.redeem("reader", (first as CodeRow).code.toLowerCase(), "redeem-1");
		const redeemed = (await gifts()).data[0].codes[0];
		expect(redeemed.status).toBe("redeemed");
		expect(redeemed.redeemedAt).toEqual(expect.any(String));
		expect(JSON.stringify(redeemed)).not.toContain("reader");
		expect(Object.keys(redeemed).sort()).toEqual(["code", "expiresAt", "redeemedAt", "status"]);

		await refund("pi_gift_1", price, "full");
		const after = (await gifts()).data[0];
		expect(after.codes.map((entry: { status: string }) => entry.status)).toEqual([
			"redeemed",
			"deactivated",
		]);
		expect(after.reversalReason).toBe("refund");
		expect(after.reversedAt).toEqual(expect.any(String));
	});

	it("marks a code expired once its validity elapsed, and pages purchases newest first", async () => {
		await buy("pi_gift_1");
		await buy("pi_gift_2");
		await context.sql`
			UPDATE promotion_codes SET expires_at = now() - interval '1 day'
			WHERE project_id = ${projectId} AND gift_ordinal = 1
				AND gift_purchase_id = (
					SELECT id FROM purchases WHERE project_id = ${projectId} AND transaction_id = 'pi_gift_1'
				)
		`;
		const client = api();

		const first = await client.get("/v1/billing-accounts/buyer/gifts?limit=1");
		const second = await client.get(
			`/v1/billing-accounts/buyer/gifts?limit=1&cursor=${first.body.pagination.nextCursor}`,
		);

		expect(first.body.data).toHaveLength(1);
		expect(second.body.data).toHaveLength(1);
		expect(second.body.pagination.nextCursor).toBeNull();
		const older = second.body.data[0];
		expect(older.codes.map((entry: { status: string }) => entry.status)).toEqual([
			"expired",
			"available",
		]);
		expect(first.body.data[0].purchaseId).not.toBe(older.purchaseId);
		const empty = await client.get("/v1/billing-accounts/nobody/gifts");
		expect(empty.body).toEqual({ success: true, data: [], pagination: { nextCursor: null } });
	});

	it("lists a gift's codes for an operator by where they came from", async () => {
		await buy();
		await context.repository.promotions.addPromotionCodes(
			project,
			"voucher-12m",
			[{ code: "OPERATOR-CODE" }],
			"operator",
		);

		const gifted = await context.repository.promotions.listPromotionCodes(project, "voucher-12m", {
			limit: 10,
			source: "gift",
		});
		const operator = await context.repository.promotions.listPromotionCodes(
			project,
			"voucher-12m",
			{
				limit: 10,
				source: "operator",
			},
		);

		expect(gifted.items.map((entry) => entry.gift?.ordinal).sort()).toEqual([1, 2]);
		expect(gifted.items.every((entry) => entry.createdBy === "system:gift-purchase")).toBe(true);
		expect(operator.items.map((entry) => [entry.code, entry.gift])).toEqual([
			["OPERATOR-CODE", null],
		]);
	});

	it("changes no code when the refund is partial", async () => {
		await buy();

		await refund("pi_gift_1", 1000, "partial");

		expect((await codes()).map((row) => row.active)).toEqual([true, true]);
		const [state] = await context.sql<Array<{ reversed_at: Date | null; reversed_amount: string }>>`
			SELECT g.reversed_at, pu.reversed_amount::text
			FROM gift_purchases g
			JOIN purchases pu ON pu.project_id = g.project_id AND pu.id = g.purchase_id
			WHERE g.project_id = ${projectId}
		`;
		expect(state).toEqual({ reversed_at: null, reversed_amount: "1000" });
	});

	it("sells a gift only while it is in the catalog, and still completes a checkout in flight", async () => {
		const client = api();
		expect((await client.previewProduct("gift_12m")).status).toBe(200);
		const listed = await client.get("/v1/catalog");
		expect(listed.body.data.oneTimePurchases).toContainEqual({
			key: "gift_12m",
			name: "One year, as a gift",
			kind: "gift",
			currency: "USD",
			amountMinor: price,
			credits: 0,
		});

		await publish({ ...aiCreditsCatalog, retiredGiftKeys: ["gift-12m"] });

		const refused = await client.previewProduct("gift_12m");
		expect([refused.status, refused.body.error.code]).toEqual([
			409,
			"PRODUCT_NOT_PURCHASABLE_VIA_STRIPE",
		]);
		const after = await client.get("/v1/catalog");
		expect(
			after.body.data.oneTimePurchases.some((entry: { key: string }) => entry.key === "gift_12m"),
		).toBe(false);
		await buy();
		expect(await codes()).toHaveLength(2);
	});

	it("refuses to archive a promotion a gift sells or a sold code still depends on", async () => {
		const archive = async () => {
			try {
				await context.repository.promotions.archivePromotion(project, "voucher-12m", "operator");
				return "archived";
			} catch (error) {
				return (error as { code?: string }).code ?? "unknown";
			}
		};
		expect(await archive()).toBe("PROMOTION_HAS_ACTIVE_GIFTS");

		await publish({ ...aiCreditsCatalog, retiredGiftKeys: ["gift-12m"] });
		await buy();
		expect(await archive()).toBe("PROMOTION_HAS_ACTIVE_GIFTS");

		await refund("pi_gift_1", price, "full");
		expect(await archive()).toBe("archived");
	});
});
