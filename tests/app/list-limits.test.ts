import { expect, it } from "bun:test";
import type { OpenAPIObject } from "openapi3-ts/oas31";
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

/** `/v1` reads whose contract publishes a `limit` query parameter. */
function limitedLists(document: OpenAPIObject): string[] {
	return Object.entries(document.paths ?? {}).flatMap(([path, item]) => {
		const operation = (item as { get?: { parameters?: { in: string; name: string }[] } }).get;
		const takesLimit = operation?.parameters?.some(
			(parameter) => parameter.in === "query" && parameter.name === "limit",
		);
		return path.startsWith("/v1/") && takesLimit ? [path] : [];
	});
}

it("refuses a list limit that is not written in decimal digits before any service runs", async () => {
	const calls: string[] = [];
	const stub = <T>() =>
		new Proxy(
			{},
			{
				get: (_target, name) => async () => {
					calls.push(String(name));
					return {};
				},
			},
		) as T;
	const app = withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("acme")],
				credentials: { secret: "acme" },
			}),
			controlsEnterpriseService: stub<NonNullable<AppDependencies["controlsEnterpriseService"]>>(),
			promotionService: stub<NonNullable<AppDependencies["promotionService"]>>(),
			trialService: stub<NonNullable<AppDependencies["trialService"]>>(),
			balanceAdjustmentService: stub<NonNullable<AppDependencies["balanceAdjustmentService"]>>(),
			billingInsightsService: stub<NonNullable<AppDependencies["billingInsightsService"]>>(),
			adminBillingReader: stub<NonNullable<AppDependencies["adminBillingReader"]>>(),
		}),
	);
	const paths = limitedLists(await generateOpenApi("0.0.0-test"));
	expect(paths.length).toBeGreaterThan(8);
	for (const path of paths) {
		const route = path.replace(/\{[A-Za-z]+\}/g, "acct_1");
		for (const limit of ["0x2", "1e1", "2.0", "+2"]) {
			const response = await testRequest(app, `${route}?limit=${encodeURIComponent(limit)}`, {
				headers: {
					authorization: "Bearer secret",
					"x-billing-operator-key": "operator-secret-key",
				},
			});
			expect(response.status, `${path} limit=${limit}`).toBe(400);
		}
	}
	expect(calls).toEqual([]);
});
