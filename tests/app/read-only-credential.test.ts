import { describe, expect, it } from "bun:test";
import { createApp as createBillingApp } from "../../src/app";
import { EntitlementService } from "../../src/billing/entitlements";
import { NotFoundBillingError } from "../../src/billing/errors";
import { createNoopBillingLogger } from "../../src/observability/logger";
import { BillingAdminOperations } from "../../src/operations/admin";
import { CREDENTIAL_ACCESS_EXTENSION } from "../../src/shared/http";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	postgresPreparedStatements: true,
	authMode: "api_key",
	operatorApiKey: "operator-secret-key",
	trustGatewayProjectHeader: false,
	connectionFixtures: [
		{
			projectInstanceKey: "voysee",
			projectionUrl: "https://voysee.example.com",
			projectionSecret: "voysee-projection-secret",
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
		verifyLimit: 100000,
		webhookLimit: 100000,
		adminLimit: 100000,
		meteringLimit: 100000,
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

const snapshot = {
	billingAccountId: "account-1",
	entitlements: [],
	generatedAt: "2026-09-21T00:00:00.000Z",
};
const refusal = {
	success: false,
	error: {
		code: "READ_ONLY_CREDENTIAL",
		message: "This operation is not available to a read-only project credential",
	},
};

/** Records each call and answers 404, so a handler that runs never touches Postgres. */
function recordingService<T extends object>(calls: string[]): T {
	return new Proxy({} as T, {
		get: (_, method) =>
			method === "then"
				? undefined
				: async () => {
						calls.push(String(method));
						throw new NotFoundBillingError("Not found in this test");
					},
	});
}

function testApp(
	warnings: Array<{ message: string; context: unknown }> = [],
	calls: string[] = [],
) {
	return createBillingApp({
		env,
		logger: {
			...createNoopBillingLogger(),
			warn: (message, context) => {
				warnings.push({ message, context });
			},
		},
		connections: fixtureConnections(env.connectionFixtures),
		meteringService: recordingService(calls),
		promotionService: recordingService(calls),
		trialService: recordingService(calls),
		projectContextResolver: projectContextResolver({
			contexts: [projectInstanceContext("voysee")],
			credentials: {
				"full-key": "voysee",
				"read-key": { projectInstanceKey: "voysee", access: "read_only" },
			},
		}),
		entitlementService: new EntitlementService({
			async getEntitlementSnapshot() {
				return snapshot;
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

/** Every route behind the authentication derive; provider webhooks authenticate on their own. */
function gatedRoutes(app: ReturnType<typeof testApp>) {
	return app.routes
		.filter((route) => route.path.startsWith("/v1/") && !route.path.includes("/webhooks/"))
		.map((route) => ({
			method: route.method,
			path: route.path,
			requestPath: route.path.replace(/:[A-Za-z]+/gu, "00000000-0000-4000-8000-000000000001"),
			readOnly:
				(route.hooks as { detail?: Record<string, unknown> }).detail?.[
					CREDENTIAL_ACCESS_EXTENSION
				] === "read_only",
		}));
}

function headers(key: string, method: string): Record<string, string> {
	const result: Record<string, string> = { authorization: `Bearer ${key}` };
	if (method !== "GET" && method !== "HEAD") {
		result["content-type"] = "application/json";
		result["x-billing-actor"] = "read-only-test";
		result["idempotency-key"] = "read-only-credential";
		result["x-billing-operator-key"] = "operator-secret-key";
	}
	return result;
}

describe("read-only project credentials", () => {
	it("are refused on every route that has not opted in, before validation or any handler", async () => {
		const app = withOpenApiAssertions(testApp());
		const routes = gatedRoutes(app).filter((route) => !route.readOnly);
		expect(routes.length).toBeGreaterThan(40);
		for (const route of routes) {
			const response = await testRequest(app, route.requestPath, {
				method: route.method,
				headers: headers("read-key", route.method),
				// An empty object is invalid for most of these bodies: a 403 proves the gate ran first.
				body: route.method === "GET" ? undefined : "{}",
			});
			expect(response.status, `${route.method} ${route.path}`).toBe(403);
			expect(await response.json()).toEqual(refusal);
		}
	});

	it("are refused through path variants and HEAD as well", async () => {
		const app = testApp();
		for (const route of gatedRoutes(app).filter((candidate) => !candidate.readOnly)) {
			const variants = [
				`http://localhost${route.requestPath}/`,
				`http://a/xx${route.requestPath}`,
				`http://a/x${route.requestPath}`,
			];
			for (const url of variants) {
				const response = await app.handle(
					new Request(url, {
						method: route.method,
						headers: headers("read-key", route.method),
						body: route.method === "GET" ? undefined : "{}",
					}),
				);
				expect([403, 404], `${route.method} ${url}`).toContain(response.status);
			}
			if (route.method === "GET") {
				const head = await app.handle(
					new Request(`http://localhost${route.requestPath}`, {
						method: "HEAD",
						headers: headers("read-key", "HEAD"),
					}),
				);
				expect([403, 404], `HEAD ${route.path}`).toContain(head.status);
			}
		}
	});

	it("reach an opted-in route, which proves the router reports the matched pattern", async () => {
		const app = withOpenApiAssertions(testApp());
		const response = await testRequest(app, "/v1/billing-accounts/account-1/entitlements", {
			headers: headers("read-key", "GET"),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: snapshot });
	});

	it("leave a full credential untouched on the same routes", async () => {
		// Every answer here comes from past the credential gate: the operator-key guard, request
		// validation, a handler that needs an unconfigured provider, or a handler that reached a
		// recording service. The read-only refusal and unhandled failures are not among them.
		const pastTheGate = [
			"400 INVALID_REQUEST",
			"401 UNAUTHORIZED",
			"404 NOT_FOUND",
			"501 BILLING_PROVIDER_NOT_CONFIGURED",
			"503 BILLING_PROVIDER_NOT_CONFIGURED",
		];
		const calls: string[] = [];
		const app = withOpenApiAssertions(testApp([], calls));
		for (const route of gatedRoutes(app).filter((candidate) => !candidate.readOnly)) {
			// A wrong operator key stops operator routes and an empty body stops most others.
			const response = await testRequest(app, `${route.requestPath}?limit=not-a-number`, {
				method: route.method,
				headers: { ...headers("full-key", route.method), "x-billing-operator-key": "wrong" },
				body: route.method === "GET" ? undefined : "{}",
			});
			const body = (await response.json()) as { error?: { code?: string } };
			const outcome = `${response.status} ${body.error?.code}`;
			expect(pastTheGate, `${route.method} ${route.path} answered ${outcome}`).toContain(outcome);
		}
		// The three operations an empty request can complete reach their handlers.
		expect(calls).toEqual(["release", "getAccountRedemption", "endTrial"]);
	});

	it("never get raw provider payloads, even from a store-event read they may call", async () => {
		const app = withOpenApiAssertions(testApp());
		const response = await testRequest(
			app,
			"/v1/admin/store-events/00000000-0000-4000-8000-000000000001?includeRawPayload=true",
			{ headers: headers("read-key", "GET") },
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual(refusal);
	});

	it("leave a warning that names the project, method and route, and never the key", async () => {
		const warnings: Array<{ message: string; context: unknown }> = [];
		const app = testApp(warnings);
		await testRequest(app, "/v1/billing-accounts/account-1/usage/consume", {
			method: "POST",
			headers: headers("read-key", "POST"),
			body: "{}",
		});
		await testRequest(app, "/v1/billing-accounts/account-1/entitlements", {
			headers: headers("read-key", "GET"),
		});
		expect(warnings).toEqual([
			{
				message: "Read-only project credential refused",
				context: {
					source: "credential",
					projectKey: "voysee",
					method: "POST",
					route: "/v1/billing-accounts/:billingAccountId/usage/consume",
				},
			},
		]);
		expect(JSON.stringify(warnings)).not.toContain("read-key");
	});

	it("are rejected outright when the presented key is unknown", async () => {
		const response = await testRequest(testApp(), "/v1/billing-accounts/account-1/entitlements", {
			headers: headers("sqrk_unknown", "GET"),
		});
		expect(response.status).toBe(401);
	});
});

describe("gateway credential access header", () => {
	function gatewayApp(authMode: "gateway" | "api_key" = "gateway") {
		const lookups: string[] = [];
		const inner = projectContextResolver({
			contexts: [projectInstanceContext("voysee")],
			credentials: { "full-key": "voysee" },
		});
		const app = createBillingApp({
			env: { ...env, authMode, trustGatewayProjectHeader: authMode === "gateway" },
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: {
				...inner,
				resolveInstanceKey: (key) => {
					lookups.push(key);
					return inner.resolveInstanceKey(key);
				},
			},
			entitlementService: new EntitlementService({
				async getEntitlementSnapshot() {
					return snapshot;
				},
			}),
		});
		return { app, lookups };
	}
	const gatewayHeaders = (access?: string): Record<string, string> => ({
		"x-billing-project-key": "voysee",
		"content-type": "application/json",
		"idempotency-key": "gateway-access",
		...(access === undefined ? {} : { "x-billing-credential-access": access }),
	});
	const read = "/v1/billing-accounts/account-1/entitlements";
	const write = "/v1/billing-accounts/account-1/usage/consume";

	it("restricts a request the gateway marks read_only exactly like a read-only key", async () => {
		const { app } = gatewayApp();
		const refused = await testRequest(withOpenApiAssertions(app), write, {
			method: "POST",
			headers: gatewayHeaders(" read_only "),
			body: "{}",
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual(refusal);
		const allowed = await testRequest(app, read, { headers: gatewayHeaders("read_only") });
		expect(allowed.status).toBe(200);
	});

	it("keeps full access when the header is absent or says full", async () => {
		const { app } = gatewayApp();
		for (const access of [undefined, "full"]) {
			const response = await testRequest(app, write, {
				method: "POST",
				headers: gatewayHeaders(access),
				body: "{}",
			});
			// The empty body fails validation: the request got past the access gate.
			expect([access, response.status]).toEqual([access, 400]);
			expect(await response.json()).not.toMatchObject({
				error: { code: "READ_ONLY_CREDENTIAL" },
			});
		}
	});

	it("refuses any other value before resolving the project, never reading it as full", async () => {
		const { app, lookups } = gatewayApp();
		for (const access of ["readonly", "READ_ONLY", "", "read_only, full", "admin"]) {
			const response = await testRequest(withOpenApiAssertions(app), read, {
				headers: gatewayHeaders(access),
			});
			expect([access, response.status]).toEqual([access, 400]);
			expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
		}
		expect(lookups).toEqual([]);
	});

	it("ignores the header entirely in api_key mode, where the stored credential decides", async () => {
		const { app } = gatewayApp("api_key");
		const apiKeyHeaders = (access: string) => ({
			authorization: "Bearer full-key",
			"content-type": "application/json",
			"idempotency-key": "api-key-mode",
			"x-billing-credential-access": access,
		});
		// A value that gateway mode would refuse does not even get looked at.
		const readResponse = await testRequest(app, read, { headers: apiKeyHeaders("nonsense") });
		expect(readResponse.status).toBe(200);
		// A client cannot downgrade or upgrade itself: the full key still reaches the write route,
		// which then fails on its empty body rather than on access.
		const writeResponse = await testRequest(app, write, {
			method: "POST",
			headers: apiKeyHeaders("read_only"),
			body: "{}",
		});
		expect(writeResponse.status).toBe(400);
		expect(await writeResponse.json()).not.toMatchObject({
			error: { code: "READ_ONLY_CREDENTIAL" },
		});
	});
});
