import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type {
	ProviderSubscriptionReconciliationRow,
	RecordGooglePurchaseProjectionInput,
	StoreEventReplayJobRow,
} from "../../src/db/repository";
import { verifyProjectionSignature } from "../../src/projections/http-types";
import { createGoogleObfuscatedAccountId } from "../../src/providers/google/account-link";
import { GooglePlayBillingService } from "../../src/providers/google/service";
import type { StoreEventReplayProviders } from "../../src/workers/store-event-replay";
import type { SubscriptionReconciliationProviders } from "../../src/workers/subscription-reconciliation";
import { createLocalProjectionReceiver } from "../helpers/projection-receiver";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectProjectionJob, expectStoreEvent, expectTableCounts } from "./helpers/db-assertions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
	withProjectionUrl,
} from "./helpers/local-postgres";
import {
	createRecordingProjectionFetch,
	runProjectionWorkerOnce,
	runStoreEventReplayWorkerOnce,
	runSubscriptionReconciliationWorkerOnce,
} from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Worker flows integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("delivers pending projection jobs over HTTP and marks them succeeded", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const response = await verifyGoogleConsumable(fixture);

		expect(response.status).toBe(200);
		const pendingJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "pending",
		});

		const projection = createRecordingProjectionFetch();
		const result = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
		});

		expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(projection.requests).toHaveLength(1);
		expect(projection.requests[0].url).toBe(
			"https://voysee.projection.integration.test/internal/billing/projections",
		);
		expect(projection.requests[0].init.method).toBe("POST");
		expect(projection.requests[0].init.redirect).toBe("error");
		expect(projection.requests[0].init.signal).toBeInstanceOf(AbortSignal);
		const headers = projection.requests[0].init.headers as Record<string, string>;
		expect(headers).toMatchObject({
			authorization: "Bearer voysee-projection-secret",
			"content-type": "application/json",
		});
		expect(headers["X-Billing-Timestamp"]).toEqual(expect.any(String));
		expect(headers["X-Billing-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
		expect(
			verifyProjectionSignature({
				secret: "voysee-projection-secret",
				body: projection.requests[0].rawBody,
				timestamp: headers["X-Billing-Timestamp"],
				signature: headers["X-Billing-Signature"],
			}),
		).toBe(true);
		expect(projection.requests[0].body).toMatchObject({
			projectKey: "voysee",
			jobId: pendingJob.id,
			idempotencyKey: pendingJob.idempotency_key,
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			entitlements: {
				billingAccountId: "integration_user",
				entitlements: [],
				generatedAt: expect.any(String),
			},
			purchase: {
				provider: "google",
				channel: "android",
				purchaseKind: "consumable",
				transactionId: "purchase_token_1",
				productKey: "echo_credits_10",
				creditAmount: 10,
				totalCreditAmount: 10,
				quantity: 1,
				refundableQuantity: 1,
				purchasedAt: "2026-05-31T00:00:00.000Z",
			},
		});

		const succeededJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "succeeded",
		});
		expect(succeededJob.id).toBe(pendingJob.id);
		expect(succeededJob.last_error).toBeNull();
		expect(succeededJob.locked_at).toBeNull();
		expect(succeededJob.locked_by).toBeNull();
	});

	it("times out a held projection delivery, releases the lock, and records exactly one request", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "voysee-projection-secret" });
		try {
			const env = withProjectionUrl(context.env, receiver.url);
			const fixture = createIntegrationApp({
				env,
				repository: context.repository,
			});
			expect((await verifyGoogleConsumable(fixture)).status).toBe(200);
			const hold = receiver.holdNextResponse();
			const result = await runProjectionWorkerOnce({
				env,
				repository: context.repository,
				fetch: globalThis.fetch,
				timeoutMs: 200,
			});
			expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
			const failedJob = await expectProjectionJob(context.sql, {
				billingAccountId: "integration_user",
				reason: "purchase_verified",
				status: "pending",
			});
			expect(failedJob.attempts).toBe(1);
			expect(failedJob.locked_by).toBeNull();
			expect(failedJob.last_error).toMatch(
				/^Projection delivery failed for project voysee: .*(timed out|TimeoutError|abort)/i,
			);
			expect(receiver.requests).toHaveLength(1);
			hold.release();
		} finally {
			receiver.stop();
		}
	});

	it("marks projection delivery failures retryable", async () => {
		const cases: Array<{
			name: string;
			response: Response | Error;
			expectedLastError: string;
		}> = [
			{
				name: "non-2xx response",
				response: new Response(JSON.stringify({ success: true }), { status: 503 }),
				expectedLastError: "Projection delivery failed for project voysee with status 503",
			},
			{
				name: "network error",
				response: new Error("socket closed"),
				expectedLastError: "Projection delivery failed for project voysee: socket closed",
			},
			{
				name: "invalid JSON response",
				response: new Response("not-json", { status: 200 }),
				expectedLastError: "Projection delivery response for project voysee was invalid",
			},
			{
				name: "invalid success envelope",
				response: new Response(JSON.stringify({ success: false }), { status: 200 }),
				expectedLastError: "Projection delivery response for project voysee was invalid",
			},
		];

		for (const failureCase of cases) {
			await resetAndSeedIntegrationData(context.sql);
			const fixture = createIntegrationApp({
				env: context.env,
				repository: context.repository,
			});
			await verifyGoogleConsumable(fixture);
			const pendingJob = await expectProjectionJob(context.sql, {
				billingAccountId: "integration_user",
				reason: "purchase_verified",
				status: "pending",
			});

			const projection = createRecordingProjectionFetch(failureCase.response);
			const result = await runProjectionWorkerOnce({
				env: context.env,
				repository: context.repository,
				fetch: projection.fetch,
			});

			expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
			expect(projection.requests).toHaveLength(1);
			const retriedJob = await expectProjectionJob(context.sql, {
				billingAccountId: "integration_user",
				reason: "purchase_verified",
				status: "pending",
			});
			expect(retriedJob.id).toBe(pendingJob.id);
			expect(retriedJob.attempts).toBe(1);
			expect(retriedJob.last_error).toBe(failureCase.expectedLastError);
			expect(retriedJob.next_attempt_at).toEqual(expect.any(String));
			expect(retriedJob.locked_at).toBeNull();
			expect(retriedJob.locked_by).toBeNull();
		}
	});

	it("retries failed projection jobs successfully", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await verifyGoogleConsumable(fixture);
		const pendingJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "pending",
		});

		await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: createRecordingProjectionFetch(
				new Response(JSON.stringify({ success: false }), { status: 200 }),
			).fetch,
		});
		await makeProjectionJobDue(context.sql, pendingJob.id);
		const projection = createRecordingProjectionFetch();
		const result = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
		});

		expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(projection.requests).toHaveLength(1);
		expect(projection.requests[0].body).toMatchObject({
			jobId: pendingJob.id,
			idempotencyKey: pendingJob.idempotency_key,
		});
		const succeededJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "purchase_verified",
			status: "succeeded",
		});
		expect(succeededJob.id).toBe(pendingJob.id);
		expect(succeededJob.attempts).toBe(1);
		expect(succeededJob.last_error).toBeNull();
		expect(succeededJob.locked_at).toBeNull();
	});

	it("resets projection attempts and redelivers when a processing job requests resync", async () => {
		const firstPurchasedAt = new Date("2026-05-31T00:00:00.000Z");
		const secondPurchasedAt = new Date("2026-06-01T00:00:00.000Z");

		await context.repository.recordGooglePurchaseAndEnqueueProjection(
			integrationProjectContext(),
			manualProjectionPurchaseInput({
				purchasedAt: firstPurchasedAt,
				externalEventId: "evt_projection_resync_first",
			}),
		);
		const processingJob = await makeProjectionJobProcessing(context.sql, {
			idempotencyKey: "manual:projection_resync:projection",
			attempts: 4,
			lockedBy: "worker-a",
		});

		await context.repository.recordGooglePurchaseAndEnqueueProjection(
			integrationProjectContext(),
			manualProjectionPurchaseInput({
				purchasedAt: secondPurchasedAt,
				externalEventId: "evt_projection_resync_second",
			}),
		);
		await expectProjectionResyncState(context.sql, processingJob.id, {
			status: "processing",
			attempts: "0",
			reprojectionRequested: true,
		});

		await context.repository.markProjectionSyncJobSucceeded(
			processingJob.project_id,
			processingJob.id,
			"worker-a",
		);
		await expectProjectionResyncState(context.sql, processingJob.id, {
			status: "pending",
			attempts: "0",
			reprojectionRequested: false,
		});

		const projection = createRecordingProjectionFetch();
		const result = await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: projection.fetch,
		});

		expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
		expect(projection.requests).toHaveLength(1);
		expect(projection.requests[0].body).toMatchObject({
			jobId: processingJob.id,
			idempotencyKey: "manual:projection_resync:projection",
			purchase: {
				transactionId: "projection_resync_token",
				purchasedAt: "2026-06-01T00:00:00.000Z",
			},
		});
		const succeededJob = await expectProjectionJob(context.sql, {
			billingAccountId: "projection_resync_user",
			reason: "provider_webhook",
			status: "succeeded",
		});
		expect(succeededJob.id).toBe(processingJob.id);
		expect(succeededJob.attempts).toBe(0);
		expect(succeededJob.last_error).toBeNull();
	});

	it("replays skipped store events through project-selected providers", async () => {
		const voyseeEventId = await seedReplayEvent(context.sql, {
			projectKey: "voysee",
			provider: "google",
			channel: "android",
			status: "skipped",
			eventType: "REPLAY_GOOGLE",
			externalEventId: "google:replay:voysee",
		});
		const wiseleyEventId = await seedReplayEvent(context.sql, {
			projectKey: "wiseley",
			provider: "stripe",
			channel: "web",
			status: "failed",
			eventType: "checkout.session.completed",
			externalEventId: "stripe:replay:wiseley",
		});
		const calls: string[] = [];

		const result = await runStoreEventReplayWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: (project) => replayProvidersForProject(project.projectInstanceKey, calls),
		});

		expect(result).toEqual({
			claimed: 2,
			processed: 2,
			ignored: 0,
			retryable: 0,
			failed: 0,
		});
		expect(calls.sort()).toEqual([
			"voysee:google:REPLAY_GOOGLE",
			"wiseley:stripe:checkout.session.completed",
		]);
		await expectReplayEventsProcessed(context.sql, [voyseeEventId, wiseleyEventId]);
	});

	it("marks store event replay failures retryable", async () => {
		await seedReplayEvent(context.sql, {
			projectKey: "voysee",
			provider: "google",
			channel: "android",
			status: "skipped",
			eventType: "REPLAY_GOOGLE_RETRY",
			externalEventId: "google:replay:retry",
		});

		const result = await runStoreEventReplayWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: {
				apple: null,
				google: {
					async replayStoreEvent(event) {
						expect(event.event_type).toBe("REPLAY_GOOGLE_RETRY");
						return { status: "retryable", reason: "receiver unavailable" };
					},
				},
				stripe: null,
			},
		});

		expect(result).toEqual({
			claimed: 1,
			processed: 0,
			ignored: 0,
			retryable: 1,
			failed: 0,
		});
		const event = await expectStoreEvent(context.sql, {
			provider: "google",
			eventType: "REPLAY_GOOGLE_RETRY",
			status: "pending",
		});
		expect(event.attempts).toBe(1);
		expect(event.processing_error).toBe("receiver unavailable");
		expect(event.next_attempt_at).toEqual(expect.any(String));
		expect(event.locked_at).toBeNull();
		expect(event.locked_by).toBeNull();
	});

	it("replays null-external-id store events without inserting duplicate store event rows", async () => {
		const initial = await context.repository.recordGooglePurchaseAndEnqueueProjection(
			integrationProjectContext(),
			googleNullExternalReplayInput(),
		);
		expect(initial.processingStatus).toBe("skipped");
		await expectNullExternalReplayStoreEvents(context.sql, [
			{
				billing_account_id: null,
				event_fingerprint: expect.any(String) as string,
				external_event_id: null,
				processing_status: "skipped",
				transaction_id: "purchase_token_null_replay",
			},
		]);
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createGoogleAccountLink(fixture, "integration_user");

		const result = await runStoreEventReplayWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: {
				apple: null,
				google: {
					async replayStoreEvent(event) {
						expect(event.external_event_id).toBeNull();
						const replayed = await context.repository.recordGooglePurchaseAndEnqueueProjection(
							integrationProjectContext(event.project_key),
							googleNullExternalReplayInput({ replayStoreEventId: event.id }),
						);
						return replayed.processingStatus === "processed"
							? { status: "processed" }
							: { status: "retryable", reason: "google_customer_unresolved" };
					},
				},
				stripe: null,
			},
		});

		expect(result).toEqual({
			claimed: 1,
			processed: 1,
			ignored: 0,
			retryable: 0,
			failed: 0,
		});
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectNullExternalReplayStoreEvents(context.sql, [
			{
				billing_account_id: "integration_user",
				event_fingerprint: expect.any(String) as string,
				external_event_id: null,
				processing_status: "processed",
				transaction_id: "purchase_token_null_replay",
			},
		]);
	});

	it("reconciles expired local subscriptions and stale provider subscriptions", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await verifyGoogleSubscription(fixture, {
			projectKey: "voysee",
			purchaseToken: "purchase_token_expired",
		});
		await verifyGoogleSubscription(fixture, {
			projectKey: "wiseley",
			purchaseToken: "purchase_token_stale",
		});
		await makeSubscriptionExpired(context.sql, "voysee", "purchase_token_expired");
		await makeSubscriptionStale(context.sql, "wiseley", "purchase_token_stale");
		const calls: string[] = [];

		const result = await runSubscriptionReconciliationWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: (project) => reconciliationProvidersForProject(project.projectInstanceKey, calls),
		});

		expect(result).toEqual({
			outcome: "succeeded",
			expiredSubscriptions: 1,
			affectedCustomers: 1,
			providerClaimed: 2,
			providerProcessed: 2,
			providerSkipped: 0,
			providerFailed: 0,
		});
		expect(calls.sort()).toEqual([
			"voysee:google:purchase_token_expired",
			"wiseley:google:purchase_token_stale",
		]);
		await expectSubscriptionReconciliationRows(context.sql);
		const expiryProjection = await expectProjectionJob(context.sql, {
			projectKey: "voysee",
			billingAccountId: "integration_user",
			reason: "expiry_reconciliation",
			status: "pending",
		});
		expect(expiryProjection.payload).toMatchObject({
			billingAccountId: "integration_user",
			reason: "expiry_reconciliation",
			entitlements: {
				billingAccountId: "integration_user",
				generatedAt: expect.any(String),
			},
		});
		await expectTableCounts(context.sql, { projection_sync_jobs: 3 });
	});

	it("restores a locally expired subscription when the provider reports a missed renewal", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await verifyGoogleSubscription(fixture, {
			projectKey: "voysee",
			purchaseToken: "purchase_token_recovered",
		});
		await markSubscriptionLocallyExpired(context.sql, "purchase_token_recovered");
		const google = new GooglePlayBillingService({
			config: {
				packageName: "com.voysee.app",
				obfuscatedAccountIdSecret: "google-account-link-secret",
				previousObfuscatedAccountIdSecrets: [],
				rtdnAudience: null,
				rtdnServiceAccountEmail: null,
				rtdnAuthorizedParty: null,
				enablePublisherMutations: true,
			},
			client: fixture.google.client,
			repository: context.repository.forProject(integrationProjectContext()),
		});

		const result = await runSubscriptionReconciliationWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: { apple: null, google, stripe: null },
		});

		expect(result).toMatchObject({
			outcome: "succeeded",
			expiredSubscriptions: 0,
			providerClaimed: 1,
			providerProcessed: 1,
			providerFailed: 0,
		});
		const rows = await context.sql<
			{ status: string; expires_at: string; entitlement_active: boolean }[]
		>`
			SELECT subscriptions.status,
				subscriptions.expires_at::text AS expires_at,
				entitlements.active AS entitlement_active
			FROM subscriptions
			JOIN projects ON projects.id = subscriptions.project_id
			JOIN entitlements ON entitlements.project_id = subscriptions.project_id
				AND entitlements.source_subscription_id = subscriptions.id
			WHERE projects.key = 'voysee'
				AND subscriptions.external_subscription_id = 'purchase_token_recovered'
		`;
		expect(rows).toEqual([
			{
				status: "active",
				expires_at: expect.stringContaining("2099-06-30"),
				entitlement_active: true,
			},
		]);
	});

	it("marks provider subscription reconciliation failures retryable", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await verifyGoogleSubscription(fixture, {
			projectKey: "wiseley",
			purchaseToken: "purchase_token_stale",
		});
		await makeSubscriptionStale(context.sql, "wiseley", "purchase_token_stale");

		const result = await runSubscriptionReconciliationWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: {
				apple: null,
				google: {
					async reconcileSubscription(subscription) {
						expect(subscription.project_key).toBe("wiseley");
						expect(subscription.external_subscription_id).toBe("purchase_token_stale");
						throw new Error("provider outage");
					},
				},
				stripe: null,
			},
		});

		expect(result).toEqual({
			outcome: "failed",
			expiredSubscriptions: 0,
			affectedCustomers: 0,
			providerClaimed: 1,
			providerProcessed: 0,
			providerSkipped: 0,
			providerFailed: 1,
		});
		await expectSubscriptionReconciliationFailure(context.sql);
	});
});

async function verifyGoogleConsumable(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders("voysee"),
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

async function verifyGoogleSubscription(
	fixture: ReturnType<typeof createIntegrationApp>,
	input: { projectKey: "voysee" | "wiseley"; purchaseToken: string },
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders(input.projectKey),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "google",
			billingAccountId: "integration_user",
			purchaseKind: "subscription",
			purchaseToken: input.purchaseToken,
		}),
	});
}

async function createGoogleAccountLink(
	fixture: ReturnType<typeof createIntegrationApp>,
	billingAccountId: string,
): Promise<void> {
	const response = await fixture.app.request(
		`/v1/billing-accounts/${billingAccountId}/providers/google/account-link`,
		{
			headers: fixture.authHeaders("voysee"),
		},
	);

	expect(response.status).toBe(200);
}

function manualProjectionPurchaseInput(overrides: {
	purchasedAt: Date;
	externalEventId: string;
}): RecordGooglePurchaseProjectionInput {
	return {
		billingAccountId: "projection_resync_user",
		obfuscatedAccountId: null,
		externalProductId: "echo_credits_10",
		externalPriceId: null,
		purchaseKind: "consumable",
		purchaseToken: "projection_resync_token",
		linkedPurchaseToken: null,
		orderId: "GPA.PROJECTION-RESYNC",
		purchaseStatus: "completed",
		subscriptionStatus: null,
		purchasedAt: overrides.purchasedAt,
		expiresAt: null,
		autoRenew: null,
		acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
		consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
		quantity: 1,
		refundableQuantity: 1,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: {
			fixture: "projection_resync",
			purchasedAt: overrides.purchasedAt.toISOString(),
		},
		eventType: "purchase.completed",
		externalEventId: overrides.externalEventId,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: "manual:projection_resync:projection",
	};
}

async function makeProjectionJobProcessing(
	sql: SQL,
	input: { idempotencyKey: string; attempts: number; lockedBy: string },
): Promise<{ id: string; project_id: string }> {
	const rows = await sql<{ id: string; project_id: string }[]>`
		UPDATE projection_sync_jobs
		SET
			status = 'processing',
			attempts = ${input.attempts},
			last_error = 'prior projection failure',
			next_attempt_at = now() + INTERVAL '1 hour',
			locked_at = now(),
			locked_by = ${input.lockedBy},
			updated_at = now()
		WHERE idempotency_key = ${input.idempotencyKey}
		RETURNING id, project_id
	`;

	expect(rows).toHaveLength(1);
	return rows[0];
}

async function expectProjectionResyncState(
	sql: SQL,
	jobId: string,
	expected: {
		status: "pending" | "processing" | "succeeded" | "failed";
		attempts: string;
		reprojectionRequested: boolean;
	},
): Promise<void> {
	const rows = await sql<
		{
			status: string;
			attempts: string;
			reprojection_requested: boolean;
			last_error: string | null;
		}[]
	>`
		SELECT status, attempts::text AS attempts, reprojection_requested, last_error
		FROM projection_sync_jobs
		WHERE id = ${jobId}
	`;

	expect(rows).toEqual([
		{
			status: expected.status,
			attempts: expected.attempts,
			reprojection_requested: expected.reprojectionRequested,
			last_error: null,
		},
	]);
}

function googleNullExternalReplayInput(
	overrides: { replayStoreEventId?: string } = {},
): RecordGooglePurchaseProjectionInput & { replayStoreEventId?: string } {
	return {
		billingAccountId: null,
		obfuscatedAccountId: createGoogleObfuscatedAccountId(
			"integration_user",
			"google-account-link-secret",
		),
		externalProductId: "echo_credits_10",
		externalPriceId: null,
		purchaseKind: "consumable",
		purchaseToken: "purchase_token_null_replay",
		linkedPurchaseToken: null,
		orderId: "GPA.NULL-REPLAY",
		purchaseStatus: "completed",
		subscriptionStatus: null,
		purchasedAt: new Date("2026-05-31T00:00:00.000Z"),
		expiresAt: null,
		autoRenew: null,
		acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
		consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
		quantity: 1,
		refundableQuantity: 1,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: {
			obfuscatedExternalAccountId: createGoogleObfuscatedAccountId(
				"integration_user",
				"google-account-link-secret",
			),
			orderId: "GPA.NULL-REPLAY",
			purchaseCompletionTime: "2026-05-31T00:00:00.000Z",
			purchaseStateContext: { purchaseState: "PURCHASED" },
			acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
			consumptionState: "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
			productLineItem: [
				{
					productId: "echo_credits_10",
					quantity: 1,
					refundableQuantity: 1,
				},
			],
		},
		eventType: "provider_reconciliation",
		externalEventId: null,
		projectionReason: "provider_reconciliation",
		projectionIdempotencyKey: "google:purchase_token_null_replay:provider_reconciliation",
		...overrides,
	};
}

async function makeProjectionJobDue(sql: SQL, jobId: string): Promise<void> {
	await sql`
		UPDATE projection_sync_jobs
		SET next_attempt_at = now() - INTERVAL '1 second'
		WHERE id = ${jobId}
	`;
}

async function seedReplayEvent(
	sql: SQL,
	input: {
		projectKey: "voysee" | "wiseley";
		provider: "google" | "stripe";
		channel: "android" | "web";
		status: "skipped" | "failed";
		eventType: string;
		externalEventId: string;
	},
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
			next_attempt_at
		)
		SELECT projects.id, ${input.provider}, ${input.channel}, ${input.externalEventId},
			${input.eventType}, ${input.status}, 'integration replay seed',
			${JSON.stringify({ projectKey: input.projectKey, provider: input.provider })}::text::jsonb,
			now() - INTERVAL '1 second'
		FROM projects
		WHERE projects.key = ${input.projectKey}
		RETURNING id
	`;

	expect(rows).toHaveLength(1);
	return rows[0].id;
}

function replayProvidersForProject(projectKey: string, calls: string[]): StoreEventReplayProviders {
	return {
		apple: null,
		google:
			projectKey === "voysee"
				? {
						async replayStoreEvent(event: StoreEventReplayJobRow) {
							expect(event.project_key).toBe("voysee");
							expect(event.provider).toBe("google");
							calls.push(`${event.project_key}:${event.provider}:${event.event_type}`);
							return { status: "processed" };
						},
					}
				: null,
		stripe:
			projectKey === "wiseley"
				? {
						async replayStoreEvent(event: StoreEventReplayJobRow) {
							expect(event.project_key).toBe("wiseley");
							expect(event.provider).toBe("stripe");
							calls.push(`${event.project_key}:${event.provider}:${event.event_type}`);
							return { status: "processed" };
						},
					}
				: null,
	};
}

async function expectReplayEventsProcessed(sql: SQL, eventIds: string[]): Promise<void> {
	const rows = await sql<
		{
			id: string;
			processing_status: string;
			processing_error: string | null;
			processed_at: string | null;
			locked_by: string | null;
		}[]
	>`
		SELECT id, processing_status, processing_error, processed_at::text AS processed_at,
			locked_by
		FROM store_events
		WHERE id IN ${sql(eventIds)}
		ORDER BY external_event_id
	`;

	expect(rows).toHaveLength(2);
	for (const row of rows) {
		expect(row.processing_status).toBe("processed");
		expect(row.processing_error).toBeNull();
		expect(row.processed_at).toEqual(expect.any(String));
		expect(row.locked_by).toBeNull();
	}
}

async function expectNullExternalReplayStoreEvents(
	sql: SQL,
	expected: Array<{
		billing_account_id: string | null;
		event_fingerprint: string | null;
		external_event_id: string | null;
		processing_status: string;
		transaction_id: string;
	}>,
): Promise<void> {
	const rows = await sql<
		{
			billing_account_id: string | null;
			event_fingerprint: string | null;
			external_event_id: string | null;
			processing_status: string;
			transaction_id: string;
		}[]
	>`
		SELECT customers.billing_account_id,
			store_events.event_fingerprint,
			store_events.external_event_id,
			store_events.processing_status,
			store_events.transaction_id
		FROM store_events
		LEFT JOIN customers ON customers.id = store_events.customer_id
			AND customers.project_id = store_events.project_id
		WHERE store_events.provider = 'google'
			AND store_events.transaction_id = 'purchase_token_null_replay'
		ORDER BY store_events.created_at, store_events.id
	`;

	expect(rows).toEqual(expected);
}

async function makeSubscriptionExpired(
	sql: SQL,
	projectKey: "voysee" | "wiseley",
	externalSubscriptionId: string,
): Promise<void> {
	await sql`
		UPDATE subscriptions
		SET
			expires_at = now() - INTERVAL '1 hour',
			provider_reconciled_at = now(),
			provider_reconciliation_next_attempt_at = now() - INTERVAL '1 hour'
		FROM projects
		WHERE projects.id = subscriptions.project_id
			AND projects.key = ${projectKey}
			AND subscriptions.external_subscription_id = ${externalSubscriptionId}
	`;
	await sql`
		UPDATE entitlements
		SET active = false, expires_at = now() - INTERVAL '1 hour'
		FROM subscriptions, projects
		WHERE subscriptions.id = entitlements.source_subscription_id
			AND subscriptions.project_id = entitlements.project_id
			AND projects.id = subscriptions.project_id
			AND projects.key = 'voysee'
			AND subscriptions.external_subscription_id = ${externalSubscriptionId}
	`;
}

async function makeSubscriptionStale(
	sql: SQL,
	projectKey: "voysee" | "wiseley",
	externalSubscriptionId: string,
): Promise<void> {
	await sql`
		UPDATE subscriptions
		SET
			expires_at = now() + INTERVAL '2 hours',
			provider_reconciled_at = now() - INTERVAL '12 hours',
			provider_reconciliation_next_attempt_at = now() - INTERVAL '1 hour'
		FROM projects
		WHERE projects.id = subscriptions.project_id
			AND projects.key = ${projectKey}
			AND subscriptions.external_subscription_id = ${externalSubscriptionId}
	`;
}

async function markSubscriptionLocallyExpired(
	sql: SQL,
	externalSubscriptionId: string,
): Promise<void> {
	await sql`
		UPDATE subscriptions
		SET
			status = 'expired',
			expires_at = now() - INTERVAL '1 hour',
			auto_renew = false,
			provider_reconciled_at = now() - INTERVAL '12 hours',
			provider_reconciliation_next_attempt_at = now() - INTERVAL '1 hour'
		FROM projects
		WHERE projects.id = subscriptions.project_id
			AND projects.key = 'voysee'
			AND subscriptions.external_subscription_id = ${externalSubscriptionId}
	`;
}

function reconciliationProvidersForProject(
	projectKey: string,
	calls: string[],
): SubscriptionReconciliationProviders {
	return {
		apple: null,
		google: {
			async reconcileSubscription(subscription: ProviderSubscriptionReconciliationRow) {
				expect(subscription.project_key).toBe(projectKey);
				expect(subscription.provider).toBe("google");
				calls.push(
					`${subscription.project_key}:${subscription.provider}:${subscription.external_subscription_id}`,
				);
				return { status: "processed" };
			},
		},
		stripe: null,
	};
}

async function expectSubscriptionReconciliationRows(sql: SQL): Promise<void> {
	const rows = await sql<
		{
			project_key: string;
			external_subscription_id: string;
			status: string;
			auto_renew: boolean;
			provider_reconciliation_attempts: number;
			provider_reconciliation_error: string | null;
			provider_reconciliation_locked_by: string | null;
			provider_reconciled_at: string | null;
		}[]
	>`
		SELECT projects.key AS project_key, subscriptions.external_subscription_id,
			subscriptions.status, subscriptions.auto_renew,
			subscriptions.provider_reconciliation_attempts,
			subscriptions.provider_reconciliation_error,
			subscriptions.provider_reconciliation_locked_by,
			subscriptions.provider_reconciled_at::text AS provider_reconciled_at
		FROM subscriptions
		JOIN projects ON projects.id = subscriptions.project_id
		WHERE subscriptions.external_subscription_id IN (
			'purchase_token_expired',
			'purchase_token_stale'
		)
		ORDER BY projects.key
	`;

	expect(rows).toEqual([
		{
			project_key: "voysee",
			external_subscription_id: "purchase_token_expired",
			status: "expired",
			auto_renew: false,
			provider_reconciliation_attempts: 0,
			provider_reconciliation_error: null,
			provider_reconciliation_locked_by: null,
			provider_reconciled_at: expect.any(String),
		},
		{
			project_key: "wiseley",
			external_subscription_id: "purchase_token_stale",
			status: "active",
			auto_renew: true,
			provider_reconciliation_attempts: 0,
			provider_reconciliation_error: null,
			provider_reconciliation_locked_by: null,
			provider_reconciled_at: expect.any(String),
		},
	]);
}

async function expectSubscriptionReconciliationFailure(sql: SQL): Promise<void> {
	const rows = await sql<
		{
			project_key: string;
			external_subscription_id: string;
			provider_reconciliation_attempts: number;
			provider_reconciliation_error: string | null;
			provider_reconciliation_next_attempt_at: string | null;
			provider_reconciliation_locked_by: string | null;
		}[]
	>`
		SELECT projects.key AS project_key, subscriptions.external_subscription_id,
			subscriptions.provider_reconciliation_attempts,
			subscriptions.provider_reconciliation_error,
			subscriptions.provider_reconciliation_next_attempt_at::text
				AS provider_reconciliation_next_attempt_at,
			subscriptions.provider_reconciliation_locked_by
		FROM subscriptions
		JOIN projects ON projects.id = subscriptions.project_id
		WHERE projects.key = 'wiseley'
			AND subscriptions.external_subscription_id = 'purchase_token_stale'
	`;

	expect(rows).toEqual([
		{
			project_key: "wiseley",
			external_subscription_id: "purchase_token_stale",
			provider_reconciliation_attempts: 1,
			provider_reconciliation_error: "provider outage",
			provider_reconciliation_next_attempt_at: expect.any(String),
			provider_reconciliation_locked_by: null,
		},
	]);
}
