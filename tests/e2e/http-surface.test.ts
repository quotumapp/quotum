import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { e2eApiKey, e2eServiceEnv } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { type BillingServiceProcess, startBillingService } from "./helpers/service-process";

const e2eDescribe = describeE2e(describe, describe.skip);
let service: BillingServiceProcess;
let sql: SQL;

e2eDescribe("E2E HTTP surface", () => {
	beforeAll(async () => {
		const postgresUri = process.env.POSTGRES_URI;
		if (postgresUri === undefined || postgresUri.trim() === "") {
			throw new Error("POSTGRES_URI is required for E2E tests");
		}

		sql = new SQL(postgresUri, { max: 1, idleTimeout: 1, maxLifetime: 0 });
		service = await startBillingService(
			e2eServiceEnv({
				postgresUri,
				overrides: {
					BILLING_VERIFY_RATE_LIMIT_PER_WINDOW: "3",
					BILLING_RATE_LIMIT_WINDOW_MS: "60000",
				},
			}),
		);
	});

	afterAll(async () => {
		await service?.stop();
		await sql?.close();
	});

	it("returns 401 envelopes for missing or wrong API keys and echoes request ids", async () => {
		const missing = await service.request("/v1/billing-accounts/integration_user/entitlements", {
			headers: { "x-request-id": "e2e-missing-key" },
		});
		expect(missing.status).toBe(401);
		expect(missing.headers.get("x-request-id")).toBe("e2e-missing-key");
		expect(await missing.json()).toEqual({
			success: false,
			error: { code: "UNAUTHORIZED", message: "Invalid billing API key" },
		});

		const wrong = await service.request("/v1/billing-accounts/integration_user/entitlements", {
			headers: {
				authorization: "Bearer wrong-key",
				"x-request-id": "e2e-wrong-key",
			},
		});
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get("x-request-id")).toBe("e2e-wrong-key");
	});

	it("rate limits verify requests over real HTTP", async () => {
		for (let index = 0; index < 3; index += 1) {
			const response = await invalidVerify();
			expect(response.status).toBe(400);
		}

		const limited = await invalidVerify();
		expect(limited.status).toBe(429);
		expect(limited.headers.get("ratelimit-remaining")).toBe("0");
		expect(limited.headers.get("ratelimit-reset")).toEqual(expect.any(String));
		expect(await limited.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
	});

	it("rejects unknown project and invalid Stripe signatures before durable writes", async () => {
		const before = await durableCounts();
		const unknown = await service.request("/v1/projects/unknown/webhooks/stripe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(unknown.status).toBe(404);

		const invalidSignature = await service.request("/v1/projects/voysee/webhooks/stripe", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"stripe-signature": "bad-signature",
			},
			body: JSON.stringify({ id: "evt_bad" }),
		});
		expect(invalidSignature.status).toBe(400);
		expect(await invalidSignature.json()).toEqual({
			success: false,
			error: {
				code: "STRIPE_WEBHOOK_SIGNATURE_INVALID",
				message: "Stripe webhook signature is invalid",
			},
		});
		expect(await durableCounts()).toEqual(before);
	});
});

async function invalidVerify(): Promise<Response> {
	return await service.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			authorization: `Bearer ${e2eApiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ provider: "apple" }),
	});
}

async function durableCounts(): Promise<Record<string, number>> {
	const rows = await sql<{ table_name: string; count: string }[]>`
		SELECT 'customers' AS table_name, count(*)::text AS count FROM customers
		UNION ALL SELECT 'provider_customers', count(*)::text FROM provider_customers
		UNION ALL SELECT 'purchases', count(*)::text FROM purchases
		UNION ALL SELECT 'subscriptions', count(*)::text FROM subscriptions
		UNION ALL SELECT 'entitlements', count(*)::text FROM entitlements
		UNION ALL SELECT 'store_events', count(*)::text FROM store_events
		UNION ALL SELECT 'projection_sync_jobs', count(*)::text FROM projection_sync_jobs
	`;
	return Object.fromEntries(rows.map((row) => [row.table_name, Number(row.count)]));
}
