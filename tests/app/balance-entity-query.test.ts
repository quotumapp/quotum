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

const path = "/v1/billing-accounts/account-1/balances/credits";

type Metering = NonNullable<AppDependencies["meteringService"]>;

function fixture() {
	const calls: Array<string | null | undefined> = [];
	const metering: Partial<Metering> = {
		async getBalance(_project, _billingAccountId, featureKey, entityId) {
			calls.push(entityId);
			return {
				featureKey,
				unit: "credit",
				scale: 0,
				granted: "10",
				consumed: "0",
				held: "0",
				available: "10",
				breakdown: [],
			};
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
			meteringService: metering as Metering,
		}),
	);
	return { app, calls };
}

it("reads the account balance only when no entity is named", async () => {
	const { app, calls } = fixture();
	for (const query of ["", "?entityId=worker-1", "?entityId=%20worker-1%20"]) {
		const response = await testRequest(app, `${path}${query}`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(response.status, query).toBe(200);
	}
	expect(calls).toEqual([undefined, "worker-1", "worker-1"]);
});

it("refuses an empty or oversized entity instead of answering with the account balance", async () => {
	const { app, calls } = fixture();
	for (const query of ["?entityId=", "?entityId=%20%20", `?entityId=${"x".repeat(257)}`]) {
		const response = await testRequest(app, `${path}${query}`, {
			headers: { authorization: "Bearer secret" },
		});
		expect(response.status, query.slice(0, 20)).toBe(400);
		expect((await response.json()).error.code).toBe("INVALID_REQUEST");
	}
	expect(calls).toEqual([]);
});

it("publishes the entity filter of a balance read as a bounded string", async () => {
	const document = await generateOpenApi("0.0.0-test");
	const paths = document.paths ?? {};
	const item = paths["/v1/billing-accounts/{billingAccountId}/balances/{featureKey}"] as {
		get: { parameters: object[] };
	};
	expect(item.get.parameters).toContainEqual({
		in: "query",
		name: "entityId",
		required: false,
		schema: { type: "string", minLength: 1, maxLength: 256 },
	});
});
