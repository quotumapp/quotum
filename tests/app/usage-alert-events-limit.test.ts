import { expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/types";
import { generateOpenApi } from "../../src/composition/openapi";
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
		verifyLimit: 2,
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

const path = "/v1/billing-accounts/account-1/usage-alert-events";

type ControlsService = NonNullable<AppDependencies["controlsEnterpriseService"]>;

function fixture() {
	const calls: number[] = [];
	const controls: Partial<ControlsService> = {
		async listUsageAlertEvents(_project, _billingAccountId, limit) {
			calls.push(limit);
			return [];
		},
	};
	const app = withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("acme")],
				credentials: { secret: "acme" },
			}),
			controlsEnterpriseService: controls as ControlsService,
		}),
	);
	return { app, calls };
}

it("supplies the default alert event limit and accepts the documented range", async () => {
	const { app, calls } = fixture();
	for (const value of [undefined, "1", "500", "0007"]) {
		const response = await testRequest(app, value === undefined ? path : `${path}?limit=${value}`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(response.status, String(value)).toBe(200);
	}
	expect(calls).toEqual([100, 1, 500, 7]);
});

it("rejects a malformed or out-of-range alert event limit before the service runs", async () => {
	const { app, calls } = fixture();
	for (const value of ["", "0x2", "1e1", "2.0", "+2", " 2", "0", "-1", "501", "NaN"]) {
		const response = await testRequest(app, `${path}?limit=${encodeURIComponent(value)}`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(response.status, JSON.stringify(value)).toBe(400);
		expect((await response.json()).error.code).toBe("INVALID_REQUEST");
	}
	expect(calls).toEqual([]);
});

it("publishes the alert event limit as the bounded integer the route enforces", async () => {
	const document = await generateOpenApi("0.0.0-test");
	const paths = document.paths ?? {};
	const item = paths["/v1/billing-accounts/{billingAccountId}/usage-alert-events"] as {
		get: { parameters: object[] };
	};
	expect(item.get.parameters).toContainEqual({
		in: "query",
		name: "limit",
		required: false,
		schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
	});
});
