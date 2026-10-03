import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/types";
import { NotFoundBillingError } from "../../src/billing/errors";
import type { ProviderOperation } from "../../src/billing/provider-operations";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { projectContextResolver } from "../helpers/project-context";

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	postgresPreparedStatements: true,
	authMode: "api_key",
	operatorApiKey: "operator-secret-key",
	trustGatewayProjectHeader: false,
	connectionFixtures: [],
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

const operation: ProviderOperation = {
	id: "00000000-0000-4000-8000-000000000099",
	billingAccountId: "payer",
	provider: "stripe",
	providerAccountId: "acct_original",
	connectionVersionId: "00000000-0000-4000-8000-000000000098",
	idempotencyKey: "private-key",
	resourceKey: "private-resource",
	operation: "checkout.create",
	requestHash: "a".repeat(64),
	request: { email: "private@example.com" },
	status: "requires_review",
	attempts: 1,
	result: null,
	providerObjectId: null,
	errorCode: "PROVIDER_OPERATION_UNCERTAIN",
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
};
function app(reconcile?: AppDependencies["providerOperationReconciler"]) {
	return withOpenApiAssertions(
		createApp({
			env,
			providerOperationReconciler: reconcile,
			projectContextResolver: projectContextResolver({
				credentials: {
					full: "acme",
					readonly: { projectInstanceKey: "acme", access: "read_only" },
				},
			}),
			providerOperationStore: {
				get: async (project, account, id) => {
					expect(project.projectInstanceKey).toBe("acme");
					if (account !== operation.billingAccountId || id !== operation.id)
						throw new NotFoundBillingError("Provider operation was not found");
					return operation;
				},
			},
		}),
	);
}
const headers = { authorization: "Bearer readonly" };
describe("provider operation receipts", () => {
	it("allows read-only credentials without leaking private intent or connection details", async () => {
		const response = await testRequest(
			app(),
			`/v1/billing-accounts/payer/provider-operations/${operation.id}`,
			{ headers },
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.data).toEqual({
			id: operation.id,
			provider: "stripe",
			operation: "checkout.create",
			status: "requires_review",
			providerObjectId: null,
			errorCode: "PROVIDER_OPERATION_UNCERTAIN",
			createdAt: operation.createdAt,
			updatedAt: operation.updatedAt,
		});
	});
	it("does not disclose another account's receipt and rejects invalid IDs", async () => {
		const service = app();
		expect(
			(
				await testRequest(
					service,
					`/v1/billing-accounts/other/provider-operations/${operation.id}`,
					{ headers },
				)
			).status,
		).toBe(404);
		expect(
			(
				await testRequest(service, `/v1/billing-accounts/payer/provider-operations/not-a-uuid`, {
					headers,
				})
			).status,
		).toBe(400);
	});
	it("requires project authentication", async () => {
		expect(
			(await testRequest(app(), `/v1/billing-accounts/payer/provider-operations/${operation.id}`))
				.status,
		).toBe(401);
	});
});

describe("operator provider operation reconciliation", () => {
	const path = `/v1/admin/billing-accounts/payer/provider-operations/${operation.id}/reconcile`;
	it("requires a full project credential, the operator key and an actor before observation", async () => {
		let calls = 0;
		const service = app(async () => {
			calls++;
			return operation;
		});
		for (const [headers, status] of [
			[
				{
					authorization: "Bearer readonly",
					"x-billing-operator-key": "operator-secret-key",
					"x-billing-actor": "tester",
				},
				403,
			],
			[{ authorization: "Bearer full", "x-billing-actor": "tester" }, 401],
			[{ authorization: "Bearer full", "x-billing-operator-key": "operator-secret-key" }, 400],
		] as const)
			expect((await testRequest(service, path, { method: "POST", headers })).status).toBe(status);
		expect(calls).toBe(0);
	});
	it("passes scoped identity and actor, returning only the safe receipt", async () => {
		const service = app(async (project, account, id, actor) => {
			expect([project.projectInstanceKey, account, id, actor]).toEqual([
				"acme",
				"payer",
				operation.id,
				"operator:test",
			]);
			return {
				...operation,
				status: "succeeded",
				providerObjectId: "txn_recovered",
				result: { secret: "never expose" },
			};
		});
		const response = await testRequest(service, path, {
			method: "POST",
			headers: {
				authorization: "Bearer full",
				"x-billing-operator-key": "operator-secret-key",
				"x-billing-actor": "operator:test",
			},
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.data).toMatchObject({ status: "succeeded", providerObjectId: "txn_recovered" });
		expect(body.data.result).toBeUndefined();
		expect(body.data.request).toBeUndefined();
	});
	it("conceals missing operations and reports unavailable recovery without executing", async () => {
		const headers = {
			authorization: "Bearer full",
			"x-billing-operator-key": "operator-secret-key",
			"x-billing-actor": "operator:test",
		};
		expect(
			(
				await testRequest(
					app(async () => {
						throw new NotFoundBillingError("Provider operation was not found");
					}),
					path,
					{ method: "POST", headers },
				)
			).status,
		).toBe(404);
		expect((await testRequest(app(), path, { method: "POST", headers })).status).toBe(501);
	});
});
