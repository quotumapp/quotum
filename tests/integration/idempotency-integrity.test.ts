import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type {
	BillingProvider,
	ProjectionPayload,
	ProjectionSyncReason,
	ProjectionSyncStatus,
} from "../../src/billing/types";
import type {
	RecordPurchaseProjectionInput,
	RecordStripeSubscriptionProjectionInput,
} from "../../src/db/repository";
import { createGoogleObfuscatedAccountId } from "../../src/providers/google/account-link";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectProjectionJob, expectTableCounts } from "./helpers/db-assertions";
import {
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeSubscriptionObject,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("billing idempotency and integrity integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("does not duplicate Apple purchase state for repeated transaction verification", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createAppleAccountToken(fixture);

		const first = await withIsoDateSqlParameters(() => verifyAppleSubscription(fixture));
		const second = await withIsoDateSqlParameters(() => verifyAppleSubscription(fixture));

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectProviderScopedPurchases(context.sql, "apple", "200000000000001", [
			{
				billing_account_id: "integration_user",
				project_key: "voysee",
				purchase_kind: "subscription",
				status: "completed",
				transaction_id: "200000000000001",
			},
		]);
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe("apple:200000000000001:purchase_verified");
	});

	it("does not duplicate Google purchase state for repeated tokens", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const first = await withIsoDateSqlParameters(() =>
			verifyGoogleConsumable(fixture, "purchase_token_repeat"),
		);
		const second = await withIsoDateSqlParameters(() =>
			verifyGoogleConsumable(fixture, "purchase_token_repeat"),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectProviderScopedPurchases(context.sql, "google", "purchase_token_repeat", [
			{
				billing_account_id: "integration_user",
				project_key: "voysee",
				purchase_kind: "consumable",
				status: "completed",
				transaction_id: "purchase_token_repeat",
			},
		]);
		await expectStoreEventsByExternalId(
			context.sql,
			"google",
			"google:purchase_token_repeat:purchase_verified",
			[
				{
					billing_account_id: "integration_user",
					event_type: "purchase_verified",
					external_event_id: "google:purchase_token_repeat:purchase_verified",
					project_key: "voysee",
					processing_status: "processed",
					transaction_id: "purchase_token_repeat",
				},
			],
		);
		await expectProjectionJobsByKey(context.sql, "google:purchase_token_repeat:purchase_verified", [
			{
				billing_account_id: "integration_user",
				idempotency_key: "google:purchase_token_repeat:purchase_verified",
				project_key: "voysee",
				reason: "purchase_verified",
				status: "pending",
			},
		]);
	});

	it("does not duplicate Google RTDN state for repeated message ids", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createGoogleAccountLink(fixture, "integration_user");

		const first = await withIsoDateSqlParameters(() =>
			postGoogleRtdn(fixture, "voysee", "message_1"),
		);
		const second = await withIsoDateSqlParameters(() =>
			postGoogleRtdn(fixture, "voysee", "message_1"),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectProviderScopedPurchases(context.sql, "google", "purchase_token_1", [
			{
				billing_account_id: "integration_user",
				project_key: "voysee",
				purchase_kind: "subscription",
				status: "completed",
				transaction_id: "purchase_token_1",
			},
		]);
		await expectStoreEventsByExternalId(context.sql, "google", "google:message_1", [
			{
				billing_account_id: "integration_user",
				event_type: "SUBSCRIPTION_PURCHASED",
				external_event_id: "google:message_1",
				project_key: "voysee",
				processing_status: "processed",
				transaction_id: "purchase_token_1",
			},
		]);
		await expectProjectionJobsByKey(context.sql, "google:message_1:projection", [
			{
				billing_account_id: "integration_user",
				idempotency_key: "google:message_1:projection",
				project_key: "voysee",
				reason: "provider_webhook",
				status: "pending",
			},
		]);
	});

	it("does not duplicate Stripe state for repeated event ids", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"customer.subscription.updated",
				stripeSubscriptionObject(),
				"evt_subscription_repeat",
			),
		});

		const first = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_subscription_repeat" }),
		);
		const second = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_subscription_repeat" }),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectStoreEventsByExternalId(context.sql, "stripe", "evt_subscription_repeat", [
			{
				billing_account_id: "integration_user",
				event_type: "customer.subscription.updated",
				external_event_id: "evt_subscription_repeat",
				project_key: "voysee",
				processing_status: "processed",
				transaction_id: "in_integration",
			},
		]);
		await expectProjectionJobsByKey(
			context.sql,
			"stripe:subscription:sub_1:customer.subscription.updated:evt_subscription_repeat:projection",
			[
				{
					billing_account_id: "integration_user",
					idempotency_key:
						"stripe:subscription:sub_1:customer.subscription.updated:evt_subscription_repeat:projection",
					project_key: "voysee",
					reason: "provider_webhook",
					status: "pending",
				},
			],
		);
	});

	it("does not let stale subscription events regress newer entitlement state", async () => {
		const newer = await withIsoDateSqlParameters(() =>
			context.repository.recordStripeSubscriptionAndEnqueueProjection(
				{ projectKey: "voysee" },
				stripeSubscriptionProjectionInput({
					billingAccountId: "monotonic_subscription_user",
					stripeSubscriptionId: "sub_monotonic",
					stripeCustomerId: "cus_monotonic",
					invoiceId: "in_newer",
					subscriptionStatus: "active",
					purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
					startsAt: new Date("2026-06-01T00:00:00.000Z"),
					expiresAt: new Date("2099-08-01T00:00:00.000Z"),
					externalEventId: "evt_subscription_newer",
					projectionIdempotencyKey:
						"stripe:subscription:sub_monotonic:newer:evt_subscription_newer:projection",
				}),
			),
		);
		const stale = await withIsoDateSqlParameters(() =>
			context.repository.recordStripeSubscriptionAndEnqueueProjection(
				{ projectKey: "voysee" },
				stripeSubscriptionProjectionInput({
					billingAccountId: null,
					stripeSubscriptionId: "sub_monotonic",
					stripeCustomerId: "cus_monotonic",
					invoiceId: "in_older",
					subscriptionStatus: "expired",
					purchasedAt: new Date("2026-05-01T00:00:00.000Z"),
					startsAt: new Date("2026-05-01T00:00:00.000Z"),
					expiresAt: new Date("2099-07-01T00:00:00.000Z"),
					externalEventId: "evt_subscription_older",
					projectionIdempotencyKey:
						"stripe:subscription:sub_monotonic:older:evt_subscription_older:projection",
				}),
			),
		);

		expect(newer.processingStatus).toBe("processed");
		expect(stale.processingStatus).toBe("processed");
		await expectStripeSubscriptionState(context.sql, {
			billingAccountId: "monotonic_subscription_user",
			externalSubscriptionId: "sub_monotonic",
			status: "active",
			expiresAt: "2099-08-01T00:00:00.000Z",
			latestTransactionId: "in_newer",
		});
		expect(stale.entitlements).toMatchObject({
			billingAccountId: "monotonic_subscription_user",
			entitlements: [
				{
					key: "premium",
					active: true,
					expiresAt: "2099-08-01T00:00:00.000Z",
					metadata: expect.objectContaining({
						source: "subscription",
						status: "active",
					}),
				},
			],
		});
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 1,
			entitlements: 1,
			store_events: 2,
			projection_sync_jobs: 2,
		});
	});

	it("does not let stale completed purchases overwrite refunded durable state", async () => {
		const storeProductId = await seedNonConsumableStoreProduct(context.sql);
		const purchasedAt = new Date("2026-06-01T00:00:00.000Z");

		await withIsoDateSqlParameters(() =>
			context.repository.recordPurchaseAndEnqueueProjection(
				{ projectKey: "voysee" },
				purchaseProjectionInput({
					billingAccountId: "monotonic_purchase_user",
					storeProductId,
					transactionId: "txn_monotonic",
					status: "completed",
					purchasedAt,
					eventType: "purchase.completed",
					externalEventId: "evt_purchase_completed",
					projectionIdempotencyKey: "manual:txn_monotonic:completed",
				}),
			),
		);
		await withIsoDateSqlParameters(() =>
			context.repository.recordPurchaseAndEnqueueProjection(
				{ projectKey: "voysee" },
				purchaseProjectionInput({
					billingAccountId: "monotonic_purchase_user",
					storeProductId,
					transactionId: "txn_monotonic",
					status: "refunded",
					purchasedAt,
					eventType: "purchase.refunded",
					externalEventId: "evt_purchase_refunded",
					projectionIdempotencyKey: "manual:txn_monotonic:refunded",
				}),
			),
		);
		const stale = await withIsoDateSqlParameters(() =>
			context.repository.recordPurchaseAndEnqueueProjection(
				{ projectKey: "voysee" },
				purchaseProjectionInput({
					billingAccountId: "monotonic_purchase_user",
					storeProductId,
					transactionId: "txn_monotonic",
					status: "completed",
					purchasedAt: new Date("2026-05-31T00:00:00.000Z"),
					eventType: "purchase.completed",
					externalEventId: "evt_purchase_completed_stale",
					projectionIdempotencyKey: "manual:txn_monotonic:completed_stale",
				}),
			),
		);

		await expectPurchaseState(context.sql, {
			billingAccountId: "monotonic_purchase_user",
			transactionId: "txn_monotonic",
			status: "refunded",
			purchasedAt: "2026-06-01T00:00:00.000Z",
		});
		expect(stale).toMatchObject({
			billingAccountId: "monotonic_purchase_user",
			entitlements: [
				{
					key: "premium",
					active: false,
					expiresAt: null,
				},
			],
		});
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 0,
			purchases: 1,
			subscriptions: 0,
			entitlements: 1,
			store_events: 3,
			projection_sync_jobs: 3,
		});
	});

	it("does not apply duplicate provider events while the existing store event is processing", async () => {
		const externalEventId = "evt_processing_duplicate";
		const eventId = await seedProcessingStripeStoreEvent(context.sql, {
			externalEventId,
			eventType: "checkout.session.completed",
		});
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					id: "cs_processing_duplicate",
					payment_intent: {
						id: "pi_processing_duplicate",
						latest_charge: "ch_processing_duplicate",
						metadata: { billingAccountId: "integration_user" },
					},
					charge: "ch_processing_duplicate",
					latest_charge: "ch_processing_duplicate",
				}),
				externalEventId,
			),
		});

		const response = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: externalEventId }),
		);

		expect(response.status).toBe(200);
		await expectTableCounts(context.sql, {
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			projection_sync_jobs: 0,
			store_events: 1,
		});
		await expectProcessingStripeStoreEventUnchanged(context.sql, eventId);
	});

	it("does not duplicate Stripe purchases or projections for repeated payment intent ids", async () => {
		const firstFixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					id: "cs_payment_intent_first",
					payment_intent: {
						id: "pi_payment_intent_repeat",
						latest_charge: "ch_payment_intent_repeat",
						metadata: { billingAccountId: "integration_user" },
					},
					charge: "ch_payment_intent_repeat",
					latest_charge: "ch_payment_intent_repeat",
				}),
				"evt_payment_intent_first",
			),
		});
		const secondFixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					id: "cs_payment_intent_second",
					payment_intent: {
						id: "pi_payment_intent_repeat",
						latest_charge: "ch_payment_intent_repeat",
						metadata: { billingAccountId: "integration_user" },
					},
					charge: "ch_payment_intent_repeat",
					latest_charge: "ch_payment_intent_repeat",
				}),
				"evt_payment_intent_second",
			),
		});

		const first = await withIsoDateSqlParameters(() =>
			postStripeWebhook(firstFixture, { id: "evt_payment_intent_first" }),
		);
		const second = await withIsoDateSqlParameters(() =>
			postStripeWebhook(secondFixture, { id: "evt_payment_intent_second" }),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 2,
			projection_sync_jobs: 1,
		});
		await expectProviderScopedPurchases(context.sql, "stripe", "pi_payment_intent_repeat", [
			{
				billing_account_id: "integration_user",
				project_key: "voysee",
				purchase_kind: "consumable",
				status: "completed",
				transaction_id: "pi_payment_intent_repeat",
			},
		]);
		await expectStoreEventsByExternalId(context.sql, "stripe", "evt_payment_intent_first", [
			{
				billing_account_id: "integration_user",
				event_type: "checkout.session.completed",
				external_event_id: "evt_payment_intent_first",
				project_key: "voysee",
				processing_status: "processed",
				transaction_id: "pi_payment_intent_repeat",
			},
		]);
		await expectStoreEventsByExternalId(context.sql, "stripe", "evt_payment_intent_second", [
			{
				billing_account_id: "integration_user",
				event_type: "checkout.session.completed",
				external_event_id: "evt_payment_intent_second",
				project_key: "voysee",
				processing_status: "processed",
				transaction_id: "pi_payment_intent_repeat",
			},
		]);
		const [projectionPayload] = await expectProjectionJobsByKey(
			context.sql,
			"stripe:payment:pi_payment_intent_repeat:projection",
			[
				{
					billing_account_id: "integration_user",
					idempotency_key: "stripe:payment:pi_payment_intent_repeat:projection",
					project_key: "voysee",
					reason: "provider_webhook",
					status: "pending",
				},
			],
		);
		expect(projectionPayload.purchase?.transactionId).toBe("pi_payment_intent_repeat");
	});

	it("allows same external provider ids in different projects", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const voysee = await withIsoDateSqlParameters(() =>
			verifyGoogleConsumable(fixture, "purchase_token_cross_project", "voysee"),
		);
		const wiseley = await withIsoDateSqlParameters(() =>
			verifyGoogleConsumable(fixture, "purchase_token_cross_project", "wiseley"),
		);

		expect(voysee.status).toBe(200);
		expect(wiseley.status).toBe(200);
		await expectTableCounts(context.sql, {
			customers: 2,
			provider_customers: 2,
			purchases: 2,
			subscriptions: 0,
			entitlements: 0,
			store_events: 2,
			projection_sync_jobs: 2,
		});
		await expectProviderScopedPurchases(context.sql, "google", "purchase_token_cross_project", [
			{
				billing_account_id: "integration_user",
				project_key: "voysee",
				purchase_kind: "consumable",
				status: "completed",
				transaction_id: "purchase_token_cross_project",
			},
			{
				billing_account_id: "integration_user",
				project_key: "wiseley",
				purchase_kind: "consumable",
				status: "completed",
				transaction_id: "purchase_token_cross_project",
			},
		]);
		await expectStoreEventsByExternalId(
			context.sql,
			"google",
			"google:purchase_token_cross_project:purchase_verified",
			[
				{
					billing_account_id: "integration_user",
					event_type: "purchase_verified",
					external_event_id: "google:purchase_token_cross_project:purchase_verified",
					project_key: "voysee",
					processing_status: "processed",
					transaction_id: "purchase_token_cross_project",
				},
				{
					billing_account_id: "integration_user",
					event_type: "purchase_verified",
					external_event_id: "google:purchase_token_cross_project:purchase_verified",
					project_key: "wiseley",
					processing_status: "processed",
					transaction_id: "purchase_token_cross_project",
				},
			],
		);
		await expectProjectionJobsByKey(
			context.sql,
			"google:purchase_token_cross_project:purchase_verified",
			[
				{
					billing_account_id: "integration_user",
					idempotency_key: "google:purchase_token_cross_project:purchase_verified",
					project_key: "voysee",
					reason: "purchase_verified",
					status: "pending",
				},
				{
					billing_account_id: "integration_user",
					idempotency_key: "google:purchase_token_cross_project:purchase_verified",
					project_key: "wiseley",
					reason: "purchase_verified",
					status: "pending",
				},
			],
		);
	});

	it("fails identity mismatches without reassigning provider customers", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createGoogleAccountLink(fixture, "integration_user");
		await createGoogleAccountLink(fixture, "another_user");

		const originalResponse = await withIsoDateSqlParameters(() =>
			verifyGoogleConsumable(fixture, "purchase_token_identity_mismatch", "voysee"),
		);
		const mismatchResponse = await withIsoDateSqlParameters(() =>
			verifyGoogleConsumable(fixture, "purchase_token_identity_mismatch", "voysee", "another_user"),
		);

		expect(originalResponse.status).toBe(200);
		expect(mismatchResponse.status).toBe(409);
		expect(await mismatchResponse.json()).toEqual({
			success: false,
			error: {
				code: "GOOGLE_PLAY_ACCOUNT_ID_MISMATCH",
				message: "Google Play purchase account id does not match customer",
			},
		});
		await expectTableCounts(context.sql, {
			customers: 2,
			provider_customers: 2,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectProviderScopedPurchases(context.sql, "google", "purchase_token_identity_mismatch", [
			{
				billing_account_id: "integration_user",
				project_key: "voysee",
				purchase_kind: "consumable",
				status: "completed",
				transaction_id: "purchase_token_identity_mismatch",
			},
		]);
		await expectProviderCustomerBindings(
			context.sql,
			"google",
			googleAccountId("integration_user"),
			[
				{
					billing_account_id: "integration_user",
					external_customer_id: googleAccountId("integration_user"),
					project_key: "voysee",
					provider: "google",
				},
			],
		);
		await expectProviderCustomerBindings(context.sql, "google", googleAccountId("another_user"), [
			{
				billing_account_id: "another_user",
				external_customer_id: googleAccountId("another_user"),
				project_key: "voysee",
				provider: "google",
			},
		]);
		await expectNoGooglePurchaseRowsForBillingAccount(
			context.sql,
			"another_user",
			"purchase_token_identity_mismatch",
		);
	});
});

type Fixture = ReturnType<typeof createIntegrationApp>;

interface ProviderScopedPurchaseRow {
	billing_account_id: string;
	project_key: string;
	purchase_kind: string;
	status: string;
	transaction_id: string;
}

interface StoreEventByExternalIdRow {
	billing_account_id: string | null;
	event_type: string;
	external_event_id: string | null;
	project_key: string;
	processing_status: string;
	transaction_id: string | null;
}

interface ProjectionJobByKeyRow {
	billing_account_id: string | null;
	idempotency_key: string;
	project_key: string;
	reason: ProjectionSyncReason;
	status: ProjectionSyncStatus;
}

interface ProviderCustomerBindingRow {
	billing_account_id: string;
	external_customer_id: string;
	project_key: string;
	provider: BillingProvider;
}

interface StripeSubscriptionStateRow {
	billing_account_id: string;
	expires_at: unknown;
	latest_transaction_id: string | null;
	status: string;
}

interface PurchaseStateRow {
	billing_account_id: string;
	purchased_at: unknown;
	status: string;
}

async function createAppleAccountToken(fixture: Fixture): Promise<void> {
	const response = await fixture.app.request(
		"/v1/billing-accounts/integration_user/providers/apple/account-token",
		{
			headers: fixture.authHeaders("voysee"),
		},
	);
	const body = await response.json();

	expect(response.status).toBe(200);
	fixture.apple.setAppAccountToken(body.data.appAccountToken);
}

async function verifyAppleSubscription(fixture: Fixture): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders("voysee"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "apple",
			billingAccountId: "integration_user",
			transactionId: "200000000000001",
		}),
	});
}

async function verifyGoogleConsumable(
	fixture: Fixture,
	purchaseToken: string,
	projectKey = "voysee",
	billingAccountId = "integration_user",
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders(projectKey),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "google",
			billingAccountId,
			purchaseKind: "consumable",
			purchaseToken,
			productId: "echo_credits_10",
		}),
	});
}

async function postStripeWebhook(
	fixture: Fixture,
	body: Record<string, unknown>,
	projectKey = "voysee",
): Promise<Response> {
	return await fixture.app.request(`/v1/projects/${projectKey}/webhooks/stripe`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": "sig_test",
		},
		body: JSON.stringify(body),
	});
}

async function createGoogleAccountLink(
	fixture: Fixture,
	billingAccountId: string,
	projectKey = "voysee",
): Promise<string> {
	const response = await fixture.app.request(
		`/v1/billing-accounts/${billingAccountId}/providers/google/account-link`,
		{
			headers: fixture.authHeaders(projectKey),
		},
	);
	const body = await response.json();

	expect(response.status).toBe(200);
	return body.data.obfuscatedAccountId;
}

async function postGoogleRtdn(
	fixture: Fixture,
	projectKey = "voysee",
	messageId = "message_1",
): Promise<Response> {
	return await fixture.app.request(`/v1/projects/${projectKey}/webhooks/google`, {
		method: "POST",
		headers: {
			authorization: "Bearer pubsub-token",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			message: {
				data: "eyJpbnRlZ3JhdGlvbiI6dHJ1ZX0=",
				messageId,
			},
			subscription: "projects/integration/subscriptions/billing",
		}),
	});
}

function stripeSubscriptionProjectionInput(
	overrides: Partial<RecordStripeSubscriptionProjectionInput>,
): RecordStripeSubscriptionProjectionInput {
	return {
		billingAccountId: "integration_user",
		stripeCustomerId: "cus_integration",
		stripeSubscriptionId: "sub_integration",
		invoiceId: "in_integration",
		externalProductId: "prod_stripe_premium",
		externalPriceId: "price_premium_monthly",
		subscriptionStatus: "active",
		purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
		startsAt: new Date("2026-06-01T00:00:00.000Z"),
		expiresAt: new Date("2026-07-01T00:00:00.000Z"),
		autoRenew: true,
		rawPayload: { fixture: "stripe_subscription_projection" },
		eventType: "customer.subscription.updated",
		externalEventId: "evt_subscription_projection",
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: "stripe:subscription:sub_integration:projection",
		...overrides,
	};
}

function purchaseProjectionInput(
	overrides: Partial<RecordPurchaseProjectionInput>,
): RecordPurchaseProjectionInput {
	return {
		billingAccountId: "integration_user",
		provider: "apple",
		channel: "ios",
		storeProductId: "store_product_id",
		purchaseKind: "non_consumable",
		transactionId: "txn_integration",
		originalTransactionId: null,
		status: "completed",
		purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
		rawPayload: { fixture: "manual_purchase_projection" },
		eventType: "purchase.completed",
		externalEventId: "evt_manual_purchase",
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: "manual:txn_integration:projection",
		...overrides,
	};
}

async function seedNonConsumableStoreProduct(sql: SQL): Promise<string> {
	const rows = await sql<{ id: string }[]>`
		WITH product AS (
			INSERT INTO products (
				project_id,
				key,
				entitlement_key,
				credit_amount,
				name,
				type,
				active
			)
			SELECT projects.id, 'lifetime_unlock', 'premium', 0, 'Lifetime Unlock',
				'non_consumable', true
			FROM projects
			WHERE projects.key = 'voysee'
			RETURNING id, project_id
		)
		INSERT INTO store_products (
			project_id,
			product_id,
			provider,
			channel,
			external_product_id,
			external_price_id,
			billing_period,
			currency,
			price_amount,
			active
		)
		SELECT product.project_id, product.id, 'apple', 'ios', 'lifetime_unlock', NULL,
			'one_time', NULL, NULL, true
		FROM product
		RETURNING id
	`;

	expect(rows).toHaveLength(1);
	return rows[0].id;
}

async function expectStripeSubscriptionState(
	sql: SQL,
	expected: {
		billingAccountId: string;
		externalSubscriptionId: string;
		status: string;
		expiresAt: string;
		latestTransactionId: string;
	},
): Promise<void> {
	const rows = await sql<StripeSubscriptionStateRow[]>`
		SELECT customers.billing_account_id,
			subscriptions.status,
			subscriptions.expires_at,
			subscriptions.latest_transaction_id
		FROM subscriptions
		JOIN customers ON customers.id = subscriptions.customer_id
			AND customers.project_id = subscriptions.project_id
		WHERE subscriptions.provider = 'stripe'
			AND subscriptions.external_subscription_id = ${expected.externalSubscriptionId}
	`;

	expect(rows).toHaveLength(1);
	expect(rows[0].billing_account_id).toBe(expected.billingAccountId);
	expect(rows[0].status).toBe(expected.status);
	expect(toIsoString(rows[0].expires_at)).toBe(expected.expiresAt);
	expect(rows[0].latest_transaction_id).toBe(expected.latestTransactionId);
}

async function expectPurchaseState(
	sql: SQL,
	expected: {
		billingAccountId: string;
		transactionId: string;
		status: string;
		purchasedAt: string;
	},
): Promise<void> {
	const rows = await sql<PurchaseStateRow[]>`
		SELECT customers.billing_account_id,
			purchases.status,
			purchases.purchased_at
		FROM purchases
		JOIN customers ON customers.id = purchases.customer_id
			AND customers.project_id = purchases.project_id
		WHERE purchases.transaction_id = ${expected.transactionId}
	`;

	expect(rows).toHaveLength(1);
	expect(rows[0].billing_account_id).toBe(expected.billingAccountId);
	expect(rows[0].status).toBe(expected.status);
	expect(toIsoString(rows[0].purchased_at)).toBe(expected.purchasedAt);
}

function toIsoString(value: unknown): string {
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === "string") {
		return new Date(value).toISOString();
	}
	throw new Error(`expected database timestamp, got ${String(value)}`);
}

async function expectProviderScopedPurchases(
	sql: SQL,
	provider: BillingProvider,
	transactionId: string,
	expected: ProviderScopedPurchaseRow[],
): Promise<void> {
	const rows = await sql<ProviderScopedPurchaseRow[]>`
		SELECT customers.billing_account_id,
			projects.key AS project_key,
			purchases.purchase_kind,
			purchases.status,
			purchases.transaction_id
		FROM purchases
		JOIN customers ON customers.id = purchases.customer_id
			AND customers.project_id = purchases.project_id
		JOIN projects ON projects.id = purchases.project_id
		WHERE purchases.provider = ${provider}
			AND purchases.transaction_id = ${transactionId}
		ORDER BY projects.key
	`;

	expect(rows).toEqual([...expected].sort(byProjectKey));
}

async function expectStoreEventsByExternalId(
	sql: SQL,
	provider: BillingProvider,
	externalEventId: string,
	expected: StoreEventByExternalIdRow[],
): Promise<void> {
	const rows = await sql<StoreEventByExternalIdRow[]>`
		SELECT customers.billing_account_id,
			store_events.event_type,
			store_events.external_event_id,
			projects.key AS project_key,
			store_events.processing_status,
			store_events.transaction_id
		FROM store_events
		LEFT JOIN customers ON customers.id = store_events.customer_id
			AND customers.project_id = store_events.project_id
		JOIN projects ON projects.id = store_events.project_id
		WHERE store_events.provider = ${provider}
			AND store_events.external_event_id = ${externalEventId}
		ORDER BY projects.key
	`;

	expect(rows).toEqual([...expected].sort(byProjectKey));
}

async function expectProjectionJobsByKey(
	sql: SQL,
	idempotencyKey: string,
	expected: ProjectionJobByKeyRow[],
): Promise<ProjectionPayload[]> {
	const rows = await sql<(ProjectionJobByKeyRow & { payload: ProjectionPayload })[]>`
		SELECT jobs.payload->>'billingAccountId' AS billing_account_id,
			jobs.idempotency_key,
			projects.key AS project_key,
			jobs.reason,
			jobs.status,
			jobs.payload
		FROM projection_sync_jobs jobs
		JOIN projects ON projects.id = jobs.project_id
		WHERE jobs.idempotency_key = ${idempotencyKey}
		ORDER BY projects.key
	`;

	expect(rows.map(({ payload: _payload, ...row }) => row)).toEqual(
		[...expected].sort(byProjectKey),
	);
	return rows.map((row) => row.payload);
}

async function expectProviderCustomerBindings(
	sql: SQL,
	provider: BillingProvider,
	externalCustomerId: string,
	expected: ProviderCustomerBindingRow[],
): Promise<void> {
	const rows = await sql<ProviderCustomerBindingRow[]>`
		SELECT customers.billing_account_id,
			provider_customers.external_customer_id,
			projects.key AS project_key,
			provider_customers.provider
		FROM provider_customers
		JOIN customers ON customers.id = provider_customers.customer_id
			AND customers.project_id = provider_customers.project_id
		JOIN projects ON projects.id = provider_customers.project_id
		WHERE provider_customers.provider = ${provider}
			AND provider_customers.external_customer_id = ${externalCustomerId}
		ORDER BY projects.key, customers.billing_account_id
	`;

	expect(rows).toEqual([...expected].sort(byProjectKey));
}

async function expectNoGooglePurchaseRowsForBillingAccount(
	sql: SQL,
	billingAccountId: string,
	purchaseToken: string,
): Promise<void> {
	const rows = await sql<{ table_name: string; count: string }[]>`
		SELECT 'purchases' AS table_name, count(*)::text AS count
		FROM purchases
		JOIN customers ON customers.id = purchases.customer_id
			AND customers.project_id = purchases.project_id
		WHERE customers.billing_account_id = ${billingAccountId}
			AND purchases.provider = 'google'
			AND purchases.transaction_id = ${purchaseToken}
		UNION ALL
		SELECT 'store_events' AS table_name, count(*)::text AS count
		FROM store_events
		JOIN customers ON customers.id = store_events.customer_id
			AND customers.project_id = store_events.project_id
		WHERE customers.billing_account_id = ${billingAccountId}
			AND store_events.provider = 'google'
			AND store_events.transaction_id = ${purchaseToken}
		UNION ALL
		SELECT 'projection_sync_jobs' AS table_name, count(*)::text AS count
		FROM projection_sync_jobs
		WHERE projection_sync_jobs.payload->>'billingAccountId' = ${billingAccountId}
			AND projection_sync_jobs.idempotency_key = ${`google:${purchaseToken}:purchase_verified`}
		ORDER BY table_name
	`;

	expect(rows).toEqual([
		{ table_name: "projection_sync_jobs", count: "0" },
		{ table_name: "purchases", count: "0" },
		{ table_name: "store_events", count: "0" },
	]);
}

async function seedProcessingStripeStoreEvent(
	sql: SQL,
	input: { externalEventId: string; eventType: string },
): Promise<string> {
	const rows = await sql<{ id: string }[]>`
		INSERT INTO store_events (
			project_id,
			provider,
			channel,
			external_event_id,
			event_type,
			processing_status,
			processing_error,
			raw_payload,
			locked_at,
			locked_by,
			next_attempt_at
		)
		SELECT projects.id, 'stripe', 'web', ${input.externalEventId}, ${input.eventType},
			'processing', 'integration processing seed', ${JSON.stringify({ seeded: true })}::jsonb,
			now(), 'integration-worker', now() - INTERVAL '1 second'
		FROM projects
		WHERE projects.key = 'voysee'
		RETURNING id
	`;

	expect(rows).toHaveLength(1);
	return rows[0].id;
}

async function expectProcessingStripeStoreEventUnchanged(sql: SQL, eventId: string): Promise<void> {
	const rows = await sql<
		{
			customer_id: string | null;
			store_product_id: string | null;
			transaction_id: string | null;
			processing_status: string;
			processing_error: string | null;
			raw_payload: Record<string, unknown>;
			processed_at: string | null;
			locked_by: string | null;
		}[]
	>`
		SELECT customer_id, store_product_id, transaction_id, processing_status, processing_error,
			raw_payload, processed_at::text AS processed_at, locked_by
		FROM store_events
		WHERE id = ${eventId}
	`;

	expect(rows).toEqual([
		{
			customer_id: null,
			store_product_id: null,
			transaction_id: null,
			processing_status: "processing",
			processing_error: "integration processing seed",
			raw_payload: { seeded: true },
			processed_at: null,
			locked_by: "integration-worker",
		},
	]);
}

function googleAccountId(billingAccountId: string): string {
	return createGoogleObfuscatedAccountId(billingAccountId, "google-account-link-secret");
}

function byProjectKey(left: { project_key: string }, right: { project_key: string }): number {
	return left.project_key.localeCompare(right.project_key);
}

// Pass-through: the repository now serializes all Date SQL params as ISO (src/db/repository.ts),
// so the integration suite exercises the real serialization instead of patching Date.
async function withIsoDateSqlParameters<T>(callback: () => T | Promise<T>): Promise<T> {
	return await callback();
}
