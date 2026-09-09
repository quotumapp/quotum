import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { EntitlementSnapshot } from "../../src/billing/types";
import { parseProjectApiCredential } from "../../src/platform/credentials/project-api-token";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectTableCounts } from "./helpers/db-assertions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { integrationProjectCredential } from "./helpers/platform-fixture";

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

	it("applies project credential revocation on the next request", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const credential = integrationProjectCredential("voysee");
		const parsed = parseProjectApiCredential(credential);
		if (parsed === null) throw new Error("Expected a versioned integration credential");

		const beforeRevocation = await app.request("/v1/billing-accounts/revoked_user/entitlements", {
			headers: authHeaders("voysee"),
		});
		expect(beforeRevocation.status).toBe(200);

		try {
			await context.sql`
				UPDATE platform_project_api_credentials
				SET revoked_at = now(), updated_at = now()
				WHERE id = ${parsed.credentialId}
			`;
			const afterRevocation = await app.request("/v1/billing-accounts/revoked_user/entitlements", {
				headers: authHeaders("voysee"),
			});
			expect(afterRevocation.status).toBe(401);
			expect(await afterRevocation.json()).toEqual({
				success: false,
				error: { code: "UNAUTHORIZED", message: "Invalid billing API key" },
			});
		} finally {
			await context.sql`
				UPDATE platform_project_api_credentials
				SET revoked_at = NULL, updated_at = now()
				WHERE id = ${parsed.credentialId}
			`;
		}
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

	it("applies every inactive lifecycle on the next request while allowing webhooks to drain", async () => {
		const { app, apple } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const blockedStatuses = ["inactive", "suspended", "deactivating", "deactivated"] as const;

		try {
			for (const lifecycleStatus of blockedStatuses) {
				await context.sql`
					UPDATE projects
					SET lifecycle_status = ${lifecycleStatus}
					WHERE key = 'wiseley'
				`;
				const privateResponse = await app.request(
					"/v1/billing-accounts/integration_user/entitlements",
					{ headers: { authorization: `Bearer ${integrationProjectCredential("wiseley")}` } },
				);
				const callsBeforeWebhook = apple.calls.length;
				const webhookResponse = await app.request("/v1/projects/wiseley/webhooks/apple", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ signedPayload: `signed-notification-${lifecycleStatus}` }),
				});

				expect(privateResponse.status).toBe(401);
				expect(webhookResponse.status).toBe(lifecycleStatus === "inactive" ? 403 : 200);
				if (lifecycleStatus === "inactive") expect(apple.calls.length).toBe(callsBeforeWebhook);
				else expect(apple.calls.length).toBeGreaterThan(callsBeforeWebhook);
			}
		} finally {
			await context.sql`UPDATE projects SET lifecycle_status = 'active' WHERE key = 'wiseley'`;
		}
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

	it("does not expose the removed unscoped Apple webhook alias", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const webhook = await app.request("/v1/webhooks/apple", {
			method: "POST",
			headers: { ...authHeaders("voysee"), "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});

		expect(webhook.status).toBe(404);
		const body = await webhook.json();
		expect(body).toEqual({
			success: false,
			error: { code: "NOT_FOUND", message: "Route not found" },
		});
		expect(apple.calls).toEqual([]);
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
