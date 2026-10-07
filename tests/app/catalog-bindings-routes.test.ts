import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/types";
import { EntitlementService } from "../../src/billing/entitlements";
import type { BindingAdoption, BindingResult } from "../../src/catalog/bindings";
import { BillingAdminOperations } from "../../src/operations/admin";
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

const adoption: BindingAdoption = {
	productKey: "premium",
	name: "Premium",
	kind: "subscription",
	entitlementKey: "premium",
	credits: 100,
	externalProductId: "prod_test",
	externalPriceId: "price_test",
};
const binding: BindingResult = {
	productId: "00000000-0000-4000-8000-000000000001",
	storeProductId: "00000000-0000-4000-8000-000000000002",
	productKey: "premium",
	externalProductId: "prod_test",
	externalPriceId: "price_test",
	active: true,
};

function bindingsApp(dependencies: Pick<AppDependencies, "catalogBindings"> = {}) {
	return createApp({
		env,
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
		...dependencies,
	});
}

const operatorHeaders = {
	authorization: "Bearer secret",
	"x-billing-operator-key": "operator-secret-key",
	"x-billing-actor": "operator-test",
	"idempotency-key": "adopt-1",
	"content-type": "application/json",
};

describe("catalog binding routes", () => {
	it("lists bindings and hands the actor, key and input to the adoption service", async () => {
		const calls: Array<{ input: BindingAdoption; actor: string; key: string }> = [];
		const app = withOpenApiAssertions(
			bindingsApp({
				catalogBindings: {
					list: async () => [binding],
					adopt: async (_project, input, actor, key) => {
						calls.push({ input, actor, key });
						return binding;
					},
				},
			}),
		);

		const listed = await testRequest(app, "/v1/admin/catalog/bindings", {
			headers: operatorHeaders,
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ success: true, data: [binding] });

		const adopted = await testRequest(app, "/v1/admin/catalog/bindings/adopt", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify(adoption),
		});
		expect(adopted.status).toBe(200);
		expect(await adopted.json()).toEqual({ success: true, data: binding });
		expect(calls).toEqual([{ input: adoption, actor: "operator-test", key: "adopt-1" }]);
	});

	it("rejects an adoption without an actor or with unknown fields", async () => {
		const app = withOpenApiAssertions(
			bindingsApp({
				catalogBindings: {
					list: async () => [],
					adopt: async () => binding,
				},
			}),
		);
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;
		const missingActor = await testRequest(app, "/v1/admin/catalog/bindings/adopt", {
			method: "POST",
			headers: withoutActor,
			body: JSON.stringify(adoption),
		});
		expect(missingActor.status).toBe(400);
		const extra = await testRequest(app, "/v1/admin/catalog/bindings/adopt", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ ...adoption, active: false }),
		});
		expect(extra.status).toBe(400);
	});

	it("answers NOT_CONFIGURED when no bindings service is wired", async () => {
		const response = await testRequest(bindingsApp(), "/v1/admin/catalog/bindings", {
			headers: operatorHeaders,
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "NOT_CONFIGURED" },
		});
	});
});
