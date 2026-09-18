import { describe, expect, it } from "bun:test";
import type { OperationObject } from "openapi3-ts/oas31";
import { createApp } from "../../src/app";
import type { StripeBillingServiceLike } from "../../src/app/types";
import type { AvailableActionFacts } from "../../src/billing/insights";
import { generateOpenApi } from "../../src/composition/openapi";
import type { RuntimeConnectionResolver } from "../../src/projects/connections";
import type {
	BillingAccountAvailableActions,
	ProviderEnvironmentCapabilities,
} from "../../src/providers/capability-read-types";
import { createProviderCapabilityReads } from "../../src/providers/capability-reads";
import { createProviderRegistry } from "../../src/providers/registry";
import {
	type FixtureBillingEnv as BillingEnv,
	fixtureConnections,
	type ProjectConnectionFixture,
} from "../../src/testing/connection-fixtures";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const stripeFixture: ProjectConnectionFixture = {
	projectInstanceKey: "voysee",
	projectionUrl: "https://voysee.example.com",
	projectionSecret: "voysee-projection-secret",
	stripe: {
		accountIdentity: "acct_1Voysee",
		secretKey: "sk_test_voysee",
		webhookSecret: "whsec_voysee",
		checkoutSuccessUrl: "https://voysee.example.com/success",
		checkoutCancelUrl: "https://voysee.example.com/cancel",
		portalReturnUrl: "https://voysee.example.com/account",
	},
};

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	postgresPreparedStatements: true,
	authMode: "api_key",
	operatorApiKey: "operator-secret-key",
	trustGatewayProjectHeader: false,
	connectionFixtures: [stripeFixture],
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

/** Project credentials only: neither read may ask for the operator key. */
const headers = { authorization: "Bearer secret" };
const capabilitiesPath = "/v1/admin/providers/capabilities";
const resolver = () =>
	projectContextResolver({
		contexts: [projectInstanceContext("voysee")],
		credentials: { secret: "voysee" },
	});

function capabilityApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
	return withOpenApiAssertions(
		createApp({ env, projectContextResolver: resolver(), ...overrides }),
	);
}

async function environment(response: Response): Promise<ProviderEnvironmentCapabilities> {
	expect(response.status).toBe(200);
	const body = (await response.json()) as { success: true; data: ProviderEnvironmentCapabilities };
	expect(body.success).toBe(true);
	return body.data;
}

/** A provider service that fails the test if a capability read ever touches it. */
const untouchableStripe = new Proxy({} as StripeBillingServiceLike, {
	get(_target, property) {
		throw new Error(`capability reads must not use the Stripe service (${String(property)})`);
	},
});

describe("provider capability routes", () => {
	it("reports admitted providers from persisted connections with the project key alone", async () => {
		const app = capabilityApp({ connections: fixtureConnections(env.connectionFixtures) });

		const response = await testRequest(app, capabilitiesPath, { headers });
		const text = await response.clone().text();
		const data = await environment(response);

		// The project key alone reads this route, so it never carries a catalog section or keys.
		expect(Object.keys(data).sort()).toEqual(["generatedAt", "providers", "schemaVersion"]);
		for (const entry of data.providers)
			expect(Object.keys(entry).sort()).toEqual([
				"channel",
				"connection",
				"connectionKind",
				"operations",
				"provider",
			]);
		expect(text).not.toContain("paddle");
		expect(data.providers.map((entry) => entry.provider)).toEqual(["apple", "google", "stripe"]);
		const [apple, , stripe] = data.providers;
		expect(stripe?.connection).toEqual({
			configured: true,
			enabled: true,
			validated: true,
			validatedAt: null,
			accountIdentity: "acct_1Voysee",
		});
		expect(stripe?.operations.find((entry) => entry.operation === "checkout.hosted")?.outcome).toBe(
			"available",
		);
		expect(apple?.connection).toMatchObject({ configured: false, enabled: false });
		expect(
			apple?.operations.find((entry) => entry.operation === "purchase.verify")?.reasons[0]?.code,
		).toBe("CONNECTION_DISABLED");
	});

	it("reports a legacy or project override service as configured without using it", async () => {
		const legacyApp = capabilityApp({ stripeBillingService: untouchableStripe });
		const legacy = await environment(await testRequest(legacyApp, capabilitiesPath, { headers }));
		expect(legacy.providers.find((entry) => entry.provider === "stripe")?.connection).toEqual({
			configured: true,
			enabled: true,
			validated: true,
			validatedAt: null,
			accountIdentity: null,
		});

		const removed = await environment(
			await testRequest(
				capabilityApp({
					stripeBillingService: untouchableStripe,
					projectProviderServices: { voysee: { stripeBillingService: null } },
				}),
				capabilitiesPath,
				{ headers },
			),
		);
		const stripe = removed.providers.find((entry) => entry.provider === "stripe");
		expect(stripe?.connection).toMatchObject({ configured: false });
	});

	it("never resolves a connection and reports none when the resolver cannot describe", async () => {
		let resolved = 0;
		const connections: RuntimeConnectionResolver = {
			async resolve() {
				resolved += 1;
				throw new Error("capability reads must not resolve connections");
			},
		};
		const data = await environment(
			await testRequest(capabilityApp({ connections }), capabilitiesPath, { headers }),
		);

		expect(resolved).toBe(0);
		expect(data.providers.map((entry) => entry.connection)).toEqual([null, null, null]);
		for (const entry of data.providers) {
			const ingest = entry.operations.find((operation) => operation.operation === "webhook.ingest");
			expect(ingest).toMatchObject({ outcome: "undetermined", blockingLayer: null });
		}
	});

	it("serves available actions, including for an unknown billing account", async () => {
		const accounts: Record<string, AvailableActionFacts> = {
			acct_1: {
				customerExists: true,
				subscriptions: [
					{
						externalSubscriptionId: "sub_1",
						provider: "stripe",
						channel: "web",
						status: "active",
						planKey: "pro",
						currentPeriodEnd: "2026-10-18T12:00:00.000Z",
						cancelAtPeriodEnd: false,
						pendingChange: {
							changeId: "11111111-1111-4111-8111-111111111111",
							status: "processing",
							effectiveMode: "immediate",
							effectiveAt: "2026-09-18T12:00:00.000Z",
						},
					},
				],
			},
		};
		const requested: string[] = [];
		const connections = fixtureConnections(env.connectionFixtures);
		const reads = createProviderCapabilityReads({
			registry: createProviderRegistry({
				connections,
				getRepository: () => {
					throw new Error("capability reads must not build provider services");
				},
			}),
			facts: {
				async getAvailableActionFacts(_project, billingAccountId) {
					requested.push(billingAccountId);
					return accounts[billingAccountId] ?? { customerExists: false, subscriptions: [] };
				},
			},
		});
		const app = capabilityApp({ connections, providerCapabilityReads: reads });

		const known = await testRequest(app, "/v1/billing-accounts/acct_1/available-actions", {
			headers,
		});
		const unknown = await testRequest(app, "/v1/billing-accounts/acct_missing/available-actions", {
			headers,
		});

		expect(known.status).toBe(200);
		expect(unknown.status).toBe(200);
		const knownData = ((await known.json()) as { data: BillingAccountAvailableActions }).data;
		const unknownData = ((await unknown.json()) as { data: BillingAccountAvailableActions }).data;
		expect(requested).toEqual(["acct_1", "acct_missing"]);
		expect(knownData.subscriptions.map((entry) => [entry.id, entry.pendingChange?.status])).toEqual(
			[["sub_1", "processing"]],
		);
		expect(knownData.subscriptions[0]?.actions.map((entry) => entry.outcome)).toEqual([
			"available",
			"available",
			"available",
		]);
		expect(unknownData).toMatchObject({
			billingAccountId: "acct_missing",
			customerExists: false,
			subscriptions: [],
		});
		expect(new Set(unknownData.account.map((entry) => entry.provider))).toEqual(
			new Set(["apple", "google", "stripe"]),
		);
	});

	it("requires a project credential and applies the admin limiter", async () => {
		const app = capabilityApp({
			env: { ...env, rateLimit: { ...env.rateLimit, adminLimit: 1 } },
			connections: fixtureConnections(env.connectionFixtures),
		});

		expect((await testRequest(app, capabilitiesPath)).status).toBe(401);
		expect((await testRequest(app, capabilitiesPath, { headers })).status).toBe(200);
		expect((await testRequest(app, capabilitiesPath, { headers })).status).toBe(429);
	});

	it("documents both reads with project-key security and no operator key", async () => {
		const document = await generateOpenApi("0.0.0-test");
		for (const [path, tag] of [
			[capabilitiesPath, "admin"],
			["/v1/billing-accounts/{billingAccountId}/available-actions", "customer"],
		] as const) {
			const operation = (document.paths?.[path] as { get?: OperationObject } | undefined)?.get;
			expect(operation?.tags).toEqual([tag]);
			expect(operation?.security).toEqual([{ projectKey: [] }, { gatewayProject: [] }]);
			expect(
				(operation?.parameters ?? []).filter(
					(parameter) => (parameter as { in?: string }).in === "header",
				),
			).toEqual([]);
		}
	});
});
