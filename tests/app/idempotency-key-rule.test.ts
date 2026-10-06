import { expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/types";
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

// Code entry is limited to a few tries a minute; this file sends one request per key and route.
const unthrottled: BillingEnv = { ...env, rateLimit: { ...env.rateLimit, verifyLimit: 1000 } };
const previewToken = "11111111-1111-4111-8111-111111111111";
const backend = { authorization: "Bearer secret", "content-type": "application/json" };
const operator = {
	...backend,
	"x-billing-operator-key": "operator-secret-key",
	"x-billing-actor": "ops@example.com",
};

/** One mutation from each family of `/v1` routes that takes the caller's key, with a valid body. */
const mutations: Array<{ path: string; headers: Record<string, string>; body: unknown }> = [
	{
		path: "/v1/billing-accounts/acct_1/usage/consume",
		headers: backend,
		body: { featureId: "credits", value: "1" },
	},
	{
		path: "/v1/billing-accounts/acct_1/usage/reservations",
		headers: backend,
		body: { featureKey: "credits", quantity: "1" },
	},
	{
		path: "/v1/billing-accounts/acct_1/promotion-redemptions",
		headers: backend,
		body: { code: "launch", channel: "web" },
	},
	{ path: "/v1/billing-accounts/acct_1/trials", headers: backend, body: { planKey: "pro" } },
	{
		path: "/v1/admin/operator-grants/acct_1",
		headers: operator,
		body: { featureKey: "credits", quantity: "1", reason: "goodwill" },
	},
	{
		path: "/v1/billing-accounts/acct_1/commercial-actions",
		headers: backend,
		body: { previewToken },
	},
	{
		path: "/v1/billing-accounts/acct_1/subscriptions/sub_1/changes",
		headers: backend,
		body: { targetPlanKey: "pro" },
	},
];

function fixture() {
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
	const app = createApp({
		env: unthrottled,
		connections: fixtureConnections(env.connectionFixtures),
		projectContextResolver: projectContextResolver({
			contexts: [projectInstanceContext("acme")],
			credentials: { secret: "acme" },
		}),
		meteringService: stub<NonNullable<AppDependencies["meteringService"]>>(),
		usageApiService: stub<NonNullable<AppDependencies["usageApiService"]>>(),
		promotionService: stub<NonNullable<AppDependencies["promotionService"]>>(),
		trialService: stub<NonNullable<AppDependencies["trialService"]>>(),
		balanceAdjustmentService: stub<NonNullable<AppDependencies["balanceAdjustmentService"]>>(),
	});
	return { app, calls };
}

const refusal = {
	code: "INVALID_REQUEST",
	message:
		"Idempotency-Key header must contain between 1 and 200 characters with no surrounding whitespace",
};

it("refuses the same idempotency keys on every /v1 mutation, before any service runs", async () => {
	const { app, calls } = fixture();
	const wrapped = withOpenApiAssertions(app);
	// HTTP itself strips spaces and tabs around a header value; these are what still arrives.
	const refused: Array<[string, string | undefined]> = [
		["missing", undefined],
		["longer than 200 characters", "k".repeat(201)],
		["no-break space padding", "\u00a0order-1\u00a0"],
		["vertical tab padding", "\u000border-1"],
		["form feed padding", "order-1\u000c"],
	];
	for (const { path, headers, body } of mutations) {
		for (const [name, key] of refused) {
			const response = await testRequest(wrapped, path, {
				method: "POST",
				headers: key === undefined ? headers : { ...headers, "idempotency-key": key },
				body: JSON.stringify(body),
			});
			const { error } = await response.json();
			expect({
				path,
				name,
				status: response.status,
				code: error.code,
				message: error.message,
			}).toEqual({ path, name, status: 400, ...refusal });
		}
	}
	expect(calls).toEqual([]);
});

it("takes a key exactly as sent: inner characters are the caller's, and nothing is trimmed", async () => {
	const seen: Array<string | undefined> = [];
	const key = "order 42/retry#1";
	const recording = <T>() =>
		new Proxy(
			{},
			{
				get:
					() =>
					async (_project: unknown, input: { operationId?: string; idempotencyKey?: string }) => {
						seen.push(input.operationId ?? input.idempotencyKey);
						return {};
					},
			},
		) as T;
	const app = createApp({
		env: unthrottled,
		connections: fixtureConnections(env.connectionFixtures),
		projectContextResolver: projectContextResolver({
			contexts: [projectInstanceContext("acme")],
			credentials: { secret: "acme" },
		}),
		meteringService: recording<NonNullable<AppDependencies["meteringService"]>>(),
		usageApiService: recording<NonNullable<AppDependencies["usageApiService"]>>(),
		promotionService: recording<NonNullable<AppDependencies["promotionService"]>>(),
		trialService: recording<NonNullable<AppDependencies["trialService"]>>(),
		balanceAdjustmentService: recording<NonNullable<AppDependencies["balanceAdjustmentService"]>>(),
	});
	// The five routes whose service is injected here; the Stripe pair is covered in provider-guards.
	for (const { path, headers, body } of mutations.slice(0, 5)) {
		await testRequest(app, path, {
			method: "POST",
			headers: { ...headers, "idempotency-key": key },
			body: JSON.stringify(body),
		});
	}
	expect(seen).toEqual([key, key, key, key, key]);
});
