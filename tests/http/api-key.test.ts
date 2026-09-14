import { describe, expect, it } from "bun:test";
import { createApp as createBillingApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/types";
import { EntitlementService } from "../../src/billing/entitlements";
import type { BillingEnv } from "../../src/env";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	postgresPreparedStatements: true,
	authMode: "api_key",
	operatorApiKey: null,
	trustGatewayProjectHeader: false,
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

function createApp(dependencies: AppDependencies) {
	return withOpenApiAssertions(createBillingApp(dependencies));
}

function entitlementServiceRecording(projects: string[]): EntitlementService {
	return new EntitlementService({
		getEntitlementSnapshot(project, billingAccountId) {
			projects.push(project.projectInstanceKey);
			return Promise.resolve({
				billingAccountId: `${project.projectInstanceKey}:${billingAccountId}`,
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			});
		},
	});
}

describe("api key authentication", () => {
	it("allows requests with the configured bearer token", async () => {
		const projects: string[] = [];
		const app = createApp({
			env,
			entitlementService: entitlementServiceRecording(projects),
			projectContextResolver: projectContextResolver({ credentials: { secret: "voysee" } }),
		});

		const response = await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
			headers: { authorization: "Bearer secret" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				billingAccountId: "voysee:user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		});
		expect(projects).toEqual(["voysee"]);
	});

	it("rejects missing or wrong bearer tokens", async () => {
		const projects: string[] = [];
		const resolver = projectContextResolver({ credentials: { secret: "voysee" } });
		const resolveCredential = resolver.resolveCredential.bind(resolver);
		let calls = 0;
		resolver.resolveCredential = async (token) => {
			calls += 1;
			return await resolveCredential(token);
		};
		const app = createApp({
			env,
			entitlementService: entitlementServiceRecording(projects),
			projectContextResolver: resolver,
		});

		const missing = await testRequest(app, "/v1/billing-accounts/user_1/entitlements");
		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({
			success: false,
			error: { code: "UNAUTHORIZED", message: "Invalid billing API key" },
		});
		expect(calls).toBe(0);

		const wrong = await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
			headers: { authorization: "Bearer wrong" },
		});
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({
			success: false,
			error: { code: "UNAUTHORIZED", message: "Invalid billing API key" },
		});
		expect(calls).toBe(1);

		expect(
			(
				await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
					headers: { authorization: "Basic secret" },
				})
			).status,
		).toBe(401);
		expect(
			(
				await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
					headers: { authorization: "Bearer secret " },
				})
			).status,
		).toBe(200);
		expect(
			(
				await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
					headers: { authorization: "bearer secret" },
				})
			).status,
		).toBe(200);
		expect(projects).toEqual(["voysee", "voysee"]);
	});

	it("resolves project-scoped bearer tokens onto request context", async () => {
		const projects: string[] = [];
		const contexts = [projectInstanceContext(), projectInstanceContext("wiseley")];
		const app = createApp({
			env,
			entitlementService: entitlementServiceRecording(projects),
			projectContextResolver: projectContextResolver({
				contexts,
				credentials: {
					"voysee-service-key-123456": "voysee",
					"wiseley-service-key-123456": "wiseley",
				},
			}),
		});

		const voysee = await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
			headers: { authorization: "Bearer voysee-service-key-123456" },
		});
		const wiseley = await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
			headers: { authorization: "Bearer wiseley-service-key-123456" },
		});

		expect(voysee.status).toBe(200);
		expect(await voysee.json()).toEqual({
			success: true,
			data: {
				billingAccountId: "voysee:user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		});
		expect(wiseley.status).toBe(200);
		expect(await wiseley.json()).toEqual({
			success: true,
			data: {
				billingAccountId: "wiseley:user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		});
		expect(projects).toEqual(["voysee", "wiseley"]);
	});

	it("fails closed when project persistence is unavailable", async () => {
		const app = createApp({
			env,
			projectContextResolver: projectContextResolver({ unavailable: true }),
		});

		const response = await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
			headers: { authorization: "Bearer test-api-key" },
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PROJECT_CONTEXT_UNAVAILABLE",
				message: "Billing project context is unavailable",
			},
		});
	});

	it("rejects suspended and internal project instances", async () => {
		for (const context of [
			projectInstanceContext("voysee", { lifecycleStatus: "suspended" }),
			projectInstanceContext("voysee", { environment: "internal", internalProject: true }),
		]) {
			const app = createApp({
				env,
				projectContextResolver: projectContextResolver({ contexts: [context] }),
			});

			const response = await testRequest(app, "/v1/billing-accounts/user_1/entitlements", {
				headers: { authorization: "Bearer test-api-key" },
			});

			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				success: false,
				error: { code: "UNAUTHORIZED", message: "Invalid billing API key" },
			});
		}
	});
});
