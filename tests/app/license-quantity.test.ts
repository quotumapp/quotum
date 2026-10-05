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

const path = "/v1/billing-accounts/account-1/entities/entity-1/licenses/seats";

function fixture() {
	const calls: number[] = [];
	const app = withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("acme")],
				credentials: { secret: "acme" },
			}),
			controlsEnterpriseService: {
				async checkEntityLicense(_project, input) {
					calls.push(input.requiredQuantity);
					return {
						entityId: input.entityId,
						featureKey: input.featureKey,
						requiredQuantity: input.requiredQuantity,
						assignedQuantity: 1_000_000,
						allowed: true,
					};
				},
			} as NonNullable<AppDependencies["controlsEnterpriseService"]>,
		}),
	);
	return { app, calls };
}

it("accepts decimal license quantities and supplies the default before calling the service", async () => {
	const { app, calls } = fixture();
	for (const [value, expected] of [
		[undefined, 1],
		["1", 1],
		["1000000", 1_000_000],
		["0001", 1],
	] as const) {
		const response = await testRequest(
			app,
			value === undefined ? path : `${path}?quantity=${value}`,
			{ headers: { authorization: "Bearer secret" } },
		);
		expect(response.status).toBe(200);
		expect((await response.json()).data.requiredQuantity).toBe(expected);
	}
	expect(calls).toEqual([1, 1, 1_000_000, 1]);
});

it("rejects malformed or out-of-range quantities before the license service runs", async () => {
	const { app, calls } = fixture();
	for (const value of [
		"",
		"0x10",
		"1e2",
		"2.5",
		"2.0",
		"+2",
		" 2",
		"2 ",
		"0",
		"-1",
		"1000001",
		"99999999999999999999999",
		"NaN",
		"Infinity",
	]) {
		const response = await testRequest(app, `${path}?quantity=${encodeURIComponent(value)}`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(response.status, value).toBe(400);
		expect((await response.json()).error.code).toBe("INVALID_REQUEST");
	}
	expect(calls).toEqual([]);
});

it("preserves unrelated query parameters and publishes the quantity bounds and default", async () => {
	const { app, calls } = fixture();
	const response = await testRequest(app, `${path}?quantity=2&extra=ignored`, {
		headers: { authorization: "Bearer secret" },
	});
	expect(response.status).toBe(200);
	expect(calls).toEqual([2]);
	const document = await generateOpenApi("0.0.0-test");
	const parameters =
		document.paths?.[
			"/v1/billing-accounts/{billingAccountId}/entities/{entityId}/licenses/{featureKey}"
		]?.get?.parameters ?? [];
	const quantity = parameters.find(
		(parameter) => "name" in parameter && parameter.name === "quantity",
	);
	expect(quantity).toMatchObject({
		in: "query",
		required: false,
		schema: { type: "integer", minimum: 1, maximum: 1_000_000, default: 1 },
	});
});
