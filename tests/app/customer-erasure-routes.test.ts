import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import {
	type CustomerErasureRecord,
	type CustomerErasureServiceLike,
	customerErasureError,
} from "../../src/billing/customer-erasures";
import type { BillingLogger } from "../../src/observability/logger";
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
		verifyLimit: 100,
		webhookLimit: 600,
		adminLimit: 100,
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

const erasure: CustomerErasureRecord = {
	id: "77777777-7777-4777-8777-777777777777",
	state: "running",
	basis: "data_subject_request",
	reference: "ticket-1",
	actor: "support@example.com",
	acknowledged: [],
	step: "delete_rows",
	counts: {},
	lastError: null,
	requestedAt: "2026-10-12T00:00:00.000Z",
	completedAt: null,
	tombstoneExpiresAt: "2026-11-11T00:00:00.000Z",
};

const body = { billingAccountId: "user@example.com", basis: "data_subject_request" };

function recordingService(overrides: Partial<CustomerErasureServiceLike> = {}) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const service: CustomerErasureServiceLike = {
		previewCustomerErasure: (...args) => {
			calls.push({ method: "previewCustomerErasure", args });
			return Promise.resolve({
				blockers: [],
				forfeits: { paidBalanceFeatures: 1, lifetimePurchases: 0 },
				requiredAcknowledgements: ["forfeit_paid_balances"],
				rows: { provider_customers: 1 },
			});
		},
		requestCustomerErasure: (...args) => {
			calls.push({ method: "requestCustomerErasure", args });
			return Promise.resolve({ duplicate: false, erasure });
		},
		getCustomerErasure: (...args) => {
			calls.push({ method: "getCustomerErasure", args });
			return Promise.resolve(erasure);
		},
		...overrides,
	};
	return { calls, service };
}

function logs() {
	const entries: Array<{ message: string; fields: unknown }> = [];
	const logger: BillingLogger = {
		info: (message, fields) => {
			entries.push({ message, fields });
		},
		warn: () => {},
		error: () => {},
	};
	return { entries, logger };
}

function erasureApp(service: CustomerErasureServiceLike, logger?: BillingLogger) {
	return withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("acme")],
				credentials: {
					secret: "acme",
					"read-key": { projectInstanceKey: "acme", access: "read_only" },
				},
			}),
			customerErasureService: service,
			...(logger === undefined ? {} : { logger }),
		}),
	);
}

describe("customer erasure routes", () => {
	it("erases only with the operator key, an actor and an idempotency key", async () => {
		const { calls, service } = recordingService();
		const { entries, logger } = logs();
		const app = erasureApp(service, logger);
		const post = (headers: Record<string, string>) =>
			testRequest(app, "/v1/admin/customer-erasures", {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
		const { "x-billing-operator-key": _key, ...withoutOperator } = operatorHeaders;
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;

		const noOperator = await post({ ...withoutOperator, "idempotency-key": "erase-1" });
		const noActor = await post({ ...withoutActor, "idempotency-key": "erase-1" });
		const noKey = await post(operatorHeaders);
		const readOnly = await post({
			...operatorHeaders,
			authorization: "Bearer read-key",
			"idempotency-key": "erase-1",
		});
		const erased = await post({ ...operatorHeaders, "idempotency-key": "erase-1" });

		expect(noOperator.status).toBe(401);
		expect(noActor.status).toBe(400);
		expect(noKey.status).toBe(400);
		expect(readOnly.status).toBe(403);
		expect(erased.status).toBe(201);
		expect((await erased.json()).data).toEqual({ duplicate: false, erasure });
		expect(calls).toEqual([
			{
				method: "requestCustomerErasure",
				args: [
					expect.objectContaining({ projectInstanceKey: "acme" }),
					{
						billingAccountId: "user@example.com",
						basis: "data_subject_request",
						reference: null,
						acknowledge: [],
						actor: "support@example.com",
						idempotencyKey: "erase-1",
					},
				],
			},
		]);
		// The log line names the operation, never the account or the person who asked.
		expect(entries).toHaveLength(1);
		expect(JSON.stringify(entries)).not.toContain("user@example.com");
		expect(JSON.stringify(entries)).not.toContain("support@example.com");
		expect(JSON.stringify(entries)).toContain(erasure.id);
	});

	it("answers a replay with 200 and logs nothing new", async () => {
		const { service } = recordingService({
			requestCustomerErasure: () => Promise.resolve({ duplicate: true, erasure }),
		});
		const { entries, logger } = logs();

		const response = await testRequest(erasureApp(service, logger), "/v1/admin/customer-erasures", {
			method: "POST",
			headers: { ...operatorHeaders, "idempotency-key": "erase-1" },
			body: JSON.stringify(body),
		});

		expect(response.status).toBe(200);
		expect(entries).toEqual([]);
	});

	it("rejects unknown fields, bases and acknowledgements", async () => {
		const { calls, service } = recordingService();
		const app = erasureApp(service);
		const post = (payload: unknown) =>
			testRequest(app, "/v1/admin/customer-erasures", {
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "erase-1" },
				body: JSON.stringify(payload),
			});

		expect((await post({ ...body, reason: "free text" })).status).toBe(400);
		expect((await post({ ...body, basis: "because" })).status).toBe(400);
		expect((await post({ ...body, acknowledge: ["everything"] })).status).toBe(400);
		expect((await post({ ...body, billingAccountId: "" })).status).toBe(400);
		expect((await post({ ...body, reference: "x".repeat(201) })).status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("keeps the billing account id out of every path", async () => {
		const { calls, service } = recordingService();
		const app = erasureApp(service);

		const preview = await testRequest(app, "/v1/admin/customer-erasures/preview", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ billingAccountId: "user@example.com" }),
		});
		const receipt = await testRequest(app, `/v1/admin/customer-erasures/${erasure.id}`, {
			headers: operatorHeaders,
		});

		expect(preview.status).toBe(200);
		expect((await preview.json()).data.requiredAcknowledgements).toEqual(["forfeit_paid_balances"]);
		expect(receipt.status).toBe(200);
		expect((await receipt.json()).data).toEqual(erasure);
		expect(calls.map((call) => call.method)).toEqual([
			"previewCustomerErasure",
			"getCustomerErasure",
		]);
		expect(calls[0]?.args[1]).toBe("user@example.com");
		expect(calls[1]?.args[1]).toBe(erasure.id);
	});

	it("maps each refusal to its status and code", async () => {
		const cases = [
			["CUSTOMER_ERASURE_BLOCKED", 409, { blockers: [{ kind: "subscription", count: 1 }] }],
			["CUSTOMER_ERASURE_ACKNOWLEDGEMENT_REQUIRED", 409, { required: ["forfeit_paid_balances"] }],
			["CUSTOMER_ERASURE_NOT_CONFIGURED", 501, undefined],
			["BILLING_ACCOUNT_ERASED", 409, undefined],
		] as const;
		for (const [code, status, details] of cases) {
			const { service } = recordingService({
				requestCustomerErasure: () => Promise.reject(customerErasureError(code, details)),
			});

			const response = await testRequest(erasureApp(service), "/v1/admin/customer-erasures", {
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "erase-1" },
				body: JSON.stringify(body),
			});

			expect(response.status).toBe(status);
			const payload = await response.json();
			expect(payload.error.code).toBe(code);
			if (details !== undefined) expect(payload.error.details).toEqual(details);
		}
	});

	it("answers an unknown receipt as not found", async () => {
		const { service } = recordingService({
			getCustomerErasure: () => Promise.reject(customerErasureError("CUSTOMER_ERASURE_NOT_FOUND")),
		});

		const response = await testRequest(
			erasureApp(service),
			"/v1/admin/customer-erasures/not-an-erasure",
			{ headers: operatorHeaders },
		);

		expect(response.status).toBe(404);
		expect((await response.json()).error.code).toBe("CUSTOMER_ERASURE_NOT_FOUND");
	});
});
