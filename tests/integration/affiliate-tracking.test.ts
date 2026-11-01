import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { RecordGooglePurchaseProjectionInput } from "../../src/db/repository/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const day = 86_400_000;
const start = new Date("2026-06-01T00:00:00.000Z");
let context: LocalPostgresContext;

function project(key = "acme") {
	return integrationProjectContext(key);
}

function affiliates() {
	return context.repository.affiliates;
}

async function priceStoreProducts(input: { currency: string; amount: number }): Promise<void> {
	await context.sql`
		UPDATE store_products
		SET currency = ${input.currency}, price_amount = ${input.amount}
		WHERE project_id = ${project().projectInstanceId}
			AND provider IN ('apple', 'google')
			AND external_product_id = 'premium_monthly'
	`;
}

async function recordApple(
	billingAccountId: string,
	transaction: string,
	input: { purchasedAt: Date; expiresAt: Date; trial?: boolean },
): Promise<void> {
	await context.repository.recordStoreKitTransactionAndEnqueueProjection(project(), {
		billingAccountId,
		appAccountToken: null,
		channel: "ios",
		externalProductId: "premium_monthly",
		purchaseKind: "subscription",
		transactionId: transaction,
		originalTransactionId: `${billingAccountId}_original`,
		webOrderLineItemId: `${transaction}_line`,
		purchaseStatus: "completed",
		subscriptionStatus: "active",
		purchasedAt: input.purchasedAt,
		expiresAt: input.expiresAt,
		trialStart: input.trial === true ? input.purchasedAt : null,
		trialEnd: input.trial === true ? input.expiresAt : null,
		autoRenew: true,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: { fixture: transaction },
		eventType: "SUBSCRIBED",
		externalEventId: `${transaction}_event`,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${transaction}:projection`,
	});
}

function googlePurchase(
	billingAccountId: string,
	input: { eventType: string; eventId: string; expiresAt: Date; trial?: boolean },
): RecordGooglePurchaseProjectionInput {
	const token = `${billingAccountId}_token`;
	return {
		billingAccountId,
		obfuscatedAccountId: null,
		externalProductId: "premium_monthly",
		externalPriceId: "monthly-base",
		purchaseKind: "subscription",
		purchaseToken: token,
		linkedPurchaseToken: null,
		orderId: `GPA.${input.eventId}`,
		purchaseStatus: "completed",
		subscriptionStatus: "active",
		// Play's startTime: every renewal of one token reports the same start.
		purchasedAt: start,
		expiresAt: input.expiresAt,
		trialStart: input.trial === true ? start : null,
		trialEnd: input.trial === true ? input.expiresAt : null,
		autoRenew: true,
		acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
		consumptionState: null,
		quantity: 1,
		refundableQuantity: null,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: { fixture: input.eventId },
		eventType: input.eventType,
		externalEventId: input.eventId,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${input.eventId}:projection`,
	};
}

async function customerId(billingAccountId: string): Promise<string> {
	await context.sql`
		INSERT INTO customers (project_id, billing_account_id)
		VALUES (${project().projectInstanceId}, ${billingAccountId})
		ON CONFLICT (project_id, billing_account_id) DO NOTHING
	`;
	const [row] = await context.sql<Array<{ id: string }>>`
		SELECT id FROM customers
		WHERE project_id = ${project().projectInstanceId} AND billing_account_id = ${billingAccountId}
	`;
	if (row === undefined) throw new Error("customer was not created");
	return row.id;
}

async function insertInvoice(
	id: string,
	billingAccountId: string,
	input: { status?: string; amountPaid: number; reversed?: number; currency?: string },
): Promise<void> {
	await context.sql`
		INSERT INTO billing_invoices (
			project_id, customer_id, external_invoice_id, status, amount_paid, reversed_amount, currency,
			paid_at, provider_created_at
		) VALUES (
			${project().projectInstanceId}, ${await customerId(billingAccountId)}, ${id},
			${input.status ?? "paid"}, ${input.amountPaid}, ${input.reversed ?? 0},
			${input.currency ?? "usd"}, ${start.toISOString()}, ${start.toISOString()}
		)
	`;
}

async function insertPurchase(
	transactionId: string,
	billingAccountId: string,
	input: {
		provider: "stripe" | "paddle";
		amountPaid: number;
		currency: string;
		reversed?: number;
		originalTransactionId?: string;
		status?: string;
	},
): Promise<void> {
	await context.sql`
		INSERT INTO purchases (
			project_id, customer_id, product_id, provider, channel, purchase_kind, transaction_id,
			original_transaction_id, status, amount_paid_minor, reversed_amount, currency
		)
		SELECT
			${project().projectInstanceId}, ${await customerId(billingAccountId)}, products.id,
			${input.provider}, 'web', 'consumable', ${transactionId},
			${input.originalTransactionId ?? null}, ${input.status ?? "completed"}, ${input.amountPaid},
			${input.reversed ?? 0}, ${input.currency}
		FROM products
		WHERE products.project_id = ${project().projectInstanceId} AND products.key = 'echo_credits_10'
	`;
}

localDescribe("affiliate tracking", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await priceStoreProducts({ currency: "USD", amount: 999 });
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("keeps the first key and ignores a later one", async () => {
		await customerId("alice");
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "alice",
			affiliateKey: "acme-partner",
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "alice",
			affiliateKey: "globex-partner",
		});

		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).customers).toBe(1);
		expect((await affiliates().getAffiliateSummary(project(), "globex-partner")).customers).toBe(0);
	});

	it("does nothing for an account that does not exist", async () => {
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "nobody",
			affiliateKey: "acme-partner",
		});
		expect(await affiliates().getAffiliateSummary(project(), "acme-partner")).toEqual({
			affiliateKey: "acme-partner",
			customers: 0,
			revenue: [],
		});
	});

	it("keeps keys and totals inside one project", async () => {
		await customerId("alice");
		await insertInvoice("in_alice", "alice", { amountPaid: 2000 });
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "alice",
			affiliateKey: "acme-partner",
		});

		const other = project("globex");
		expect(await affiliates().getAffiliateSummary(other, "acme-partner")).toEqual({
			affiliateKey: "acme-partner",
			customers: 0,
			revenue: [],
		});
		expect(
			(await affiliates().listAffiliateCustomers(other, "acme-partner", page())).items,
		).toEqual([]);
		await affiliates().recordAffiliateKey(other, {
			billingAccountId: "alice",
			affiliateKey: "globex-partner",
		});
		const [row] = await context.sql<Array<{ affiliate_key: string }>>`
			SELECT affiliate_key FROM customers
			WHERE project_id = ${project().projectInstanceId} AND billing_account_id = 'alice'
		`;
		expect(row?.affiliate_key).toBe("acme-partner");
	});

	it("estimates Apple revenue as the catalog price per transaction, without a free trial", async () => {
		await recordApple("apple_user", "1000", {
			purchasedAt: start,
			expiresAt: new Date(start.getTime() + 7 * day),
			trial: true,
		});
		await recordApple("apple_user", "1001", {
			purchasedAt: new Date(start.getTime() + 7 * day),
			expiresAt: new Date(start.getTime() + 37 * day),
		});
		await recordApple("apple_user", "1002", {
			purchasedAt: new Date(start.getTime() + 37 * day),
			expiresAt: new Date(start.getTime() + 67 * day),
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "apple_user",
			affiliateKey: "acme-partner",
		});

		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).revenue).toEqual([
			{ provider: "apple", currency: "usd", payments: 2, amountMinor: 1998, estimated: true },
		]);
	});

	it("counts the first Google purchase and each renewal once", async () => {
		const record = (input: Parameters<typeof googlePurchase>[1]) =>
			context.repository.recordGooglePurchaseAndEnqueueProjection(
				project(),
				googlePurchase("google_user", input),
			);
		const firstExpiry = new Date(start.getTime() + 30 * day);
		const secondExpiry = new Date(start.getTime() + 60 * day);
		const thirdExpiry = new Date(start.getTime() + 90 * day);
		await record({ eventType: "purchase_verified", eventId: "first", expiresAt: firstExpiry });
		await record({
			eventType: "SUBSCRIPTION_RENEWED",
			eventId: "renewal-1",
			expiresAt: secondExpiry,
		});
		await record({
			eventType: "SUBSCRIPTION_RENEWED",
			eventId: "renewal-1",
			expiresAt: secondExpiry,
		});
		await record({
			eventType: "SUBSCRIPTION_RECOVERED",
			eventId: "renewal-2",
			expiresAt: thirdExpiry,
		});
		await record({
			eventType: "SUBSCRIPTION_RESTARTED",
			eventId: "restarted",
			expiresAt: thirdExpiry,
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "google_user",
			affiliateKey: "acme-partner",
		});

		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).revenue).toEqual([
			{ provider: "google", currency: "usd", payments: 3, amountMinor: 2997, estimated: true },
		]);
	});

	it("does not count a free Google trial as a payment", async () => {
		const record = (input: Parameters<typeof googlePurchase>[1]) =>
			context.repository.recordGooglePurchaseAndEnqueueProjection(
				project(),
				googlePurchase("trial_user", input),
			);
		const trialEnd = new Date(start.getTime() + 7 * day);
		await record({
			eventType: "purchase_verified",
			eventId: "trial",
			expiresAt: trialEnd,
			trial: true,
		});
		await record({
			eventType: "SUBSCRIPTION_RENEWED",
			eventId: "after-trial",
			expiresAt: new Date(start.getTime() + 37 * day),
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "trial_user",
			affiliateKey: "acme-partner",
		});

		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).revenue).toEqual([
			{ provider: "google", currency: "usd", payments: 1, amountMinor: 999, estimated: true },
		]);
	});

	it("drops a refunded Google subscription's purchase from the count", async () => {
		await context.repository.recordGooglePurchaseAndEnqueueProjection(
			project(),
			googlePurchase("refunded_user", {
				eventType: "purchase_verified",
				eventId: "refunded-first",
				expiresAt: new Date(start.getTime() + 30 * day),
			}),
		);
		await context.repository.recordGoogleVoidedPurchaseAndEnqueueProjection(project(), {
			purchaseToken: "refunded_user_token",
			orderId: "GPA.refunded-first",
			refundType: 1,
			quantity: null,
			refundableQuantity: null,
			eventTime: new Date(start.getTime() + day),
			rawPayload: { fixture: "voided" },
			eventType: "VOIDED_PURCHASE",
			externalEventId: "voided",
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: "voided:projection",
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "refunded_user",
			affiliateKey: "acme-partner",
		});

		expect(await affiliates().getAffiliateSummary(project(), "acme-partner")).toEqual({
			affiliateKey: "acme-partner",
			customers: 1,
			revenue: [],
		});
	});

	it("reports real Stripe and Paddle amounts net of refunds, by currency", async () => {
		await insertInvoice("in_paid", "web_user", { amountPaid: 2000 });
		await insertInvoice("in_partly_refunded", "web_user", { amountPaid: 3000, reversed: 1000 });
		await insertInvoice("in_refunded", "web_user", { amountPaid: 500, reversed: 500 });
		await insertInvoice("in_open", "web_user", { status: "open", amountPaid: 700 });
		await insertInvoice("in_free", "web_user", { amountPaid: 0 });
		await insertInvoice("in_eur", "web_user", { amountPaid: 1100, currency: "eur" });
		await insertPurchase("cs_one_time", "web_user", {
			provider: "stripe",
			amountPaid: 1500,
			currency: "USD",
		});
		await insertPurchase("cs_refunded", "web_user", {
			provider: "stripe",
			amountPaid: 900,
			currency: "usd",
			status: "refunded",
		});
		await insertPurchase("txn_paddle", "web_user", {
			provider: "paddle",
			amountPaid: 4200,
			currency: "EUR",
			reversed: 200,
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "web_user",
			affiliateKey: "acme-partner",
		});

		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).revenue).toEqual([
			{ provider: "paddle", currency: "eur", payments: 1, amountMinor: 4000, estimated: false },
			{ provider: "stripe", currency: "eur", payments: 1, amountMinor: 1100, estimated: false },
			{ provider: "stripe", currency: "usd", payments: 3, amountMinor: 5500, estimated: false },
		]);
	});

	it("counts an automatic top-up once, from its invoice", async () => {
		await insertInvoice("in_topup", "topup_user", { amountPaid: 1000 });
		await insertPurchase("pi_topup", "topup_user", {
			provider: "stripe",
			amountPaid: 1000,
			currency: "usd",
			originalTransactionId: "in_topup",
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "topup_user",
			affiliateKey: "acme-partner",
		});

		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).revenue).toEqual([
			{ provider: "stripe", currency: "usd", payments: 1, amountMinor: 1000, estimated: false },
		]);
	});

	it("counts store payments with no amount when the product has no price", async () => {
		await context.sql`
			UPDATE store_products SET currency = NULL, price_amount = NULL
			WHERE project_id = ${project().projectInstanceId} AND provider = 'apple'
		`;
		await recordApple("unpriced_user", "2000", {
			purchasedAt: start,
			expiresAt: new Date(start.getTime() + 30 * day),
		});
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "unpriced_user",
			affiliateKey: "acme-partner",
		});

		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).revenue).toEqual([
			{ provider: "apple", currency: null, payments: 1, amountMinor: null, estimated: true },
		]);
	});

	it("keeps an erased account in the totals but out of the list", async () => {
		await insertInvoice("in_erased", "erased_user", { amountPaid: 2000 });
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "erased_user",
			affiliateKey: "acme-partner",
		});
		await context.sql`
			UPDATE customers SET billing_account_id = 'erased:1', erased_at = now()
			WHERE project_id = ${project().projectInstanceId} AND billing_account_id = 'erased_user'
		`;

		const summary = await affiliates().getAffiliateSummary(project(), "acme-partner");
		expect(summary.customers).toBe(1);
		expect(summary.revenue).toEqual([
			{ provider: "stripe", currency: "usd", payments: 1, amountMinor: 2000, estimated: false },
		]);
		expect(
			(await affiliates().listAffiliateCustomers(project(), "acme-partner", page())).items,
		).toEqual([]);
	});

	it("does not set a key on an erased account", async () => {
		await customerId("erased_user");
		await context.sql`
			UPDATE customers SET erased_at = now()
			WHERE project_id = ${project().projectInstanceId} AND billing_account_id = 'erased_user'
		`;
		await affiliates().recordAffiliateKey(project(), {
			billingAccountId: "erased_user",
			affiliateKey: "acme-partner",
		});
		expect((await affiliates().getAffiliateSummary(project(), "acme-partner")).customers).toBe(0);
	});

	it("pages through an affiliate's customers, newest first", async () => {
		for (const billingAccountId of ["first", "second", "third"]) {
			await customerId(billingAccountId);
			await affiliates().recordAffiliateKey(project(), {
				billingAccountId,
				affiliateKey: "acme-partner",
			});
		}
		const first = await affiliates().listAffiliateCustomers(project(), "acme-partner", page(2));
		expect(first.items.map((item) => item.billingAccountId)).toEqual(["third", "second"]);
		expect(first.items[0]?.affiliateKeySetAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
		expect(first.nextCursor).not.toBeNull();

		const second = await affiliates().listAffiliateCustomers(project(), "acme-partner", {
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.items.map((item) => item.billingAccountId)).toEqual(["first"]);
		expect(second.nextCursor).toBeNull();
	});
});

function page(limit = 25) {
	return { limit, cursor: null };
}
