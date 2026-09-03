import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { EntitlementSnapshot } from "../../src/billing/types";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectTableCounts } from "./helpers/db-assertions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("billing auth and tenancy integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("rejects missing API keys and allows project API keys on entitlement routes", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const missing = await app.request("/v1/billing-accounts/integration_user/entitlements");
		const allowed = await app.request("/v1/billing-accounts/integration_user/entitlements", {
			headers: authHeaders("voysee"),
		});

		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({
			success: false,
			error: { code: "UNAUTHORIZED", message: "Invalid billing API key" },
		});
		expect(allowed.status).toBe(200);
		expectEmptySnapshot((await allowed.json()).data, "integration_user");
	});

	it("rejects query project selectors before Google provider calls or durable writes", async () => {
		const { app, google, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await app.request("/v1/purchases/verify?project_id=wiseley", {
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

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "INVALID_REQUEST",
				message: "Project is resolved from billing credentials",
			},
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

	it("returns 404 for unknown project Apple webhooks before provider calls", async () => {
		const { app, apple } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await app.request("/v1/projects/unknown/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PROJECT_NOT_CONFIGURED",
				message: "Billing project is not configured",
			},
		});
		expect(apple.calls).toEqual([]);
	});

	it("returns 404 for inactive project Apple webhooks before provider calls", async () => {
		const inactiveEnv = {
			...context.env,
			projects: context.env.projects.map((project) =>
				project.key === "wiseley" ? { ...project, active: false } : project,
			),
		};
		const { app, apple } = createIntegrationApp({
			env: inactiveEnv,
			repository: context.repository,
		});

		const response = await app.request("/v1/projects/wiseley/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PROJECT_NOT_CONFIGURED",
				message: "Billing project is not configured",
			},
		});
		expect(apple.calls).toEqual([]);
	});

	it("keeps project API key entitlement reads isolated", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const tokenResponse = await app.request(
			"/v1/billing-accounts/same_user/providers/apple/account-token",
			{
				headers: authHeaders("voysee"),
			},
		);

		expect(tokenResponse.status).toBe(200);
		const tokenBody = await tokenResponse.json();
		apple.setAppAccountToken(tokenBody.data.appAccountToken);

		const purchase = await withIsoDateSqlParameters(() =>
			app.request("/v1/purchases/verify", {
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "apple",
					billingAccountId: "same_user",
					transactionId: "200000000000001",
				}),
			}),
		);

		const voysee = await app.request("/v1/billing-accounts/same_user/entitlements", {
			headers: authHeaders("voysee"),
		});
		const wiseley = await app.request("/v1/billing-accounts/same_user/entitlements", {
			headers: authHeaders("wiseley"),
		});

		expect(purchase.status).toBe(200);
		expectActivePremiumSnapshot((await purchase.json()).data, "same_user");
		expect(apple.calls).toEqual(["verifyTransaction:200000000000001"]);
		expect(voysee.status).toBe(200);
		expect(wiseley.status).toBe(200);
		expectActivePremiumSnapshot((await voysee.json()).data, "same_user");
		expectEmptySnapshot((await wiseley.json()).data, "same_user");
		await expectEntitlementProjectCounts({ voysee: 1, wiseley: 0 });
	});

	it("accepts trusted gateway project headers and rejects missing gateway context", async () => {
		const gatewayEnv = {
			...context.env,
			authMode: "gateway" as const,
			trustGatewayProjectHeader: true,
		};
		const { app } = createIntegrationApp({
			env: gatewayEnv,
			repository: context.repository,
		});

		const missing = await app.request("/v1/billing-accounts/gateway_user/entitlements");
		const allowed = await app.request("/v1/billing-accounts/gateway_user/entitlements", {
			headers: { "x-billing-project-key": "voysee" },
		});

		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PROJECT_REQUIRED",
				message: "Billing project context is required",
			},
		});
		expect(allowed.status).toBe(200);
		expectEmptySnapshot((await allowed.json()).data, "gateway_user");
	});

	it("routes the legacy Apple webhook alias to the Voysee project", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const tokenResponse = await app.request(
			"/v1/billing-accounts/integration_user/providers/apple/account-token",
			{
				headers: authHeaders("voysee"),
			},
		);

		expect(tokenResponse.status).toBe(200);
		const tokenBody = await tokenResponse.json();
		apple.setAppAccountToken(tokenBody.data.appAccountToken);

		const webhook = await withIsoDateSqlParameters(() =>
			app.request("/v1/webhooks/apple", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ signedPayload: "signed-notification" }),
			}),
		);

		expect(webhook.status).toBe(200);
		const body = await webhook.json();
		expect(body.success).toBe(true);
		expect(body.data.status).toBe("processed");
		expectActivePremiumSnapshot(body.data.entitlements, "integration_user");
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
		await expectAppleAliasDurableRows();
	});
});

function expectEmptySnapshot(snapshot: EntitlementSnapshot, billingAccountId: string): void {
	expect(snapshot.billingAccountId).toBe(billingAccountId);
	expect(snapshot.generatedAt).toEqual(expect.any(String));
	expect(snapshot.entitlements).toEqual([]);
}

function expectActivePremiumSnapshot(
	snapshot: EntitlementSnapshot,
	billingAccountId: string,
): void {
	expect(snapshot.billingAccountId).toBe(billingAccountId);
	expect(snapshot.generatedAt).toEqual(expect.any(String));
	expect(snapshot.entitlements).toHaveLength(1);
	expect(snapshot.entitlements[0]).toEqual({
		key: "premium",
		active: true,
		expiresAt: "2099-06-30T00:00:00.000Z",
		metadata: expect.objectContaining({
			channel: "ios",
			provider: "apple",
			source: "subscription",
			status: "active",
		}),
	});
}

// Pass-through: the repository now serializes all Date SQL params as ISO (src/db/repository.ts),
// so the integration suite exercises the real serialization instead of patching Date.
async function withIsoDateSqlParameters<T>(callback: () => T | Promise<T>): Promise<T> {
	return await callback();
}

async function expectAppleAliasDurableRows(): Promise<void> {
	const rows = await context.sql<
		{
			store_event_project_key: string;
			store_event_status: string;
			store_event_type: string;
			store_event_transaction_id: string | null;
			projection_project_key: string;
			projection_reason: string;
			projection_status: string;
			projection_payload_billing_account_id: string | null;
		}[]
	>`
		SELECT
			store_projects.key AS store_event_project_key,
			store_events.processing_status AS store_event_status,
			store_events.event_type AS store_event_type,
			store_events.transaction_id AS store_event_transaction_id,
			projection_projects.key AS projection_project_key,
			projection_sync_jobs.reason AS projection_reason,
			projection_sync_jobs.status AS projection_status,
			projection_sync_jobs.payload->>'billingAccountId' AS projection_payload_billing_account_id
		FROM store_events
		JOIN projects store_projects ON store_projects.id = store_events.project_id
		JOIN projection_sync_jobs ON projection_sync_jobs.project_id = store_events.project_id
		JOIN projects projection_projects ON projection_projects.id = projection_sync_jobs.project_id
		WHERE store_events.provider = 'apple'
			AND store_events.external_event_id = '00000000-0000-0000-0000-000000000001'
	`;

	expect(rows).toEqual([
		{
			store_event_project_key: "voysee",
			store_event_status: "processed",
			store_event_type: "DID_RENEW",
			store_event_transaction_id: "200000000000001",
			projection_project_key: "voysee",
			projection_reason: "provider_webhook",
			projection_status: "pending",
			projection_payload_billing_account_id: "integration_user",
		},
	]);
}

async function expectEntitlementProjectCounts(expected: {
	voysee: number;
	wiseley: number;
}): Promise<void> {
	const rows = await context.sql<{ key: string; count: string }[]>`
		SELECT projects.key, count(entitlements.id)::text AS count
		FROM projects
		LEFT JOIN entitlements ON entitlements.project_id = projects.id
		WHERE projects.key IN ('voysee', 'wiseley')
		GROUP BY projects.key
		ORDER BY projects.key
	`;

	expect(rows).toEqual([
		{ key: "voysee", count: String(expected.voysee) },
		{ key: "wiseley", count: String(expected.wiseley) },
	]);
}
