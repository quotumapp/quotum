import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { EntitlementSnapshot, ProjectionPayload } from "../../src/billing/types";
import { createGoogleObfuscatedAccountId } from "../../src/providers/google/account-link";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	expectCustomer,
	expectProjectionJob,
	expectStoreEvent,
	expectTableCounts,
} from "./helpers/db-assertions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const googleVoidedEventId =
	"google:voided:purchase_token_1:1780185600000:2:1:GPA.1111-2222-3333-44444";
let context: LocalPostgresContext;

localDescribe("Google route flows integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("creates Google account links through the route", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const expectedAccountId = googleAccountId("integration_user");

		const response = await app.request(
			"/v1/billing-accounts/integration_user/providers/google/account-link",
			{
				headers: authHeaders("voysee"),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: { obfuscatedAccountId: expectedAccountId },
		});
		expect(google.calls).toEqual([]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			store_events: 0,
			projection_sync_jobs: 0,
		});
		await expectProviderCustomerRow(context.sql, {
			billingAccountId: "integration_user",
			provider: "google",
			externalCustomerId: expectedAccountId,
		});
	});

	it("verifies Google subscriptions and acknowledges them", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const expectedAccountId = googleAccountId("integration_user");

		const response = await withIsoDateSqlParameters(() =>
			verifyGoogleSubscription(app, authHeaders),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expectActivePremiumSnapshot(body.data, "integration_user", "google", "android");
		expect(google.calls).toEqual([
			"getSubscriptionPurchase:purchase_token_1",
			`acknowledgeSubscriptionPurchase:premium_monthly:purchase_token_1:${expectedAccountId}`,
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectGoogleSubscriptionRows(context.sql, {
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			entitlementActive: true,
		});
		const storeEvent = await expectStoreEvent(context.sql, {
			provider: "google",
			eventType: "purchase_verified",
			status: "processed",
		});
		expect(storeEvent.processing_error).toBeNull();
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe("google:purchase_token_1:purchase_verified");
		expect(projectionJob.payload.purchase).toBeUndefined();
	});

	it("verifies Google consumables and consumes them", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await withIsoDateSqlParameters(() => verifyGoogleConsumable(app, authHeaders));
		const body = await response.json();

		expect(response.status).toBe(200);
		expectEmptySnapshot(body.data, "integration_user");
		expect(google.calls).toEqual([
			"getProductPurchase:purchase_token_1",
			"consumeProductPurchase:echo_credits_10:purchase_token_1",
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectGoogleConsumableRows(context.sql, { purchaseStatus: "completed" });
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe("google:purchase_token_1:purchase_verified");
		expectProjectionPurchase(projectionJob.payload, {
			transactionId: "purchase_token_1",
			totalCreditAmount: 10,
			quantity: 1,
			refundableQuantity: 1,
		});
	});

	it("maps a Google consumable to the published top-up allocation", async () => {
		await publishAiCreditsCatalog(context.repository);
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const response = await withIsoDateSqlParameters(() => verifyGoogleConsumable(app, authHeaders));

		expect(response.status).toBe(200);
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "10", available: "10" });
		const [allocation] = await context.sql<
			Array<{ source_kind: string; purchase_id: string | null; expires_at: Date | null }>
		>`
			SELECT source_kind, purchase_id, expires_at
			FROM balance_allocations
		`;
		expect(allocation).toMatchObject({
			source_kind: "topup",
			purchase_id: expect.any(String),
			expires_at: expect.any(Date),
		});
	});

	it("never emits a consumable credit grant for a canceled Google purchase", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			googleRtdn: "one_time",
		});
		const purchase = await withIsoDateSqlParameters(() => verifyGoogleConsumable(app, authHeaders));
		google.setProductPurchaseState("CANCELLED");

		const response = await withIsoDateSqlParameters(() => postGoogleRtdn(app));

		expect(purchase.status).toBe(200);
		expect(response.status).toBe(200);
		expect(google.calls).toEqual([
			"getProductPurchase:purchase_token_1",
			"consumeProductPurchase:echo_credits_10:purchase_token_1",
			"getProductPurchase:purchase_token_1",
		]);
		await expectGoogleConsumableRows(context.sql, {
			purchaseStatus: "voided",
			invalidationReason: "canceled",
		});
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "provider_webhook",
			status: "pending",
		});
		expect(projectionJob.payload.purchase).toBeUndefined();
		expect(projectionJob.payload.reversal).toBeUndefined();
	});

	it("handles Google RTDN subscription notifications without billing API-key auth", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const expectedAccountId = googleAccountId("integration_user");
		await createGoogleAccountLink(app, authHeaders);

		const response = await withIsoDateSqlParameters(() => postGoogleRtdn(app));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.processed).toBe(true);
		expect(body.data.eventType).toBe("SUBSCRIPTION_PURCHASED");
		expect(body.data.messageId).toBe("message_1");
		expectActivePremiumSnapshot(body.data.entitlements, "integration_user", "google", "android");
		expect(google.calls).toEqual([
			"getSubscriptionPurchase:purchase_token_1",
			`acknowledgeSubscriptionPurchase:premium_monthly:purchase_token_1:${expectedAccountId}`,
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		const event = await expectStoreEvent(context.sql, {
			provider: "google",
			eventType: "SUBSCRIPTION_PURCHASED",
			status: "processed",
		});
		expect(event.processing_error).toBeNull();
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "provider_webhook",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe("google:message_1:projection");
		await expectGoogleWebhookRows(context.sql, {
			eventType: "SUBSCRIPTION_PURCHASED",
			externalEventId: "google:message_1",
			transactionId: "purchase_token_1",
			projectionIdempotencyKey: "google:message_1:projection",
		});
	});

	it("handles Google one-time product RTDNs using the catalog purchase kind", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			googleRtdn: "one_time",
		});
		await createGoogleAccountLink(app, authHeaders);

		const response = await withIsoDateSqlParameters(() => postGoogleRtdn(app));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.processed).toBe(true);
		expect(body.data.eventType).toBe("ONE_TIME_PRODUCT_PURCHASED");
		expect(body.data.messageId).toBe("message_product");
		expectEmptySnapshot(body.data.entitlements, "integration_user");
		expect(google.calls).toEqual([
			"getProductPurchase:purchase_token_1",
			"consumeProductPurchase:echo_credits_10:purchase_token_1",
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectGoogleConsumableRows(context.sql, { purchaseStatus: "completed" });
		await expectGoogleWebhookRows(context.sql, {
			eventType: "ONE_TIME_PRODUCT_PURCHASED",
			externalEventId: "google:message_product",
			transactionId: "purchase_token_1",
			projectionIdempotencyKey: "google:message_product:projection",
		});
	});

	it("records Google voided purchase RTDNs after an earlier purchase", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			googleRtdn: "voided",
		});

		const purchase = await withIsoDateSqlParameters(() => verifyGoogleConsumable(app, authHeaders));
		const voided = await withIsoDateSqlParameters(() => postGoogleRtdn(app));
		const body = await voided.json();

		expect(purchase.status).toBe(200);
		expect(voided.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.processed).toBe(true);
		expect(body.data.eventType).toBe("VOIDED_PURCHASE");
		expect(body.data.messageId).toBe("message_voided");
		expectEmptySnapshot(body.data.entitlements, "integration_user");
		expect(google.calls).toEqual([
			"getProductPurchase:purchase_token_1",
			"consumeProductPurchase:echo_credits_10:purchase_token_1",
			"getProductPurchase:purchase_token_1",
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 2,
			projection_sync_jobs: 2,
		});
		await expectGoogleConsumableRows(context.sql, { purchaseStatus: "voided" });
		const event = await expectStoreEvent(context.sql, {
			provider: "google",
			eventType: "VOIDED_PURCHASE",
			status: "processed",
		});
		expect(event.processing_error).toBeNull();
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "provider_webhook",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe(`${googleVoidedEventId}:projection`);
		expect(projectionJob.payload.purchase).toBeUndefined();
		expect(projectionJob.payload.reversal).toEqual({
			provider: "google",
			channel: "android",
			reason: "refund",
			transactionId: googleVoidedEventId,
			originalTransactionId: "purchase_token_1",
			productKey: "echo_credits_10",
			creditAmount: 10,
			totalCreditAmount: 10,
			quantity: 1,
			reversedAt: "2026-05-31T00:00:00.000Z",
		});
		await expectGoogleVoidedPurchaseRows(context.sql);
	});

	it("reverses Google multi-quantity consumables incrementally across partial and full refunds", async () => {
		await publishAiCreditsCatalog(context.repository);
		const first = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			googleRtdn: "voided",
			googleProductQuantity: 3,
			googleVoidedRefundType: 2,
			googleVoidedEventTimeMillis: "1780185601000",
		});
		await withIsoDateSqlParameters(() => verifyGoogleConsumable(first.app, first.authHeaders));
		first.google.setRefundableQuantity(2);
		await withIsoDateSqlParameters(() => postGoogleRtdn(first.app));

		await expectGoogleReversalState(context.sql, {
			status: "completed",
			reversedQuantity: "1",
			reversedCreditAmount: 10,
		});
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "20", available: "20" });
		await expectGoogleReversalProjection(
			context.sql,
			"google:voided:purchase_token_1:1780185601000:2:2:GPA.1111-2222-3333-44444",
			1,
			10,
		);

		const second = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			googleRtdn: "voided",
			googleProductQuantity: 3,
			googleProductRefundableQuantity: 1,
			googleVoidedRefundType: 2,
			googleVoidedEventTimeMillis: "1780185602000",
		});
		await withIsoDateSqlParameters(() => postGoogleRtdn(second.app));
		await expectGoogleReversalState(context.sql, {
			status: "completed",
			reversedQuantity: "2",
			reversedCreditAmount: 20,
		});
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "10", available: "10" });

		const final = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			googleRtdn: "voided",
			googleProductQuantity: 3,
			googleProductRefundableQuantity: 0,
			googleVoidedRefundType: 1,
			googleVoidedEventTimeMillis: "1780185603000",
		});
		await withIsoDateSqlParameters(() => postGoogleRtdn(final.app));
		await expectGoogleReversalState(context.sql, {
			status: "voided",
			reversedQuantity: "3",
			reversedCreditAmount: 30,
		});
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "0", available: "0" });
	});

	it("does not void Google purchases when a voided RTDN token mismatches an existing order id", async () => {
		const mismatchedVoidedEventId =
			"google:voided:purchase_token_mismatch:1780185600000:2:1:GPA.1111-2222-3333-44444";
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			googleRtdn: "voided",
			googleVoidedPurchaseToken: "purchase_token_mismatch",
		});

		const purchase = await withIsoDateSqlParameters(() => verifyGoogleConsumable(app, authHeaders));
		const voided = await withIsoDateSqlParameters(() => postGoogleRtdn(app));
		const body = await voided.json();

		expect(purchase.status).toBe(200);
		expect(voided.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data).toEqual({
			processed: false,
			eventType: "VOIDED_PURCHASE",
			messageId: "message_voided",
			entitlements: null,
		});
		expect(google.calls).toEqual([
			"getProductPurchase:purchase_token_1",
			"consumeProductPurchase:echo_credits_10:purchase_token_1",
			"getProductPurchase:purchase_token_mismatch",
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 2,
			projection_sync_jobs: 1,
		});
		await expectGoogleConsumableRows(context.sql, { purchaseStatus: "completed" });
		const event = await expectStoreEvent(context.sql, {
			provider: "google",
			eventType: "VOIDED_PURCHASE",
			status: "skipped",
		});
		expect(event.external_event_id).toBe(mismatchedVoidedEventId);
		expect(event.processing_error).toBe("Google Play voided purchase target could not be resolved");
	});

	it("rejects Google one-time verification without productId before provider work", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				...authHeaders("voysee"),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "google",
				billingAccountId: "integration_user",
				purchaseKind: "consumable",
				purchaseToken: "purchase_token_1",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid purchase verification body" },
		});
		expect(google.calls).toEqual([]);
		await expectTableCounts(context.sql, {
			customers: 0,
			provider_customers: 0,
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			store_events: 0,
			projection_sync_jobs: 0,
		});
	});
});

function googleAccountId(billingAccountId: string): string {
	return createGoogleObfuscatedAccountId(billingAccountId, "google-account-link-secret");
}

async function createGoogleAccountLink(
	app: ReturnType<typeof createIntegrationApp>["app"],
	authHeaders: ReturnType<typeof createIntegrationApp>["authHeaders"],
): Promise<string> {
	const response = await app.request(
		"/v1/billing-accounts/integration_user/providers/google/account-link",
		{
			headers: authHeaders("voysee"),
		},
	);
	const body = await response.json();
	expect(response.status).toBe(200);
	return body.data.obfuscatedAccountId;
}

async function verifyGoogleSubscription(
	app: ReturnType<typeof createIntegrationApp>["app"],
	authHeaders: ReturnType<typeof createIntegrationApp>["authHeaders"],
): Promise<Response> {
	return await app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...authHeaders("voysee"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "google",
			billingAccountId: "integration_user",
			purchaseKind: "subscription",
			purchaseToken: "purchase_token_1",
		}),
	});
}

async function verifyGoogleConsumable(
	app: ReturnType<typeof createIntegrationApp>["app"],
	authHeaders: ReturnType<typeof createIntegrationApp>["authHeaders"],
): Promise<Response> {
	return await app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...authHeaders("voysee"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "google",
			billingAccountId: "integration_user",
			purchaseKind: "consumable",
			purchaseToken: "purchase_token_1",
			productId: "echo_credits_10",
		}),
	});
}

async function postGoogleRtdn(
	app: ReturnType<typeof createIntegrationApp>["app"],
): Promise<Response> {
	return await app.request("/v1/projects/voysee/webhooks/google", {
		method: "POST",
		headers: {
			authorization: "Bearer pubsub-token",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			message: {
				data: "eyJpbnRlZ3JhdGlvbiI6dHJ1ZX0=",
				messageId: "message_1",
			},
			subscription: "projects/integration/subscriptions/billing",
		}),
	});
}

function expectEmptySnapshot(snapshot: EntitlementSnapshot, billingAccountId: string): void {
	expect(snapshot).toEqual({
		billingAccountId,
		generatedAt: expect.any(String),
		entitlements: [],
	});
}

function expectActivePremiumSnapshot(
	snapshot: EntitlementSnapshot,
	billingAccountId: string,
	provider: string,
	channel: string,
): void {
	expect(snapshot.billingAccountId).toBe(billingAccountId);
	expect(snapshot.generatedAt).toEqual(expect.any(String));
	expect(snapshot.entitlements).toHaveLength(1);
	expect(snapshot.entitlements[0]).toEqual({
		key: "premium",
		active: true,
		expiresAt: "2099-06-30T00:00:00.000Z",
		metadata: expect.objectContaining({
			channel,
			provider,
			source: "subscription",
			status: "active",
		}),
	});
}

function expectProjectionPurchase(
	payload: ProjectionPayload,
	expected: {
		transactionId: string;
		totalCreditAmount: number;
		quantity: number;
		refundableQuantity: number;
	},
): void {
	expect(payload.purchase).toEqual({
		provider: "google",
		channel: "android",
		purchaseKind: "consumable",
		transactionId: expected.transactionId,
		productKey: "echo_credits_10",
		creditAmount: 10,
		totalCreditAmount: expected.totalCreditAmount,
		quantity: expected.quantity,
		refundableQuantity: expected.refundableQuantity,
		purchasedAt: "2026-05-31T00:00:00.000Z",
	});
}

async function expectGoogleReversalState(
	sql: SQL,
	expected: {
		status: string;
		reversedQuantity: string;
		reversedCreditAmount: number;
	},
): Promise<void> {
	const rows = await sql<
		{
			status: string;
			reversed_quantity: string;
			reversed_credit_amount: number;
		}[]
	>`
		SELECT status,
			reversed_amount::text AS reversed_quantity,
			reversed_credit_amount
		FROM purchases
		WHERE provider = 'google'
			AND transaction_id = 'purchase_token_1'
	`;

	expect(rows).toEqual([
		{
			status: expected.status,
			reversed_quantity: expected.reversedQuantity,
			reversed_credit_amount: expected.reversedCreditAmount,
		},
	]);
}

async function expectGoogleReversalProjection(
	sql: SQL,
	externalEventId: string,
	quantity: number,
	creditAmount: number,
): Promise<void> {
	const rows = await sql<{ reversal: ProjectionPayload["reversal"] }[]>`
		SELECT payload->'reversal' AS reversal
		FROM projection_sync_jobs
		WHERE idempotency_key = ${`${externalEventId}:projection`}
	`;

	expect(rows).toHaveLength(1);
	expect(rows[0]?.reversal).toMatchObject({
		provider: "google",
		channel: "android",
		reason: "refund",
		transactionId: externalEventId,
		originalTransactionId: "purchase_token_1",
		productKey: "echo_credits_10",
		creditAmount,
		totalCreditAmount: 30,
		quantity,
	});
}

async function expectProviderCustomerRow(
	sql: SQL,
	match: {
		billingAccountId: string;
		provider: string;
		externalCustomerId: string;
	},
): Promise<void> {
	const customer = await expectCustomer(sql, match.billingAccountId);
	const rows = await sql<
		{
			billing_account_id: string;
			provider: string;
			external_customer_id: string;
			project_key: string;
		}[]
	>`
		SELECT customers.billing_account_id, provider_customers.provider,
			provider_customers.external_customer_id, projects.key AS project_key
		FROM provider_customers
		JOIN customers ON customers.id = provider_customers.customer_id
			AND customers.project_id = provider_customers.project_id
		JOIN projects ON projects.id = provider_customers.project_id
		WHERE provider_customers.customer_id = ${customer.id}
			AND provider_customers.provider = ${match.provider}
	`;

	expect(rows).toEqual([
		{
			billing_account_id: match.billingAccountId,
			provider: match.provider,
			external_customer_id: match.externalCustomerId,
			project_key: "voysee",
		},
	]);
}

async function expectGoogleSubscriptionRows(
	sql: SQL,
	expected: {
		purchaseStatus: string;
		subscriptionStatus: string;
		entitlementActive: boolean;
	},
): Promise<void> {
	const rows = await sql<
		{
			billing_account_id: string;
			purchase_status: string;
			purchase_kind: string;
			transaction_id: string;
			subscription_status: string;
			external_subscription_id: string;
			external_price_id: string | null;
			entitlement_key: string;
			entitlement_active: boolean;
		}[]
	>`
		SELECT customers.billing_account_id,
			purchases.status AS purchase_status,
			purchases.purchase_kind,
			purchases.transaction_id,
			subscriptions.status AS subscription_status,
			subscriptions.external_subscription_id,
			subscriptions.external_price_id,
			entitlements.entitlement_key,
			entitlements.active AS entitlement_active
		FROM purchases
		JOIN customers ON customers.id = purchases.customer_id
			AND customers.project_id = purchases.project_id
		JOIN subscriptions ON subscriptions.id = purchases.subscription_id
			AND subscriptions.project_id = purchases.project_id
		JOIN entitlements ON entitlements.source_subscription_id = subscriptions.id
			AND entitlements.project_id = subscriptions.project_id
		JOIN projects ON projects.id = purchases.project_id
		WHERE projects.key = 'voysee'
			AND purchases.provider = 'google'
	`;

	expect(rows).toEqual([
		{
			billing_account_id: "integration_user",
			purchase_status: expected.purchaseStatus,
			purchase_kind: "subscription",
			transaction_id: "purchase_token_1",
			subscription_status: expected.subscriptionStatus,
			external_subscription_id: "purchase_token_1",
			external_price_id: "monthly-base",
			entitlement_key: "premium",
			entitlement_active: expected.entitlementActive,
		},
	]);
}

async function expectGoogleConsumableRows(
	sql: SQL,
	expected: { purchaseStatus: string; invalidationReason?: string },
): Promise<void> {
	const rows = await sql<
		{
			billing_account_id: string;
			purchase_status: string;
			purchase_kind: string;
			transaction_id: string;
			original_transaction_id: string | null;
			invalidated_at: string | null;
			invalidation_reason: string | null;
			product_key: string;
			credit_amount: number;
		}[]
	>`
		SELECT customers.billing_account_id,
			purchases.status AS purchase_status,
			purchases.purchase_kind,
			purchases.transaction_id,
			purchases.original_transaction_id,
			purchases.invalidated_at::text AS invalidated_at,
			purchases.invalidation_reason,
			products.key AS product_key,
			products.credit_amount
		FROM purchases
		JOIN customers ON customers.id = purchases.customer_id
			AND customers.project_id = purchases.project_id
		JOIN products ON products.id = purchases.product_id
			AND products.project_id = purchases.project_id
		JOIN projects ON projects.id = purchases.project_id
		WHERE projects.key = 'voysee'
			AND purchases.provider = 'google'
			AND purchases.purchase_kind = 'consumable'
	`;

	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		billing_account_id: "integration_user",
		purchase_status: expected.purchaseStatus,
		purchase_kind: "consumable",
		transaction_id: "purchase_token_1",
		original_transaction_id: null,
		product_key: "echo_credits_10",
		credit_amount: 10,
	});
	if (expected.purchaseStatus === "voided") {
		expect(rows[0].invalidated_at).toEqual(expect.any(String));
		expect(rows[0].invalidation_reason).toBe(expected.invalidationReason ?? "voided_purchase");
	} else {
		expect(rows[0].invalidated_at).toBeNull();
		expect(rows[0].invalidation_reason).toBeNull();
	}
}

async function expectGoogleWebhookRows(
	sql: SQL,
	expected: {
		eventType: string;
		externalEventId: string;
		transactionId: string;
		projectionIdempotencyKey: string;
	},
): Promise<void> {
	const rows = await sql<
		{
			external_event_id: string | null;
			event_type: string;
			transaction_id: string | null;
			processing_status: string;
			projection_idempotency_key: string;
			projection_reason: string;
			projection_payload_billing_account_id: string | null;
		}[]
	>`
		SELECT store_events.external_event_id,
			store_events.event_type,
			store_events.transaction_id,
			store_events.processing_status,
			projection_sync_jobs.idempotency_key AS projection_idempotency_key,
			projection_sync_jobs.reason AS projection_reason,
			projection_sync_jobs.payload->>'billingAccountId' AS projection_payload_billing_account_id
		FROM store_events
		JOIN projection_sync_jobs ON projection_sync_jobs.project_id = store_events.project_id
			AND projection_sync_jobs.idempotency_key = ${expected.projectionIdempotencyKey}
		JOIN projects ON projects.id = store_events.project_id
		WHERE projects.key = 'voysee'
			AND store_events.provider = 'google'
			AND store_events.external_event_id = ${expected.externalEventId}
	`;

	expect(rows).toEqual([
		{
			external_event_id: expected.externalEventId,
			event_type: expected.eventType,
			transaction_id: expected.transactionId,
			processing_status: "processed",
			projection_idempotency_key: expected.projectionIdempotencyKey,
			projection_reason: "provider_webhook",
			projection_payload_billing_account_id: "integration_user",
		},
	]);
}

async function expectGoogleVoidedPurchaseRows(sql: SQL): Promise<void> {
	await expectGoogleWebhookRows(context.sql, {
		eventType: "VOIDED_PURCHASE",
		externalEventId: googleVoidedEventId,
		transactionId: "purchase_token_1",
		projectionIdempotencyKey: `${googleVoidedEventId}:projection`,
	});

	const rows = await sql<
		{
			event_type: string;
			raw_order_id: string | null;
			raw_refund_type: number | null;
		}[]
	>`
		SELECT event_type,
			raw_payload->'voidedPurchaseNotification'->>'orderId' AS raw_order_id,
			(raw_payload->'voidedPurchaseNotification'->>'refundType')::int AS raw_refund_type
		FROM store_events
		JOIN projects ON projects.id = store_events.project_id
		WHERE projects.key = 'voysee'
			AND store_events.provider = 'google'
			AND store_events.external_event_id = ${googleVoidedEventId}
	`;

	expect(rows).toEqual([
		{
			event_type: "VOIDED_PURCHASE",
			raw_order_id: "GPA.1111-2222-3333-44444",
			raw_refund_type: 1,
		},
	]);
}

// Pass-through: the repository now serializes all Date SQL params as ISO (src/db/repository.ts),
// so the integration suite exercises the real serialization instead of patching Date.
async function withIsoDateSqlParameters<T>(callback: () => T | Promise<T>): Promise<T> {
	return await callback();
}
