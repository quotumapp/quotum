import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { EntitlementSnapshot, ProjectionPayload } from "../../src/billing/types";
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
let context: LocalPostgresContext;

localDescribe("Apple route flows integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("creates Apple account tokens through the route", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await app.request(
			"/v1/billing-accounts/integration_user/providers/apple/account-token",
			{
				headers: authHeaders("voysee"),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			success: true,
			data: { appAccountToken: expect.stringMatching(uuidPattern) },
		});
		expect(apple.calls).toEqual([]);
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
			provider: "apple",
			externalCustomerId: body.data.appAccountToken,
		});
	});

	it("verifies Apple subscriptions and persists durable billing state", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createAppleAccountToken(app, authHeaders, apple);

		const response = await withIsoDateSqlParameters(() =>
			verifyAppleSubscription(app, authHeaders),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expectActivePremiumSnapshot(body.data, "integration_user", "apple", "ios");
		expect(apple.calls).toEqual(["verifyTransaction:200000000000001"]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectApplePurchaseRows(context.sql, {
			eventCount: "1",
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			entitlementActive: true,
		});
		const storeEvent = await expectStoreEvent(context.sql, {
			provider: "apple",
			eventType: "purchase_verified",
			status: "processed",
		});
		expect(storeEvent.processing_error).toBeNull();
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe("apple:200000000000001:purchase_verified");
		expect(projectionJob.payload.purchase).toBeUndefined();
	});

	it("materializes catalog subscription and top-up allocations exactly once", async () => {
		await publishAiCreditsCatalog(context.repository);
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createAppleAccountToken(app, authHeaders, apple);
		await withIsoDateSqlParameters(() => verifyAppleSubscription(app, authHeaders));
		const [catalogState] = await context.sql<
			Array<{
				bindings: number;
				subscriptions_bound: number;
				allocations: number;
				subscription_store: string;
				binding_stores: string[];
			}>
		>`
			SELECT
				(SELECT count(*)::integer FROM provider_plan_bindings) AS bindings,
				(SELECT count(*)::integer FROM subscriptions WHERE plan_version_id IS NOT NULL) AS subscriptions_bound,
				(SELECT count(*)::integer FROM balance_allocations) AS allocations,
				(SELECT store_product_id::text FROM subscriptions LIMIT 1) AS subscription_store,
				(SELECT array_agg(store_product_id::text ORDER BY store_product_id::text) FROM provider_plan_bindings) AS binding_stores
		`;
		if (catalogState.allocations !== 1) throw new Error(JSON.stringify(catalogState));
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "1000", available: "1000" });
		const topupInput = {
			billingAccountId: "integration_user",
			appAccountToken: null,
			channel: "ios" as const,
			externalProductId: "echo_credits_10",
			purchaseKind: "consumable" as const,
			transactionId: "apple_catalog_topup_1",
			originalTransactionId: null,
			webOrderLineItemId: null,
			purchaseStatus: "completed" as const,
			subscriptionStatus: null,
			purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
			expiresAt: null,
			autoRenew: null,
			invalidatedAt: null,
			invalidationReason: null,
			rawPayload: { transactionId: "apple_catalog_topup_1" },
			eventType: "ONE_TIME_CHARGE",
			externalEventId: "apple_catalog_topup_event_1",
			projectionReason: "provider_webhook" as const,
			projectionIdempotencyKey: "apple:catalog-topup:1",
		};
		await context.repository.recordStoreKitTransactionAndEnqueueProjection(
			integrationProjectContext(),
			topupInput,
		);
		await context.repository.recordStoreKitTransactionAndEnqueueProjection(
			integrationProjectContext(),
			topupInput,
		);

		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "1010", available: "1010" });
		const allocations = await context.sql<
			Array<{
				source_kind: string;
				quantity: string;
				plan_item_id: string | null;
				purchase_id: string | null;
			}>
		>`
			SELECT source_kind, quantity::text, plan_item_id::text, purchase_id
			FROM balance_allocations
			ORDER BY source_kind
		`;
		expect(allocations).toEqual([
			expect.objectContaining({ source_kind: "subscription", quantity: "1000.000000000" }),
			expect.objectContaining({ source_kind: "topup", quantity: "10.000000000" }),
		]);
	});

	it("handles Apple renewal webhooks without API-key auth", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createAppleAccountToken(app, authHeaders, apple);

		const response = await withIsoDateSqlParameters(() =>
			app.request("/v1/projects/voysee/webhooks/apple", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ signedPayload: "signed-notification" }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.status).toBe("processed");
		expectActivePremiumSnapshot(body.data.entitlements, "integration_user", "apple", "ios");
		expect(apple.calls).toEqual(["verifyNotification:signed-notification"]);
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
			provider: "apple",
			eventType: "DID_RENEW",
			status: "processed",
		});
		expect(event.processing_error).toBeNull();
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "provider_webhook",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe(
			"apple:00000000-0000-0000-0000-000000000001:projection",
		);
		await expectAppleWebhookRows(context.sql);
	});

	it("records Apple consumable invalidations as reversal projection context", async () => {
		const purchasedAt = new Date("2026-05-31T00:00:00.000Z");
		const invalidatedAt = new Date("2026-06-01T00:00:00.000Z");

		await withIsoDateSqlParameters(() =>
			context.repository.recordStoreKitTransactionAndEnqueueProjection(
				integrationProjectContext(),
				{
					billingAccountId: "integration_user",
					appAccountToken: null,
					channel: "ios",
					externalProductId: "echo_credits_10",
					purchaseKind: "consumable",
					transactionId: "apple_consumable_1",
					originalTransactionId: null,
					webOrderLineItemId: null,
					purchaseStatus: "completed",
					subscriptionStatus: null,
					purchasedAt,
					expiresAt: null,
					autoRenew: null,
					invalidatedAt: null,
					invalidationReason: null,
					rawPayload: { transactionId: "apple_consumable_1", event: "purchase" },
					eventType: "ONE_TIME_CHARGE",
					externalEventId: "apple_event_purchase",
					projectionReason: "provider_webhook",
					projectionIdempotencyKey: "apple:apple_consumable_1:purchase",
				},
			),
		);
		await withIsoDateSqlParameters(() =>
			context.repository.recordStoreKitTransactionAndEnqueueProjection(
				integrationProjectContext(),
				{
					billingAccountId: null,
					appAccountToken: null,
					channel: "ios",
					externalProductId: "echo_credits_10",
					purchaseKind: "consumable",
					transactionId: "apple_consumable_1",
					originalTransactionId: null,
					webOrderLineItemId: null,
					purchaseStatus: "refunded",
					subscriptionStatus: null,
					purchasedAt,
					expiresAt: null,
					autoRenew: null,
					invalidatedAt,
					invalidationReason: "refund",
					rawPayload: { transactionId: "apple_consumable_1", event: "refund" },
					eventType: "REFUND",
					externalEventId: "apple_event_refund",
					projectionReason: "provider_webhook",
					projectionIdempotencyKey: "apple:apple_consumable_1:refund",
				},
			),
		);

		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 0,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 2,
			projection_sync_jobs: 2,
		});
		const projectionJob = await expectProjectionJobByKey(
			context.sql,
			"apple:apple_consumable_1:refund",
		);
		expect(projectionJob.payload.purchase).toBeUndefined();
		expect(projectionJob.payload.reversal).toEqual({
			provider: "apple",
			channel: "ios",
			reason: "refund",
			transactionId: "apple_consumable_1",
			originalTransactionId: "apple_consumable_1",
			productKey: "echo_credits_10",
			creditAmount: 10,
			totalCreditAmount: 10,
			quantity: 1,
			reversedAt: "2026-06-01T00:00:00.000Z",
		});
	});

	it("restores durable Apple subscription and purchase state after REFUND_REVERSED", async () => {
		const purchasedAt = new Date("2026-05-31T00:00:00.000Z");
		const expiresAt = new Date("2099-06-30T00:00:00.000Z");
		const invalidatedAt = new Date("2026-06-01T00:00:00.000Z");
		const base = {
			appAccountToken: null,
			channel: "ios" as const,
			externalProductId: "premium_monthly",
			purchaseKind: "subscription" as const,
			transactionId: "200000000000001",
			originalTransactionId: "100000000000001",
			webOrderLineItemId: "100000000000001_line",
			purchasedAt,
			expiresAt,
			autoRenew: true,
			projectionReason: "provider_webhook" as const,
		};

		await context.repository.recordStoreKitTransactionAndEnqueueProjection(
			integrationProjectContext(),
			{
				...base,
				billingAccountId: "integration_user",
				purchaseStatus: "completed",
				subscriptionStatus: "active",
				invalidatedAt: null,
				invalidationReason: null,
				rawPayload: { event: "purchase" },
				eventType: "purchase_verified",
				externalEventId: "apple_purchase_event",
				projectionIdempotencyKey: "apple:purchase",
			},
		);
		await context.repository.recordStoreKitTransactionAndEnqueueProjection(
			integrationProjectContext(),
			{
				...base,
				billingAccountId: null,
				purchaseStatus: "refunded",
				subscriptionStatus: "refunded",
				invalidatedAt,
				invalidationReason: "refund",
				rawPayload: { event: "refund" },
				eventType: "REFUND",
				externalEventId: "apple_refund_event",
				projectionIdempotencyKey: "apple:refund",
			},
		);
		await context.repository.recordStoreKitTransactionAndEnqueueProjection(
			integrationProjectContext(),
			{
				...base,
				billingAccountId: null,
				purchaseStatus: "completed",
				subscriptionStatus: "active",
				invalidatedAt: null,
				invalidationReason: null,
				rawPayload: { event: "refund_reversed" },
				eventType: "REFUND_REVERSED",
				externalEventId: "apple_refund_reversed_event",
				projectionIdempotencyKey: "apple:refund_reversed",
			},
		);

		await expectApplePurchaseRows(context.sql, {
			eventCount: "3",
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			entitlementActive: true,
		});
		const invalidation = await context.sql<
			{ invalidated_at: string | null; invalidation_reason: string | null }[]
		>`SELECT invalidated_at::text, invalidation_reason FROM purchases WHERE provider = 'apple'`;
		expect(invalidation).toEqual([{ invalidated_at: null, invalidation_reason: null }]);
	});

	it("keeps Apple verification idempotent for duplicate transactions", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createAppleAccountToken(app, authHeaders, apple);

		const first = await withIsoDateSqlParameters(() => verifyAppleSubscription(app, authHeaders));
		const second = await withIsoDateSqlParameters(() => verifyAppleSubscription(app, authHeaders));

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(apple.calls).toEqual([
			"verifyTransaction:200000000000001",
			"verifyTransaction:200000000000001",
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
		await expectApplePurchaseRows(context.sql, {
			eventCount: "1",
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			entitlementActive: true,
		});
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe("apple:200000000000001:purchase_verified");
	});

	it("rejects Apple account-token mismatches without durable purchase writes", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
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
				provider: "apple",
				billingAccountId: "integration_user",
				transactionId: "200000000000001",
			}),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "STOREKIT_ACCOUNT_TOKEN_MISMATCH",
				message: "StoreKit transaction app account token does not match customer",
			},
		});
		expect(apple.calls).toEqual(["verifyTransaction:200000000000001"]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			store_events: 0,
			projection_sync_jobs: 0,
		});
	});

	it("rejects Apple purchases that only carry matching renewal app account tokens", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const appAccountToken = await createAppleAccountToken(app, authHeaders, apple);
		apple.setTransactionAppAccountToken(undefined);
		apple.setRenewalAppAccountToken(appAccountToken);

		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				...authHeaders("voysee"),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "apple",
				billingAccountId: "integration_user",
				transactionId: "200000000000001",
			}),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "STOREKIT_ACCOUNT_TOKEN_MISMATCH",
				message: "StoreKit transaction app account token does not match customer",
			},
		});
		expect(apple.calls).toEqual(["verifyTransaction:200000000000001"]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			store_events: 0,
			projection_sync_jobs: 0,
		});
	});
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createAppleAccountToken(
	app: ReturnType<typeof createIntegrationApp>["app"],
	authHeaders: ReturnType<typeof createIntegrationApp>["authHeaders"],
	apple: ReturnType<typeof createIntegrationApp>["apple"],
): Promise<string> {
	const response = await app.request(
		"/v1/billing-accounts/integration_user/providers/apple/account-token",
		{
			headers: authHeaders("voysee"),
		},
	);
	const body = await response.json();
	expect(response.status).toBe(200);
	apple.setAppAccountToken(body.data.appAccountToken);
	return body.data.appAccountToken;
}

async function verifyAppleSubscription(
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
			provider: "apple",
			billingAccountId: "integration_user",
			transactionId: "200000000000001",
		}),
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

async function expectApplePurchaseRows(
	sql: SQL,
	expected: {
		eventCount: string;
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
			original_transaction_id: string | null;
			subscription_status: string;
			external_subscription_id: string;
			entitlement_key: string;
			entitlement_active: boolean;
			store_event_count: string;
		}[]
	>`
		SELECT customers.billing_account_id,
			purchases.status AS purchase_status,
			purchases.purchase_kind,
			purchases.transaction_id,
			purchases.original_transaction_id,
			subscriptions.status AS subscription_status,
			subscriptions.external_subscription_id,
			entitlements.entitlement_key,
			entitlements.active AS entitlement_active,
			(
				SELECT count(*)::text
				FROM store_events
				WHERE store_events.project_id = purchases.project_id
					AND store_events.provider = 'apple'
					AND store_events.transaction_id = purchases.transaction_id
			) AS store_event_count
		FROM purchases
		JOIN customers ON customers.id = purchases.customer_id
			AND customers.project_id = purchases.project_id
		JOIN subscriptions ON subscriptions.id = purchases.subscription_id
			AND subscriptions.project_id = purchases.project_id
		JOIN entitlements ON entitlements.source_subscription_id = subscriptions.id
			AND entitlements.project_id = subscriptions.project_id
		JOIN projects ON projects.id = purchases.project_id
		WHERE projects.key = 'voysee'
			AND purchases.provider = 'apple'
	`;

	expect(rows).toEqual([
		{
			billing_account_id: "integration_user",
			purchase_status: expected.purchaseStatus,
			purchase_kind: "subscription",
			transaction_id: "200000000000001",
			original_transaction_id: "100000000000001",
			subscription_status: expected.subscriptionStatus,
			external_subscription_id: "100000000000001",
			entitlement_key: "premium",
			entitlement_active: expected.entitlementActive,
			store_event_count: expected.eventCount,
		},
	]);
}

async function expectAppleWebhookRows(sql: SQL): Promise<void> {
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
		JOIN projects ON projects.id = store_events.project_id
		WHERE projects.key = 'voysee'
			AND store_events.provider = 'apple'
			AND store_events.external_event_id = '00000000-0000-0000-0000-000000000001'
	`;

	expect(rows).toEqual([
		{
			external_event_id: "00000000-0000-0000-0000-000000000001",
			event_type: "DID_RENEW",
			transaction_id: "200000000000001",
			processing_status: "processed",
			projection_idempotency_key: "apple:00000000-0000-0000-0000-000000000001:projection",
			projection_reason: "provider_webhook",
			projection_payload_billing_account_id: "integration_user",
		},
	]);
}

async function expectProjectionJobByKey(
	sql: SQL,
	idempotencyKey: string,
): Promise<{ idempotency_key: string; payload: ProjectionPayload }> {
	const rows = await sql<
		{
			idempotency_key: string;
			payload: ProjectionPayload;
		}[]
	>`
		SELECT projection_sync_jobs.idempotency_key, projection_sync_jobs.payload
		FROM projection_sync_jobs
		JOIN projects ON projects.id = projection_sync_jobs.project_id
		WHERE projects.key = 'voysee'
			AND projection_sync_jobs.idempotency_key = ${idempotencyKey}
	`;

	expect(rows).toHaveLength(1);
	return rows[0];
}

// Pass-through: the repository now serializes all Date SQL params as ISO (src/db/repository.ts),
// so the integration suite exercises the real serialization instead of patching Date.
async function withIsoDateSqlParameters<T>(callback: () => T | Promise<T>): Promise<T> {
	return await callback();
}
