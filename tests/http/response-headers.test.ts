import { describe, expect, it } from "bun:test";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { createApp as createBillingApp } from "../../src/app";
import { createConnectionEventApp } from "../../src/composition/connection-events";
import { generateOpenApi } from "../../src/composition/openapi";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { testRequest } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const METHODS = ["get", "post", "put", "delete", "patch"] as const;

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	postgresPreparedStatements: true,
	authMode: "api_key",
	operatorApiKey: "operator-secret-key",
	trustGatewayProjectHeader: false,
	connectionFixtures: [
		{
			projectInstanceKey: "acme",
			projectionUrl: "https://acme.example.com",
			projectionSecret: "acme-projection-secret",
		},
	],
	runtimeEnvironment: "development",
	workerId: "worker-a",
	workerPollIntervalMs: 5000,
	projectionSyncMaxAttempts: 10,
	storeEventReplayMaxAttempts: 10,
	storeEventReplayPollIntervalMs: 5000,
	subscriptionReconciliationMaxAttempts: 10,
	subscriptionReconciliationPollIntervalMs: 60000,
	providerReconciliationStaleAfterMs: 21600000,
	meteringMaintenancePollIntervalMs: 60000,
	rateLimit: {
		windowMs: 60000,
		verifyLimit: 120,
		webhookLimit: 600,
		adminLimit: 60,
		meteringLimit: 6000,
		trustProxyHeaders: false,
	},
	sentry: {
		dsn: null,
		environment: "test",
		release: null,
		enableLogs: true,
		tracesSampleRate: 0.01,
		logLevel: "warn",
		captureExpectedErrors: false,
	},
};

function staffApp(appEnv: BillingEnv = env) {
	return createBillingApp({
		env: appEnv,
		connections: fixtureConnections(env.connectionFixtures),
		projectContextResolver: projectContextResolver({
			contexts: [projectInstanceContext("acme")],
			credentials: { secret: "acme" },
		}),
	});
}

/** Every `/v1` operation that authenticates with a project credential, from the contract. */
function projectKeyOperations(document: OpenAPIObject) {
	return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
		METHODS.flatMap((method) => {
			const operation = (
				item as Record<string, { security?: Record<string, string[]>[] } | undefined>
			)?.[method];
			return path.startsWith("/v1/") &&
				operation?.security?.some((scheme) => "projectKey" in scheme)
				? [{ method: method.toUpperCase(), path: path.replace(/\{[^}]+\}/g, "p1") }]
				: [];
		}),
	);
}

function expectPrivateJson(response: Response, label: string) {
	expect(response.headers.get("cache-control"), label).toBe("no-store");
	expect(response.headers.get("x-content-type-options"), label).toBe("nosniff");
}

describe("staff response headers", () => {
	it("challenges a missing credential on every /v1 operation and names the request", async () => {
		const operations = projectKeyOperations(await generateOpenApi("0.0.0-test"));
		expect(operations.length).toBeGreaterThan(50);
		const app = staffApp();
		for (const { method, path } of operations) {
			const label = `${method} ${path}`;
			const response = await testRequest(app, path, {
				method,
				...(method === "GET"
					? {}
					: { headers: { "content-type": "application/json" }, body: "{}" }),
			});
			expect(response.status, label).toBe(401);
			expect(response.headers.get("www-authenticate"), label).toBe('Bearer realm="quotum"');
			expectPrivateJson(response, label);
			const body = (await response.json()) as { error: { requestId?: string } };
			expect(body.error.requestId, label).toBe(response.headers.get("x-request-id") ?? "");
		}
	});

	it("keeps successful and operational responses out of caches", async () => {
		const app = staffApp();
		for (const path of ["/health", "/livez"]) expectPrivateJson(await testRequest(app, path), path);
		const unknown = await testRequest(app, "/v1/unknown-route", {
			headers: { authorization: "Bearer secret" },
		});
		expect(unknown.status).toBe(404);
		expect(unknown.headers.get("www-authenticate")).toBeNull();
		expectPrivateJson(unknown, "unknown route");
	});

	it("keeps a short safe caller request ID and replaces anything else", async () => {
		const app = staffApp();
		for (const kept of ["caller-1", "trace:abc.DEF_9", "a".repeat(128)]) {
			const response = await testRequest(app, "/health", { headers: { "x-request-id": kept } });
			expect(response.headers.get("x-request-id")).toBe(kept);
		}
		for (const replaced of [
			"a".repeat(129),
			"<script>alert(1)</script>",
			"two words",
			"semi;colon",
			"x".repeat(16 * 1024),
		]) {
			const response = await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
				headers: { "x-request-id": replaced },
			});
			const requestId = response.headers.get("x-request-id") ?? "";
			expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
			const body = (await response.json()) as { error: { requestId?: string } };
			expect(body.error.requestId).toBe(requestId);
		}
	});

	it("tells a limited client when to retry, in the header and the body", async () => {
		const limited = staffApp({
			...env,
			rateLimit: { ...env.rateLimit, verifyLimit: 1, adminLimit: 1, meteringLimit: 1 },
		});
		// The per-client ceiling before authentication is the three limits combined.
		const responses: Response[] = [];
		for (let attempt = 0; attempt < 4; attempt += 1)
			responses.push(await testRequest(limited, "/v1/billing-accounts/user_1/entitlements"));
		const rejected = responses[3];
		expect(rejected?.status).toBe(429);
		const retryAfter = Number(rejected?.headers.get("retry-after"));
		expect(retryAfter).toBeGreaterThanOrEqual(1);
		expect(retryAfter).toBeLessThanOrEqual(60);
		expect(await rejected?.json()).toEqual({
			success: false,
			error: {
				code: "RATE_LIMITED",
				message: "Too many requests",
				retryAfter,
				requestId: rejected?.headers.get("x-request-id"),
			},
		});

		// After authentication the admin limit answers through the error handler.
		const admin = staffApp({ ...env, rateLimit: { ...env.rateLimit, adminLimit: 1 } });
		const read = () =>
			testRequest(admin, "/v1/admin/metrics", {
				headers: { authorization: "Bearer secret", "x-billing-operator-key": "wrong" },
			});
		expect((await read()).status).toBe(401);
		const adminLimited = await read();
		expect(adminLimited.status).toBe(429);
		expect(adminLimited.headers.get("www-authenticate")).toBeNull();
		const adminRetryAfter = Number(adminLimited.headers.get("retry-after"));
		expect(adminRetryAfter).toBeGreaterThanOrEqual(1);
		expect(await adminLimited.json()).toMatchObject({
			error: { code: "RATE_LIMITED", retryAfter: adminRetryAfter },
		});
	});
});

describe("setup ingress response headers", () => {
	it("keeps connection event answers out of caches", async () => {
		const app = createConnectionEventApp({ executor: {} } as never);
		const response = await app.handle(
			new Request("http://localhost/v1/projects/acme/connections/not-a-uuid/webhooks/unknown", {
				method: "POST",
				body: "{}",
			}),
		);
		expectPrivateJson(response, "connection event");
	});
});
