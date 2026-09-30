import { describe, expect, it } from "bun:test";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { createApp as createBillingApp } from "../../src/app";
import { EntitlementService } from "../../src/billing/entitlements";
import { generateOpenApi } from "../../src/composition/openapi";
import { BillingAdminOperations } from "../../src/operations/admin";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const METHODS = ["get", "post", "put", "delete", "patch"] as const;

/** Operations that declare the operator key, straight from the generated contract document. */
function operatorKeyRoutes(document: OpenAPIObject) {
	return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
		METHODS.flatMap((method) => {
			const operation = (
				item as Record<string, { security?: Record<string, string[]>[] } | undefined>
			)?.[method];
			return operation?.security?.some((scheme) => "operatorKey" in scheme)
				? [{ path, method }]
				: [];
		}),
	);
}

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

const unauthorized = {
	success: false,
	error: { code: "UNAUTHORIZED", message: "Invalid billing operator key" },
};

function operatorTestApp(appEnv: BillingEnv = env) {
	return createBillingApp({
		env: appEnv,
		connections: fixtureConnections(env.connectionFixtures),
		projectContextResolver: projectContextResolver({
			contexts: [projectInstanceContext("acme")],
			credentials: { secret: "acme" },
		}),
		entitlementService: new EntitlementService({
			getEntitlementSnapshot() {
				throw new Error("unused");
			},
		}),
		adminOperations: new BillingAdminOperations({
			replayWorker: {
				runOne() {
					throw new Error("unused");
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("unused");
				},
			},
		}),
	});
}

function requestHeaders(verb: string, operatorKey?: string): Record<string, string> {
	const headers: Record<string, string> = { authorization: "Bearer secret" };
	if (operatorKey !== undefined) {
		headers["x-billing-operator-key"] = operatorKey;
	}
	if (verb !== "GET") {
		headers["content-type"] = "application/json";
		headers["x-billing-actor"] = "operator-test";
		headers["idempotency-key"] = "operator-auth";
	}
	return headers;
}

describe("operator-key contracts", () => {
	it("returns 401 for missing, wrong, and same-length wrong operator keys", async () => {
		const routes = operatorKeyRoutes(await generateOpenApi("0.0.0-test"));
		expect(routes.length).toBeGreaterThan(0);
		const app = withOpenApiAssertions(operatorTestApp());
		for (const { path, method } of routes) {
			const requestPath = fillPath(path);
			const verb = method.toUpperCase();
			for (const operatorKey of [undefined, "wrong-operator-key", "operator-secret-kez"]) {
				const response = await testRequest(app, requestPath, {
					method: verb,
					headers: requestHeaders(verb, operatorKey),
					body: verb === "GET" ? undefined : "{}",
				});
				expect(response.status, `${verb} ${requestPath}`).toBe(401);
				expect(await response.json()).toEqual(unauthorized);
			}
		}
	});

	it("counts wrong operator keys against the admin rate limit on every operator route", async () => {
		const routes = operatorKeyRoutes(await generateOpenApi("0.0.0-test"));
		expect(routes.length).toBeGreaterThan(0);
		const limitedEnv = { ...env, rateLimit: { ...env.rateLimit, adminLimit: 1 } };
		for (const { path, method } of routes) {
			// The limiter keys on the route pattern, so each route gets a fresh app and budget.
			const app = withOpenApiAssertions(operatorTestApp(limitedEnv));
			const requestPath = fillPath(path);
			const verb = method.toUpperCase();
			const send = () =>
				testRequest(app, requestPath, {
					method: verb,
					headers: requestHeaders(verb, "wrong-operator-key"),
					body: verb === "GET" ? undefined : "{}",
				});
			expect((await send()).status, `${verb} ${requestPath}`).toBe(401);
			const limited = await send();
			expect(limited.status, `${verb} ${requestPath}`).toBe(429);
			expect(await limited.json()).toEqual({
				success: false,
				error: { code: "RATE_LIMITED", message: "Too many requests" },
			});
		}
	});

	it("never reaches an operator handler through path variants the guard does not see", async () => {
		const routes = operatorKeyRoutes(await generateOpenApi("0.0.0-test"));
		const app = operatorTestApp();
		for (const { path, method } of routes) {
			const verb = method.toUpperCase();
			const requestPath = fillPath(path);
			const variants = [
				// Elysia matches `/x/` as `/x` unless strictPath is set.
				new Request(`http://localhost${requestPath}/`),
				// Elysia skips the first 11 URL characters when it looks for the path, so a
				// one-character Host shifts the routed path away from `new URL(url).pathname`.
				new Request(`http://a/xx${requestPath}`),
				new Request(`http://a/x${requestPath}`),
			];
			for (const variant of variants) {
				const response = await app.handle(
					new Request(variant.url, {
						method: verb,
						headers: requestHeaders(verb),
						body: verb === "GET" ? undefined : "{}",
					}),
				);
				expect([401, 404], `${verb} ${variant.url}`).toContain(response.status);
			}
		}
	});
});

function fillPath(path: string): string {
	return path.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, "00000000-0000-4000-8000-000000000001");
}
