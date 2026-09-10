import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { decodeAdminCursor } from "../../src/admin/query";
import { createApp as createBillingApp } from "../../src/app";
import { AdminBillingRepository } from "../../src/db/admin-repository";
import { createBillingDatabaseConnection } from "../../src/db/client";
import type { BillingLogger } from "../../src/observability/logger";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { BillingAdminOperations } from "../../src/operations/admin";
import type { StoreEventReplayProviders } from "../../src/workers/store-event-replay";
import { StoreEventReplayWorker } from "../../src/workers/store-event-replay";
import { withOpenApiAssertions } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectCustomer } from "./helpers/db-assertions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { integrationProjectCredential } from "./helpers/platform-fixture";
import { createRecordingProjectionFetch, runProjectionWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Admin flows integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("reads customer drilldowns and related rows from durable provider flows", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await withIsoDateSqlParameters(() => verifyGoogleSubscription(fixture));
		const customer = await expectCustomer(context.sql, "integration_user");
		await seedRecentInactiveSubscriptions(context.sql, customer.id);

		await withAdminReadApp(async (adminApp) => {
			const byBillingAccount = await adminApp.request(
				"/v1/admin/customers/by-billing-account/integration_user",
				{
					headers: authHeaders("voysee"),
				},
			);

			expect(byBillingAccount.status).toBe(200);
			const body = await byBillingAccount.json();
			expect(body.success).toBe(true);
			expect(body.data.customer).toMatchObject({
				id: customer.id,
				projectKey: "voysee",
				billingAccountId: "integration_user",
			});
			expect(body.data.entitlementSnapshot.entitlements).toEqual([
				expect.objectContaining({
					key: "premium",
					active: true,
					expiresAt: "2099-06-30T00:00:00.000Z",
				}),
			]);
			expect(body.data.providerCustomers).toEqual([
				expect.objectContaining({
					provider: "google",
					externalCustomerId: expect.any(String),
					createdAt: expect.any(String),
				}),
			]);
			expect(body.data.activeSubscriptions).toEqual([
				expect.objectContaining({
					provider: "google",
					status: "active",
					productKey: "premium_monthly",
				}),
			]);
			expect(body.data.recentPurchases).toEqual([
				expect.objectContaining({
					provider: "google",
					purchaseKind: "subscription",
					transactionId: "purchase_token_1",
				}),
			]);
			expect(body.data.recentStoreEvents).toEqual([
				expect.objectContaining({
					provider: "google",
					eventType: "purchase_verified",
					processingStatus: "processed",
				}),
			]);
			expect(body.data.recentProjectionJobs).toEqual([
				expect.objectContaining({
					reason: "purchase_verified",
					status: "pending",
					idempotencyKey: "google:purchase_token_1:purchase_verified",
				}),
			]);

			const byId = await adminApp.request(`/v1/admin/customers/${customer.id}`, {
				headers: authHeaders("voysee"),
			});
			expect(byId.status).toBe(200);
			expect((await byId.json()).data.customer.billingAccountId).toBe("integration_user");
		});
	});

	it("searches customers by provider customer and transaction identifiers", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await withIsoDateSqlParameters(() => verifyGoogleSubscription(fixture));
		await createAppleAccountToken(fixture);
		await withIsoDateSqlParameters(() => verifyAppleSubscription(fixture));
		const identifiers = await customerSearchIdentifiers(context.sql);

		await withAdminReadApp(async (adminApp) => {
			await expectSearchResult(adminApp, "integration_user", {
				matchType: "billing_account_id",
				matchedValue: "integration_user",
			});
			await expectSearchResult(adminApp, identifiers.customerId, {
				matchType: "customer_id",
				matchedValue: identifiers.customerId,
			});
			await expectSearchResult(adminApp, identifiers.providerCustomerId, {
				matchType: "provider_customer",
				matchedValue: identifiers.providerCustomerId,
			});
			await expectSearchResult(adminApp, identifiers.transactionId, {
				matchType: "transaction_id",
				matchedValue: identifiers.transactionId,
			});
			await expectSearchResult(adminApp, identifiers.originalTransactionId, {
				matchType: "original_transaction_id",
				matchedValue: identifiers.originalTransactionId,
			});
			await expectSearchResult(adminApp, identifiers.orderId, {
				matchType: "order_id",
				matchedValue: identifiers.orderId,
			});
			await expectSearchResult(adminApp, identifiers.entitlementKey, {
				matchType: "entitlement_key",
				matchedValue: identifiers.entitlementKey,
			});

			const tooLong = await adminApp.request(
				`/v1/admin/customers/search?q=${encodeURIComponent("a".repeat(129))}`,
				{ headers: authHeaders("voysee") },
			);
			expect(tooLong.status).toBe(400);

			await makeProviderCustomerSearchMatchesDuplicate(context.sql, identifiers.customerId);
			const duplicateMatches = await getAdminList(
				adminApp,
				"/v1/admin/customers/search?q=duplicate-match",
			);
			expect(duplicateMatches.data).toEqual([
				expect.objectContaining({
					matchType: "provider_customer",
					matchedValue: "duplicate-match-apple",
					customer: expect.objectContaining({ id: identifiers.customerId }),
				}),
			]);
		});
	});

	it("lists catalog, purchases, subscriptions, store events, and projection jobs", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await withIsoDateSqlParameters(() =>
			verifyGoogleSubscription(fixture, { purchaseToken: "purchase_token_1" }),
		);
		await withIsoDateSqlParameters(() =>
			verifyGoogleSubscription(fixture, { purchaseToken: "purchase_token_2" }),
		);
		const customer = await expectCustomer(context.sql, "integration_user");
		await staggerGoogleSubscriptionFlowCreatedAt(context.sql);
		await staggerCatalogProductCreatedAt(context.sql);

		await withAdminReadApp(async (adminApp) => {
			const purchases = await getAdminList(
				adminApp,
				"/v1/admin/purchases?provider=google&purchaseKind=subscription&limit=1",
			);
			expect(purchases.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					productKey: "premium_monthly",
					transactionId: "purchase_token_2",
				}),
			]);
			const secondPurchases = await getNextAdminListPage(
				adminApp,
				"/v1/admin/purchases?provider=google&purchaseKind=subscription&limit=1",
				purchases,
			);
			expect(secondPurchases.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					productKey: "premium_monthly",
					transactionId: "purchase_token_1",
				}),
			]);
			const customerPurchases = await getAdminList(
				adminApp,
				`/v1/admin/customers/${customer.id}/purchases?status=completed&limit=1`,
			);
			expect(customerPurchases.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					transactionId: "purchase_token_2",
				}),
			]);
			const secondCustomerPurchases = await getNextAdminListPage(
				adminApp,
				`/v1/admin/customers/${customer.id}/purchases?status=completed&limit=1`,
				customerPurchases,
			);
			expect(secondCustomerPurchases.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					transactionId: "purchase_token_1",
				}),
			]);

			const subscriptions = await getAdminList(
				adminApp,
				"/v1/admin/subscriptions?provider=google&status=active&needsAttention=true&limit=1",
			);
			expect(subscriptions.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					externalSubscriptionId: "purchase_token_2",
					productKey: "premium_monthly",
					needsAttention: true,
				}),
			]);
			const secondSubscriptions = await getNextAdminListPage(
				adminApp,
				"/v1/admin/subscriptions?provider=google&status=active&needsAttention=true&limit=1",
				subscriptions,
			);
			expect(secondSubscriptions.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					externalSubscriptionId: "purchase_token_1",
					productKey: "premium_monthly",
				}),
			]);
			const customerSubscriptions = await getAdminList(
				adminApp,
				`/v1/admin/customers/${customer.id}/subscriptions?status=active&limit=1`,
			);
			expect(customerSubscriptions.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					externalSubscriptionId: "purchase_token_2",
				}),
			]);
			const secondCustomerSubscriptions = await getNextAdminListPage(
				adminApp,
				`/v1/admin/customers/${customer.id}/subscriptions?status=active&limit=1`,
				customerSubscriptions,
			);
			expect(secondCustomerSubscriptions.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					externalSubscriptionId: "purchase_token_1",
				}),
			]);

			const storeEvents = await getAdminList(
				adminApp,
				"/v1/admin/store-events?provider=google&processingStatus=processed&eventType=purchase_verified&limit=1",
			);
			expect(storeEvents.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					eventType: "purchase_verified",
					processingStatus: "processed",
					transactionId: "purchase_token_2",
				}),
			]);
			const secondStoreEvents = await getNextAdminListPage(
				adminApp,
				"/v1/admin/store-events?provider=google&processingStatus=processed&eventType=purchase_verified&limit=1",
				storeEvents,
			);
			expect(secondStoreEvents.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					eventType: "purchase_verified",
					processingStatus: "processed",
					transactionId: "purchase_token_1",
				}),
			]);
			const customerStoreEvents = await getAdminList(
				adminApp,
				`/v1/admin/customers/${customer.id}/store-events?processingStatus=processed&limit=1`,
			);
			expect(customerStoreEvents.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					transactionId: "purchase_token_2",
				}),
			]);
			const secondCustomerStoreEvents = await getNextAdminListPage(
				adminApp,
				`/v1/admin/customers/${customer.id}/store-events?processingStatus=processed&limit=1`,
				customerStoreEvents,
			);
			expect(secondCustomerStoreEvents.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					transactionId: "purchase_token_1",
				}),
			]);

			const projectionJobs = await getAdminList(
				adminApp,
				"/v1/admin/projection-jobs?status=pending&reason=purchase_verified&limit=1",
			);
			expect(projectionJobs.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					idempotencyKey: "google:purchase_token_2:purchase_verified",
					reason: "purchase_verified",
					status: "pending",
				}),
			]);
			const secondProjectionJobs = await getNextAdminListPage(
				adminApp,
				"/v1/admin/projection-jobs?status=pending&reason=purchase_verified&limit=1",
				projectionJobs,
			);
			expect(secondProjectionJobs.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					idempotencyKey: "google:purchase_token_1:purchase_verified",
					reason: "purchase_verified",
					status: "pending",
				}),
			]);
			const customerProjectionJobs = await getAdminList(
				adminApp,
				`/v1/admin/customers/${customer.id}/projection-jobs?status=pending&limit=1`,
			);
			expect(customerProjectionJobs.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					idempotencyKey: "google:purchase_token_2:purchase_verified",
				}),
			]);
			const secondCustomerProjectionJobs = await getNextAdminListPage(
				adminApp,
				`/v1/admin/customers/${customer.id}/projection-jobs?status=pending&limit=1`,
				customerProjectionJobs,
			);
			expect(secondCustomerProjectionJobs.data).toEqual([
				expect.objectContaining({
					billingAccountId: "integration_user",
					idempotencyKey: "google:purchase_token_1:purchase_verified",
				}),
			]);

			const firstCatalogPage = await getAdminList(adminApp, "/v1/admin/catalog/products?limit=1");
			expect(firstCatalogPage.data).toHaveLength(1);
			const nextCatalogCursor = firstCatalogPage.pagination.nextCursor;
			expect(nextCatalogCursor).toEqual(expect.any(String));
			if (nextCatalogCursor === null) {
				throw new Error("catalog pagination cursor was not returned");
			}
			expect(decodeAdminCursor(nextCatalogCursor).createdAt).toBe("2026-06-07T00:00:00.000900Z");
			expect(firstCatalogPage.data[0]).not.toHaveProperty("cursorCreatedAt");
			const secondCatalogPage = await getAdminList(
				adminApp,
				`/v1/admin/catalog/products?limit=1&cursor=${encodeURIComponent(nextCatalogCursor)}`,
			);
			expect(secondCatalogPage.data).toHaveLength(1);
			expect(secondCatalogPage.data[0].id).not.toBe(firstCatalogPage.data[0].id);

			const storeProducts = await getAdminList(
				adminApp,
				"/v1/admin/catalog/store-products?provider=google&productKey=premium_monthly&limit=1",
			);
			expect(storeProducts.data).toEqual([
				expect.objectContaining({
					provider: "google",
					channel: "android",
					productKey: "premium_monthly",
					externalProductId: "premium_monthly",
					externalPriceId: "monthly-base",
				}),
			]);
		});
	});

	it("controls raw payload inclusion on store event details", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await withIsoDateSqlParameters(() => verifyGoogleSubscription(fixture));
		const eventId = await latestStoreEventId(context.sql);
		await setStoreEventRawPayload(context.sql, eventId, {
			keep: "visible",
			purchaseToken: "purchase_token_sensitive",
			nested: {
				stripe_signature: "signature_sensitive",
				signedPayload: "payload_sensitive",
			},
		});
		const logs = createRecordingLogger();

		await withAdminReadApp(async (adminApp) => {
			const hidden = await adminApp.request(`/v1/admin/store-events/${eventId}`, {
				headers: authHeaders("voysee"),
			});
			expect(hidden.status).toBe(200);
			const hiddenBody = await hidden.json();
			expect(hiddenBody.success).toBe(true);
			expect("rawPayload" in hiddenBody.data).toBe(false);

			const included = await adminApp.request(
				`/v1/admin/store-events/${eventId}?includeRawPayload=true`,
				{ headers: authHeaders("voysee") },
			);
			expect(included.status).toBe(200);
			const includedBody = await included.json();
			expect(includedBody.success).toBe(true);
			expect(includedBody.data.rawPayload).toEqual({
				keep: "visible",
				purchaseToken: "[REDACTED]",
				nested: {
					stripe_signature: "[REDACTED]",
					signedPayload: "[REDACTED]",
				},
			});
		}, logs.logger);
		expect(logs.infos).toContainEqual({
			message: "Billing admin raw store event payload read",
			context: { projectKey: "voysee", eventId },
		});
	});

	it("keeps admin reads scoped to authenticated project", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await withIsoDateSqlParameters(() => verifyGoogleSubscription(fixture));

		await withAdminReadApp(async (adminApp) => {
			const voyseeSearch = await getAdminList(
				adminApp,
				"/v1/admin/customers/search?q=integration_user",
				"voysee",
			);
			expect(voyseeSearch.data).toHaveLength(1);

			const wiseleySearch = await getAdminList(
				adminApp,
				"/v1/admin/customers/search?q=integration_user",
				"wiseley",
			);
			expect(wiseleySearch.data).toEqual([]);

			const wiseleyPurchases = await getAdminList(adminApp, "/v1/admin/purchases", "wiseley");
			const wiseleySubscriptions = await getAdminList(
				adminApp,
				"/v1/admin/subscriptions",
				"wiseley",
			);
			const wiseleyStoreEvents = await getAdminList(adminApp, "/v1/admin/store-events", "wiseley");
			const wiseleyProjectionJobs = await getAdminList(
				adminApp,
				"/v1/admin/projection-jobs",
				"wiseley",
			);
			expect(wiseleyPurchases.data).toEqual([]);
			expect(wiseleySubscriptions.data).toEqual([]);
			expect(wiseleyStoreEvents.data).toEqual([]);
			expect(wiseleyProjectionJobs.data).toEqual([]);
		});
	});

	it("returns 404 responses for missing admin detail records", async () => {
		const missingId = "00000000-0000-4000-8000-000000000099";

		await withAdminReadApp(async (adminApp) => {
			for (const path of [
				`/v1/admin/customers/${missingId}`,
				`/v1/admin/store-events/${missingId}`,
			]) {
				const response = await adminApp.request(path, { headers: authHeaders("voysee") });

				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({
					success: false,
					error: { code: "NOT_FOUND" },
				});
			}
		});
	});

	it("renders metrics and delegates operation routes", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const invalid = await fixture.app.request("/v1/purchases/verify", {
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
			}),
		});
		expect(invalid.status).toBe(400);

		await withIsoDateSqlParameters(() => verifyGoogleConsumable(fixture));
		await runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: createRecordingProjectionFetch(
				new Response(JSON.stringify({ success: false }), { status: 200 }),
			).fetch,
			metrics: fixture.metrics,
		});

		const metrics = await fixture.app.request("/v1/admin/metrics", {
			headers: {
				...fixture.authHeaders("voysee"),
				"x-billing-operator-key": "billing-integration-operator-key",
			},
		});
		expect(metrics.status).toBe(200);
		expect(metrics.headers.get("content-type")).toContain("text/plain");
		const metricsText = await metrics.text();
		expect(metricsText).toContain('billing_projection_sync_jobs_total{result="failed"} 1');
		expect(metricsText).toContain(
			'billing_verification_failures_total{code="INVALID_REQUEST",provider="google"} 1',
		);

		const calls: string[] = [];
		const eventId = "00000000-0000-4000-8000-000000000001";
		const operationApp = createOperationApp({
			async replayStoreEvent(project, inputEventId: string) {
				calls.push(`replay:${project.projectInstanceKey}:${inputEventId}`);
				return { eventId: inputEventId, status: "processed" as const };
			},
			async runSubscriptionReconciliation() {
				calls.push("reconcile");
				return {
					outcome: "succeeded",
					expiredSubscriptions: 0,
					affectedCustomers: 0,
					providerClaimed: 0,
					providerProcessed: 0,
					providerSkipped: 0,
					providerFailed: 0,
				};
			},
		} as BillingAdminOperations);

		const replay = await operationApp.request(`/v1/admin/store-events/${eventId}/replay`, {
			method: "POST",
			headers: operatorHeaders("voysee"),
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({
			success: true,
			data: { eventId, status: "processed" },
		});

		const reconciliation = await operationApp.request(
			"/v1/admin/reconciliation/subscriptions/run",
			{
				method: "POST",
				headers: operatorHeaders("voysee"),
			},
		);
		expect(reconciliation.status).toBe(200);
		expect(await reconciliation.json()).toEqual({
			success: true,
			data: {
				outcome: "succeeded",
				expiredSubscriptions: 0,
				affectedCustomers: 0,
				providerClaimed: 0,
				providerProcessed: 0,
				providerSkipped: 0,
				providerFailed: 0,
			},
		});
		expect(calls).toEqual([`replay:voysee:${eventId}`, "reconcile"]);
	});

	it("requires operator auth and keeps admin replay scoped to the authenticated project", async () => {
		const wiseleyEventId = await seedAdminReplayEvent(context.sql, {
			projectKey: "wiseley",
			provider: "stripe",
			channel: "web",
			eventType: "checkout.session.completed",
			externalEventId: "stripe:admin-replay:wiseley",
		});
		const calls: string[] = [];
		const operationApp = createRealReplayOperationApp(calls);

		const missingOperator = await operationApp.request(
			`/v1/admin/store-events/${wiseleyEventId}/replay`,
			{
				method: "POST",
				headers: authHeaders("wiseley"),
			},
		);
		expect(missingOperator.status).toBe(401);

		const crossProjectReplay = await operationApp.request(
			`/v1/admin/store-events/${wiseleyEventId}/replay`,
			{
				method: "POST",
				headers: operatorHeaders("voysee"),
			},
		);
		expect(crossProjectReplay.status).not.toBe(200);
		expect(calls).toEqual([]);
		await expectAdminReplayEventStatus(context.sql, wiseleyEventId, "skipped");

		const sameProjectReplay = await operationApp.request(
			`/v1/admin/store-events/${wiseleyEventId}/replay`,
			{
				method: "POST",
				headers: operatorHeaders("wiseley"),
			},
		);
		expect(sameProjectReplay.status).toBe(200);
		expect(await sameProjectReplay.json()).toEqual({
			success: true,
			data: { eventId: wiseleyEventId, status: "processed" },
		});
		expect(calls).toEqual(["wiseley:stripe:checkout.session.completed"]);
		await expectAdminReplayEventStatus(context.sql, wiseleyEventId, "processed");
	});
});

async function verifyGoogleSubscription(
	fixture: ReturnType<typeof createIntegrationApp>,
	input: { purchaseToken?: string } = {},
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
			purchaseKind: "subscription",
			purchaseToken: input.purchaseToken ?? "purchase_token_1",
		}),
	});
}

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

async function createAppleAccountToken(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<void> {
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

async function verifyAppleSubscription(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<Response> {
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

async function withAdminReadApp<T>(
	callback: (app: ReturnType<typeof createApp>) => Promise<T>,
	logger?: BillingLogger,
): Promise<T> {
	const connection = createBillingDatabaseConnection(context.env);
	const app = createApp({
		env: context.env,
		adminBillingReader: new AdminBillingRepository(
			{
				providerReconciliationStaleAfterMs: context.env.providerReconciliationStaleAfterMs,
			},
			connection.db as never,
		),
		logger,
	});

	try {
		return await callback(app);
	} finally {
		await connection.sql.close();
	}
}

function createOperationApp(adminOperations: BillingAdminOperations): ReturnType<typeof createApp> {
	return createApp({
		env: context.env,
		adminBillingReader: null,
		adminOperations,
		metrics: createInMemoryBillingMetrics(),
	});
}

function authHeaders(projectKey: "voysee" | "wiseley" = "voysee"): HeadersInit {
	return { authorization: `Bearer ${integrationProjectCredential(projectKey)}` };
}

function operatorHeaders(projectKey: "voysee" | "wiseley" = "voysee"): HeadersInit {
	return {
		...authHeaders(projectKey),
		"x-billing-operator-key": context.env.operatorApiKey ?? "",
	};
}

function createRealReplayOperationApp(calls: string[]): ReturnType<typeof createApp> {
	return createOperationApp(
		new BillingAdminOperations({
			replayWorker: new StoreEventReplayWorker({
				workerId: "integration-admin-operator",
				maxAttempts: context.env.storeEventReplayMaxAttempts,
				batchSize: 25,
				repository: context.repository,
				projectContextResolver: context.projectContextResolver,
				providers: (project) => adminReplayProvidersForProject(project.projectInstanceKey, calls),
				jitterMs: () => 0,
			}),
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
		}),
	);
}

function adminReplayProvidersForProject(
	projectKey: string,
	calls: string[],
): StoreEventReplayProviders {
	return {
		apple: null,
		google: null,
		stripe:
			projectKey === "wiseley"
				? {
						async replayStoreEvent(event) {
							calls.push(`${event.project_key}:${event.provider}:${event.event_type}`);
							return { status: "processed" };
						},
					}
				: null,
	};
}

async function seedAdminReplayEvent(
	sql: SQL,
	input: {
		projectKey: "voysee" | "wiseley";
		provider: "google" | "stripe";
		channel: "android" | "web";
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
			${input.eventType}, 'skipped', 'integration admin replay seed',
			${JSON.stringify({ projectKey: input.projectKey, provider: input.provider })}::text::jsonb,
			now() - INTERVAL '1 second'
		FROM projects
		WHERE projects.key = ${input.projectKey}
		RETURNING id
	`;

	expect(rows).toHaveLength(1);
	return rows[0].id;
}

async function expectAdminReplayEventStatus(
	sql: SQL,
	eventId: string,
	expectedStatus: string,
): Promise<void> {
	const rows = await sql<{ processing_status: string; locked_by: string | null }[]>`
		SELECT processing_status, locked_by
		FROM store_events
		WHERE id = ${eventId}
	`;

	expect(rows).toEqual([{ processing_status: expectedStatus, locked_by: null }]);
}

async function customerSearchIdentifiers(sql: SQL): Promise<{
	customerId: string;
	providerCustomerId: string;
	transactionId: string;
	originalTransactionId: string;
	orderId: string;
	entitlementKey: string;
}> {
	const rows = await sql<
		{
			customer_id: string;
			provider_customer_id: string;
			transaction_id: string;
			original_transaction_id: string;
			order_id: string;
			entitlement_key: string;
		}[]
	>`
		SELECT customers.id AS customer_id,
			provider_customers.external_customer_id AS provider_customer_id,
			purchases.transaction_id,
			apple_purchase.original_transaction_id,
			purchases.raw_payload->>'latestOrderId' AS order_id,
			entitlements.entitlement_key
		FROM customers
		JOIN provider_customers ON provider_customers.customer_id = customers.id
			AND provider_customers.project_id = customers.project_id
			AND provider_customers.provider = 'google'
		JOIN purchases ON purchases.customer_id = customers.id
			AND purchases.project_id = customers.project_id
			AND purchases.provider = 'google'
		JOIN purchases apple_purchase ON apple_purchase.customer_id = customers.id
			AND apple_purchase.project_id = customers.project_id
			AND apple_purchase.provider = 'apple'
		JOIN entitlements ON entitlements.customer_id = customers.id
			AND entitlements.project_id = customers.project_id
		JOIN projects ON projects.id = customers.project_id
		WHERE projects.key = 'voysee'
			AND customers.billing_account_id = 'integration_user'
		LIMIT 1
	`;

	expect(rows).toHaveLength(1);
	return {
		customerId: rows[0].customer_id,
		providerCustomerId: rows[0].provider_customer_id,
		transactionId: rows[0].transaction_id,
		originalTransactionId: rows[0].original_transaction_id,
		orderId: rows[0].order_id,
		entitlementKey: rows[0].entitlement_key,
	};
}

async function setStoreEventRawPayload(
	sql: SQL,
	eventId: string,
	rawPayload: Record<string, unknown>,
): Promise<void> {
	await sql`
		UPDATE store_events
		SET raw_payload = ${JSON.stringify(rawPayload)}::text::jsonb
		WHERE id = ${eventId}
	`;
}

function createRecordingLogger() {
	const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const logger: BillingLogger = {
		info(message, context) {
			infos.push({ message, context });
		},
		warn() {},
		error() {},
	};
	return { logger, infos };
}

async function expectSearchResult(
	app: ReturnType<typeof createApp>,
	query: string,
	expected: { matchType: string; matchedValue: string },
): Promise<void> {
	const response = await app.request(`/v1/admin/customers/search?q=${encodeURIComponent(query)}`, {
		headers: authHeaders("voysee"),
	});
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.success).toBe(true);
	expect(body.data).toContainEqual(
		expect.objectContaining({
			matchType: expected.matchType,
			matchedValue: expected.matchedValue,
			customer: expect.objectContaining({
				projectKey: "voysee",
				billingAccountId: "integration_user",
			}),
		}),
	);
}

async function getAdminList(
	app: ReturnType<typeof createApp>,
	path: string,
	projectKey: "voysee" | "wiseley" = "voysee",
): Promise<{ data: Array<Record<string, unknown>>; pagination: { nextCursor: string | null } }> {
	const response = await app.request(path, {
		headers: path.includes("/catalog/") ? operatorHeaders(projectKey) : authHeaders(projectKey),
	});
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.success).toBe(true);
	expect(Array.isArray(body.data)).toBe(true);
	expect(Object.hasOwn(body.pagination, "nextCursor")).toBe(true);
	return body;
}

async function getNextAdminListPage(
	app: ReturnType<typeof createApp>,
	path: string,
	firstPage: { pagination: { nextCursor: string | null } },
): Promise<{ data: Array<Record<string, unknown>>; pagination: { nextCursor: string | null } }> {
	const cursor = firstPage.pagination.nextCursor;
	expect(cursor).toEqual(expect.any(String));
	if (cursor === null) {
		throw new Error(`pagination cursor was not returned for ${path}`);
	}

	return await getAdminList(
		app,
		`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`,
	);
}

async function latestStoreEventId(sql: SQL): Promise<string> {
	const rows = await sql<{ id: string }[]>`
		SELECT store_events.id
		FROM store_events
		JOIN projects ON projects.id = store_events.project_id
		WHERE projects.key = 'voysee'
		ORDER BY store_events.created_at DESC, store_events.id DESC
		LIMIT 1
	`;

	expect(rows).toHaveLength(1);
	return rows[0].id;
}

async function staggerGoogleSubscriptionFlowCreatedAt(sql: SQL): Promise<void> {
	const older = "2026-06-07T00:00:01.000Z";
	const newer = "2026-06-07T00:00:02.000Z";
	const purchases = await sql<{ transaction_id: string }[]>`
		UPDATE purchases
		SET created_at = CASE
				WHEN purchases.transaction_id = 'purchase_token_2' THEN ${newer}::timestamptz
				ELSE ${older}::timestamptz
			END
		FROM projects
		WHERE projects.id = purchases.project_id
			AND projects.key = 'voysee'
			AND purchases.transaction_id IN ('purchase_token_1', 'purchase_token_2')
		RETURNING purchases.transaction_id
	`;
	const subscriptions = await sql<{ external_subscription_id: string }[]>`
		UPDATE subscriptions
		SET created_at = CASE
				WHEN subscriptions.external_subscription_id = 'purchase_token_2' THEN ${newer}::timestamptz
				ELSE ${older}::timestamptz
			END
		FROM projects
		WHERE projects.id = subscriptions.project_id
			AND projects.key = 'voysee'
			AND subscriptions.external_subscription_id IN ('purchase_token_1', 'purchase_token_2')
		RETURNING subscriptions.external_subscription_id
	`;
	const storeEvents = await sql<{ transaction_id: string | null }[]>`
		UPDATE store_events
		SET created_at = CASE
				WHEN store_events.transaction_id = 'purchase_token_2' THEN ${newer}::timestamptz
				ELSE ${older}::timestamptz
			END
		FROM projects
		WHERE projects.id = store_events.project_id
			AND projects.key = 'voysee'
			AND store_events.transaction_id IN ('purchase_token_1', 'purchase_token_2')
		RETURNING store_events.transaction_id
	`;
	const projectionJobs = await sql<{ idempotency_key: string }[]>`
		UPDATE projection_sync_jobs
		SET created_at = CASE
				WHEN projection_sync_jobs.idempotency_key = 'google:purchase_token_2:purchase_verified'
					THEN ${newer}::timestamptz
				ELSE ${older}::timestamptz
			END
		FROM projects
		WHERE projects.id = projection_sync_jobs.project_id
			AND projects.key = 'voysee'
			AND projection_sync_jobs.idempotency_key IN (
				'google:purchase_token_1:purchase_verified',
				'google:purchase_token_2:purchase_verified'
			)
		RETURNING projection_sync_jobs.idempotency_key
	`;

	expect(purchases.map((row) => row.transaction_id).sort()).toEqual([
		"purchase_token_1",
		"purchase_token_2",
	]);
	expect(subscriptions.map((row) => row.external_subscription_id).sort()).toEqual([
		"purchase_token_1",
		"purchase_token_2",
	]);
	expect(storeEvents.map((row) => row.transaction_id).sort()).toEqual([
		"purchase_token_1",
		"purchase_token_2",
	]);
	expect(projectionJobs.map((row) => row.idempotency_key).sort()).toEqual([
		"google:purchase_token_1:purchase_verified",
		"google:purchase_token_2:purchase_verified",
	]);
}

async function staggerCatalogProductCreatedAt(sql: SQL): Promise<void> {
	const rows = await sql<{ key: string }[]>`
		UPDATE products
		SET created_at = CASE
				WHEN products.key = 'echo_credits_10' THEN ${"2026-06-07T00:00:00.000900Z"}::timestamptz
				ELSE ${"2026-06-07T00:00:00.000100Z"}::timestamptz
			END
		FROM projects
		WHERE projects.id = products.project_id
			AND projects.key = 'voysee'
			AND products.key IN ('echo_credits_10', 'premium_monthly')
		RETURNING products.key
	`;
	expect(rows.map((row) => row.key).sort()).toEqual(["echo_credits_10", "premium_monthly"]);
}

async function seedRecentInactiveSubscriptions(sql: SQL, customerId: string): Promise<void> {
	const rows = await sql<{ external_subscription_id: string }[]>`
		INSERT INTO subscriptions (
			project_id,
			customer_id,
			product_id,
			store_product_id,
			provider,
			channel,
			external_subscription_id,
			external_product_id,
			external_price_id,
			status,
			expires_at,
			created_at,
			updated_at
		)
		SELECT projects.id,
			${customerId}::uuid,
			products.id,
			store_products.id,
			'google',
			'android',
			'inactive_subscription_' || series.value,
			'premium_monthly',
			'monthly-base',
			'expired',
			now() - INTERVAL '1 day',
			now() + series.value * INTERVAL '1 second',
			now()
		FROM projects
		JOIN products ON products.project_id = projects.id
			AND products.key = 'premium_monthly'
		JOIN store_products ON store_products.project_id = projects.id
			AND store_products.product_id = products.id
			AND store_products.provider = 'google'
			AND store_products.external_price_id = 'monthly-base'
		CROSS JOIN generate_series(1, 6) AS series(value)
		WHERE projects.key = 'voysee'
		RETURNING external_subscription_id
	`;
	expect(rows).toHaveLength(6);
}

async function makeProviderCustomerSearchMatchesDuplicate(
	sql: SQL,
	customerId: string,
): Promise<void> {
	const rows = await sql<{ provider: string }[]>`
		UPDATE provider_customers
		SET external_customer_id = 'duplicate-match-' || provider
		WHERE customer_id = ${customerId}::uuid
		RETURNING provider
	`;
	expect(rows.map((row) => row.provider).sort()).toEqual(["apple", "google"]);
}

// Pass-through: the repository now serializes all Date SQL params as ISO (src/db/repository.ts),
// so the integration suite exercises the real serialization instead of patching Date.
async function withIsoDateSqlParameters<T>(callback: () => T | Promise<T>): Promise<T> {
	return await callback();
}

function createApp(dependencies: Parameters<typeof createBillingApp>[0]) {
	return withOpenApiAssertions(createBillingApp(dependencies));
}
