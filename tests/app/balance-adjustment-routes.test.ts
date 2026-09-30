import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import {
	type AdministrativeDebitRecord,
	type BalanceAdjustmentServiceLike,
	balanceAdjustmentError,
	type OperatorGrantRecord,
} from "../../src/billing/balance-adjustments";
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

const operatorHeaders = {
	authorization: "Bearer secret",
	"x-billing-operator-key": "operator-secret-key",
	"x-billing-actor": "support@example.com",
	"content-type": "application/json",
};

const grant: OperatorGrantRecord = {
	id: "44444444-4444-4444-8444-444444444444",
	billingAccountId: "acct_1",
	featureKey: "ai_credits",
	entityId: null,
	allocationId: "17",
	quantity: "25",
	expiresAt: null,
	status: "active",
	consumedQuantity: "0",
	heldQuantity: "0",
	reversedQuantity: "0",
	availableQuantity: "25",
	actor: "support@example.com",
	reason: "Outage goodwill",
	createdAt: "2026-09-29T00:00:00.000Z",
	revocation: null,
};

const debit: AdministrativeDebitRecord = {
	id: "55555555-5555-4555-8555-555555555555",
	billingAccountId: "acct_1",
	actor: "support@example.com",
	reason: "Duplicate goodwill credit",
	createdAt: "2026-09-29T00:00:00.000Z",
	allocations: [
		{
			allocationId: "17",
			featureKey: "ai_credits",
			entityId: null,
			sourceKind: "operator",
			quantity: "5",
		},
	],
};

function recordingService(overrides: Partial<BalanceAdjustmentServiceLike> = {}) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const record =
		<T>(method: string, result: T) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return Promise.resolve(result);
		};
	const service: BalanceAdjustmentServiceLike = {
		grantOperatorBalance: record("grantOperatorBalance", { duplicate: false, grant }),
		revokeOperatorGrant: record("revokeOperatorGrant", {
			duplicate: false,
			grant: {
				...grant,
				status: "revoked" as const,
				revocation: {
					actor: "support@example.com",
					reason: "Granted in error",
					revokedAt: "2026-09-29T01:00:00.000Z",
					revokedQuantity: "25",
				},
			},
		}),
		listOperatorGrants: record("listOperatorGrants", { items: [grant], nextCursor: "next" }),
		getOperatorGrant: record("getOperatorGrant", grant),
		debitAllocations: record("debitAllocations", { duplicate: false, debit }),
		listAdministrativeDebits: record("listAdministrativeDebits", {
			items: [debit],
			nextCursor: null,
		}),
		...overrides,
	};
	return { calls, service };
}

function adjustmentApp(service: BalanceAdjustmentServiceLike) {
	return withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("acme")],
				credentials: { secret: "acme" },
			}),
			balanceAdjustmentService: service,
		}),
	);
}

describe("balance adjustment routes", () => {
	it("grants only with the operator key, an actor and an idempotency key", async () => {
		const { calls, service } = recordingService();
		const app = adjustmentApp(service);
		const body = JSON.stringify({
			featureKey: "ai_credits",
			quantity: "25",
			expiresAt: "2026-12-31T00:00:00.000Z",
			reason: "Outage goodwill",
		});
		const post = (headers: Record<string, string>) =>
			testRequest(app, "/v1/admin/operator-grants/acct_1", { method: "POST", headers, body });
		const { "x-billing-operator-key": _key, ...withoutOperator } = operatorHeaders;
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;

		const noOperator = await post({ ...withoutOperator, "idempotency-key": "grant-1" });
		const noActor = await post({ ...withoutActor, "idempotency-key": "grant-1" });
		const noKey = await post(operatorHeaders);
		const granted = await post({ ...operatorHeaders, "idempotency-key": "grant-1" });

		expect(noOperator.status).toBe(401);
		expect(noActor.status).toBe(400);
		expect(noKey.status).toBe(400);
		expect(granted.status).toBe(201);
		expect((await granted.json()).data).toEqual({ duplicate: false, grant });
		expect(calls).toEqual([
			{
				method: "grantOperatorBalance",
				args: [
					expect.objectContaining({ projectInstanceKey: "acme" }),
					{
						billingAccountId: "acct_1",
						featureKey: "ai_credits",
						quantity: "25",
						entityId: null,
						expiresAt: new Date("2026-12-31T00:00:00.000Z"),
						reason: "Outage goodwill",
						actor: "support@example.com",
						idempotencyKey: "grant-1",
					},
				],
			},
		]);
	});

	it("answers a replayed grant with 200", async () => {
		const { service } = recordingService({
			grantOperatorBalance: () => Promise.resolve({ duplicate: true, grant }),
		});
		const response = await testRequest(adjustmentApp(service), "/v1/admin/operator-grants/acct_1", {
			method: "POST",
			headers: { ...operatorHeaders, "idempotency-key": "grant-1" },
			body: JSON.stringify({ featureKey: "ai_credits", quantity: "25", reason: "Outage goodwill" }),
		});

		expect(response.status).toBe(200);
		expect((await response.json()).data.duplicate).toBe(true);
	});

	it("rejects unknown fields, a caller project selector and a missing reason before the service", async () => {
		const { calls, service } = recordingService();
		const app = adjustmentApp(service);
		const headers = { ...operatorHeaders, "idempotency-key": "grant-1" };
		const post = (body: unknown) =>
			testRequest(app, "/v1/admin/operator-grants/acct_1", {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

		const unknown = await post({
			featureKey: "ai_credits",
			quantity: "1",
			reason: "x",
			remaining: "100",
		});
		const selector = await post({
			featureKey: "ai_credits",
			quantity: "1",
			reason: "x",
			projectId: "other",
		});
		const noReason = await post({ featureKey: "ai_credits", quantity: "1" });

		expect([unknown.status, selector.status, noReason.status]).toEqual([400, 400, 400]);
		expect(calls).toEqual([]);
	});

	it("revokes a grant by account and grant id", async () => {
		const { calls, service } = recordingService();
		const response = await testRequest(
			adjustmentApp(service),
			`/v1/admin/operator-grants/acct_1/${grant.id}/revoke`,
			{
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "revoke-1" },
				body: JSON.stringify({ reason: "Granted in error" }),
			},
		);

		expect(response.status).toBe(200);
		expect((await response.json()).data.grant.status).toBe("revoked");
		expect(calls[0]?.args[1]).toEqual({
			billingAccountId: "acct_1",
			grantId: grant.id,
			reason: "Granted in error",
			actor: "support@example.com",
			idempotencyKey: "revoke-1",
		});
	});

	it("maps a missing grant to 404 and a second revocation to 409", async () => {
		const missing = recordingService({
			getOperatorGrant: () => Promise.reject(balanceAdjustmentError("OPERATOR_GRANT_NOT_FOUND")),
		});
		const revoked = recordingService({
			revokeOperatorGrant: () =>
				Promise.reject(balanceAdjustmentError("OPERATOR_GRANT_ALREADY_REVOKED")),
		});

		const read = await testRequest(
			adjustmentApp(missing.service),
			`/v1/admin/operator-grants/acct_1/${grant.id}`,
			{ headers: operatorHeaders },
		);
		const revoke = await testRequest(
			adjustmentApp(revoked.service),
			`/v1/admin/operator-grants/acct_1/${grant.id}/revoke`,
			{
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "revoke-2" },
				body: JSON.stringify({ reason: "Again" }),
			},
		);

		expect(read.status).toBe(404);
		expect((await read.json()).error.code).toBe("OPERATOR_GRANT_NOT_FOUND");
		expect(revoke.status).toBe(409);
		expect((await revoke.json()).error.code).toBe("OPERATOR_GRANT_ALREADY_REVOKED");
	});

	it("lists grants and debits with the cursor and limit", async () => {
		const { calls, service } = recordingService();
		const app = adjustmentApp(service);

		const grants = await testRequest(app, "/v1/admin/operator-grants/acct_1?limit=5&cursor=abc", {
			headers: operatorHeaders,
		});
		const debits = await testRequest(app, "/v1/admin/administrative-debits/acct_1", {
			headers: operatorHeaders,
		});

		expect(await grants.json()).toEqual({
			success: true,
			data: [grant],
			pagination: { nextCursor: "next" },
		});
		expect(await debits.json()).toEqual({
			success: true,
			data: [debit],
			pagination: { nextCursor: null },
		});
		expect(calls.map((call) => call.args.slice(1))).toEqual([
			["acct_1", { limit: 5, cursor: "abc" }],
			["acct_1", { limit: 25, cursor: null }],
		]);
	});

	it("debits named allocations and bounds the allocation list", async () => {
		const { calls, service } = recordingService();
		const app = adjustmentApp(service);
		const post = (body: unknown) =>
			testRequest(app, "/v1/admin/administrative-debits/acct_1", {
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "debit-1" },
				body: JSON.stringify(body),
			});

		const debited = await post({
			reason: "Duplicate goodwill credit",
			allocations: [{ allocationId: "17", quantity: "5" }],
		});
		const empty = await post({ reason: "x", allocations: [] });
		const tooMany = await post({
			reason: "x",
			allocations: Array.from({ length: 21 }, (_, index) => ({
				allocationId: String(index + 1),
				quantity: "1",
			})),
		});
		const notAnId = await post({
			reason: "x",
			allocations: [{ allocationId: "abc", quantity: "1" }],
		});
		// Above the bigint range an id would fail in SQL instead of in validation.
		const beyondBigint = await post({
			reason: "x",
			allocations: [{ allocationId: "9223372036854775808", quantity: "1" }],
		});

		expect(debited.status).toBe(201);
		expect((await debited.json()).data).toEqual({ duplicate: false, debit });
		expect([empty.status, tooMany.status, notAnId.status, beyondBigint.status]).toEqual([
			400, 400, 400, 400,
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args[1]).toEqual({
			billingAccountId: "acct_1",
			allocations: [{ allocationId: "17", quantity: "5" }],
			reason: "Duplicate goodwill credit",
			actor: "support@example.com",
			idempotencyKey: "debit-1",
		});
	});
});
