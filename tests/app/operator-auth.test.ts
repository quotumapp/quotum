import { describe, expect, it } from "bun:test";
import { createApp as createBillingApp } from "../../src/app";
import { EntitlementService } from "../../src/billing/entitlements";
import { httpContracts } from "../../src/composition/openapi";
import { BillingAdminOperations } from "../../src/operations/admin";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { withOpenApiAssertions } from "../helpers/openapi";
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
		verifyLimit: 120,
		webhookLimit: 600,
		adminLimit: 60,
		meteringLimit: 6000,
		trustProxyHeaders: false,
	},
	sentry: {
		dsn: null,
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

describe("operator-key contracts", () => {
	it("returns 401 for missing, wrong, and same-length wrong operator keys", async () => {
		const app = withOpenApiAssertions(
			createBillingApp({
				env,
				connections: fixtureConnections(env.connectionFixtures),
				projectContextResolver: projectContextResolver({
					contexts: [projectInstanceContext("voysee")],
					credentials: { secret: "voysee" },
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
			}),
		);
		const routes = httpContracts.filter((contract) =>
			(contract.route.security ?? []).some((scheme) => "operatorKey" in scheme),
		);
		expect(routes.length).toBeGreaterThan(0);
		for (const contract of routes) {
			const path = fillPath(contract.path);
			const method = contract.method.toUpperCase();
			for (const operatorKey of [undefined, "wrong-operator-key", "operator-secret-kez"]) {
				const headers: Record<string, string> = { authorization: "Bearer secret" };
				if (operatorKey !== undefined) {
					headers["x-billing-operator-key"] = operatorKey;
				}
				if (method !== "GET") {
					headers["content-type"] = "application/json";
					headers["x-billing-actor"] = "operator-test";
					headers["idempotency-key"] = "operator-auth";
				}
				const response = await app.request(path, {
					method,
					headers,
					body: method === "GET" ? undefined : "{}",
				});
				expect(response.status, `${method} ${path}`).toBe(401);
				expect(await response.json()).toEqual(unauthorized);
			}
		}
	});
});

function fillPath(path: string): string {
	return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "00000000-0000-4000-8000-000000000001");
}
