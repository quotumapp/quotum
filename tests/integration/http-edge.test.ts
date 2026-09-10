import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("HTTP edge integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("returns 429 and rate limit headers when verify limit is exceeded", async () => {
		const fixture = createIntegrationApp({
			env: withRateLimit({ verifyLimit: 2 }),
			repository: context.repository,
		});

		expect((await invalidVerify(fixture)).status).toBe(400);
		expect((await invalidVerify(fixture)).status).toBe(400);
		const limited = await invalidVerify(fixture);

		expect(limited.status).toBe(429);
		expect(limited.headers.get("ratelimit-remaining")).toBe("0");
		expect(limited.headers.get("ratelimit-reset")).toEqual(expect.any(String));
		expect(await limited.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
	});

	it("scopes rate limit buckets per project", async () => {
		const fixture = createIntegrationApp({
			env: withRateLimit({ verifyLimit: 2 }),
			repository: context.repository,
		});

		expect((await invalidVerify(fixture, "voysee")).status).toBe(400);
		expect((await invalidVerify(fixture, "voysee")).status).toBe(400);
		expect((await invalidVerify(fixture, "voysee")).status).toBe(429);

		const wiseley = await invalidVerify(fixture, "wiseley");
		expect(wiseley.status).toBe(400);
		expect(wiseley.headers.get("ratelimit-remaining")).toBe("1");
	});

	it("limits webhook, verify, and admin route groups independently", async () => {
		const fixture = createIntegrationApp({
			env: withRateLimit({ verifyLimit: 1, webhookLimit: 1, adminLimit: 1 }),
			repository: context.repository,
		});

		expect((await invalidVerify(fixture)).status).toBe(400);
		expect((await invalidAppleWebhook(fixture)).status).toBe(400);
		expect((await adminMetrics(fixture)).status).toBe(200);

		expect((await invalidVerify(fixture)).status).toBe(429);
		expect((await invalidAppleWebhook(fixture)).status).toBe(429);
		expect((await adminMetrics(fixture)).status).toBe(429);
	});

	it("uses X-Forwarded-For only when trusted for rate limit buckets", async () => {
		const untrusted = createIntegrationApp({
			env: withRateLimit({ verifyLimit: 1, trustProxyHeaders: false }),
			repository: context.repository,
		});

		expect(
			(await invalidVerify(untrusted, "voysee", { "x-forwarded-for": "10.0.0.1" })).status,
		).toBe(400);
		expect(
			(await invalidVerify(untrusted, "voysee", { "x-forwarded-for": "10.0.0.2" })).status,
		).toBe(429);

		const trusted = createIntegrationApp({
			env: withRateLimit({ verifyLimit: 1, trustProxyHeaders: true }),
			repository: context.repository,
		});

		expect((await invalidVerify(trusted, "voysee", { "x-forwarded-for": "10.0.0.1" })).status).toBe(
			400,
		);
		expect((await invalidVerify(trusted, "voysee", { "x-forwarded-for": "10.0.0.2" })).status).toBe(
			400,
		);
	});

	it("handles concurrent multi-project mutations without cross-tenant bleed", async () => {
		const fixture = createIntegrationApp({
			env: withRateLimit({
				verifyLimit: 10,
				webhookLimit: 10,
				adminLimit: 10,
			}),
			repository: context.repository,
			stripeEvent: {
				id: "evt_http_edge_checkout",
				type: "checkout.session.completed",
				data: {
					object: {
						amount_total: 499,
						charge: "ch_http_edge",
						client_reference_id: "integration_user",
						created: 1_779_840_000,
						currency: "usd",
						customer: "cus_integration",
						id: "cs_http_edge",
						latest_charge: "ch_http_edge",
						metadata: {
							billingAccountId: "integration_user",
							externalPriceId: "price_credits_10",
							externalProductId: "prod_stripe_credits_10",
							productKey: "echo_credits_10",
							purchaseKind: "consumable",
						},
						mode: "payment",
						object: "checkout.session",
						payment_intent: {
							id: "pi_http_edge",
							latest_charge: "ch_http_edge",
							metadata: { billingAccountId: "integration_user" },
						},
						payment_status: "paid",
						status: "complete",
					},
				},
			},
		});
		await createAppleAccountToken(fixture);
		await createGoogleAccountLink(fixture, "wiseley");

		const [appleVerify, googleVerify, stripeWebhook, wiseleyRead] = await Promise.all([
			verifyAppleSubscription(fixture),
			verifyGoogleConsumable(fixture, "wiseley"),
			postStripeWebhook(fixture),
			fixture.app.request("/v1/billing-accounts/integration_user/entitlements", {
				headers: fixture.authHeaders("wiseley"),
			}),
		]);

		expect(appleVerify.status).toBe(200);
		expect(googleVerify.status).toBe(200);
		expect(stripeWebhook.status).toBe(200);
		expect(wiseleyRead.status).toBe(200);
		await expectProjectCounts(context.sql, {
			voysee: {
				customers: 1,
				provider_customers: 2,
				purchases: 2,
				subscriptions: 1,
				entitlements: 1,
				projection_sync_jobs: 2,
			},
			wiseley: {
				customers: 1,
				provider_customers: 1,
				purchases: 1,
				subscriptions: 0,
				entitlements: 0,
				projection_sync_jobs: 1,
			},
		});

		const voyseeEntitlements = await fixture.app.request(
			"/v1/billing-accounts/integration_user/entitlements",
			{ headers: fixture.authHeaders("voysee") },
		);
		const wiseleyEntitlements = await fixture.app.request(
			"/v1/billing-accounts/integration_user/entitlements",
			{ headers: fixture.authHeaders("wiseley") },
		);
		expect((await voyseeEntitlements.json()).data.entitlements).toHaveLength(1);
		expect((await wiseleyEntitlements.json()).data.entitlements).toHaveLength(0);
	});
});

function withRateLimit(
	overrides: Partial<LocalPostgresContext["env"]["rateLimit"]>,
): LocalPostgresContext["env"] {
	return {
		...context.env,
		rateLimit: {
			windowMs: 60_000,
			verifyLimit: 2,
			webhookLimit: 2,
			adminLimit: 1,
			meteringLimit: 2,
			trustProxyHeaders: false,
			...overrides,
		},
	};
}

async function invalidVerify(
	fixture: ReturnType<typeof createIntegrationApp>,
	projectKey: "voysee" | "wiseley" = "voysee",
	headers: HeadersInit = {},
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders(projectKey),
			...headers,
			"content-type": "application/json",
		},
		body: JSON.stringify({ provider: "apple" }),
	});
}

async function invalidAppleWebhook(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<Response> {
	return await fixture.app.request("/v1/projects/voysee/webhooks/apple", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	});
}

async function adminMetrics(fixture: ReturnType<typeof createIntegrationApp>): Promise<Response> {
	return await fixture.app.request("/v1/admin/metrics", {
		headers: {
			...fixture.authHeaders("voysee"),
			"x-billing-operator-key": "billing-integration-operator-key",
		},
	});
}

async function createAppleAccountToken(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<void> {
	const response = await fixture.app.request(
		"/v1/billing-accounts/integration_user/providers/apple/account-token",
		{ headers: fixture.authHeaders("voysee") },
	);
	const body = await response.json();
	expect(response.status).toBe(200);
	fixture.apple.setAppAccountToken(body.data.appAccountToken);
}

async function createGoogleAccountLink(
	fixture: ReturnType<typeof createIntegrationApp>,
	projectKey: "wiseley",
): Promise<void> {
	const response = await fixture.app.request(
		"/v1/billing-accounts/integration_user/providers/google/account-link",
		{ headers: fixture.authHeaders(projectKey) },
	);
	expect(response.status).toBe(200);
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

async function verifyGoogleConsumable(
	fixture: ReturnType<typeof createIntegrationApp>,
	projectKey: "wiseley",
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders(projectKey),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "google",
			billingAccountId: "integration_user",
			purchaseKind: "consumable",
			purchaseToken: "wiseley_http_edge_purchase",
			productId: "echo_credits_10",
		}),
	});
}

async function postStripeWebhook(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<Response> {
	return await fixture.app.request("/v1/projects/voysee/webhooks/stripe", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": "sig_test",
		},
		body: JSON.stringify({
			id: "evt_http_edge_checkout",
			type: "checkout.session.completed",
			data: { object: {} },
		}),
	});
}

async function expectProjectCounts(
	sql: SQL,
	expected: Record<
		"voysee" | "wiseley",
		{
			customers: number;
			provider_customers: number;
			purchases: number;
			subscriptions: number;
			entitlements: number;
			projection_sync_jobs: number;
		}
	>,
): Promise<void> {
	for (const [projectKey, counts] of Object.entries(expected)) {
		const rows = await sql<{ table_name: string; count: string }[]>`
			SELECT 'customers' AS table_name, count(*)::text AS count
			FROM customers
			JOIN projects ON projects.id = customers.project_id
			WHERE projects.key = ${projectKey}
			UNION ALL
			SELECT 'provider_customers' AS table_name, count(*)::text AS count
			FROM provider_customers
			JOIN projects ON projects.id = provider_customers.project_id
			WHERE projects.key = ${projectKey}
			UNION ALL
			SELECT 'purchases' AS table_name, count(*)::text AS count
			FROM purchases
			JOIN projects ON projects.id = purchases.project_id
			WHERE projects.key = ${projectKey}
			UNION ALL
			SELECT 'subscriptions' AS table_name, count(*)::text AS count
			FROM subscriptions
			JOIN projects ON projects.id = subscriptions.project_id
			WHERE projects.key = ${projectKey}
			UNION ALL
			SELECT 'entitlements' AS table_name, count(*)::text AS count
			FROM entitlements
			JOIN projects ON projects.id = entitlements.project_id
			WHERE projects.key = ${projectKey}
			UNION ALL
			SELECT 'projection_sync_jobs' AS table_name, count(*)::text AS count
			FROM projection_sync_jobs
			JOIN projects ON projects.id = projection_sync_jobs.project_id
			WHERE projects.key = ${projectKey}
		`;
		expect(Object.fromEntries(rows.map((row) => [row.table_name, Number(row.count)]))).toEqual(
			counts,
		);
	}
}
