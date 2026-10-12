import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import {
	type ProviderCustomerUnlinkRecord,
	type ProviderCustomerUnlinkServiceLike,
	providerCustomerUnlinkError,
} from "../../src/billing/provider-customer-unlinks";
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

const unlink: ProviderCustomerUnlinkRecord = {
	id: "66666666-6666-4666-8666-666666666666",
	billingAccountId: "acct_1",
	provider: "stripe",
	externalCustomerId: "cus_old",
	providerAccountId: "acct_stripe",
	linkedAt: "2026-09-01T00:00:00.000Z",
	actor: "support@example.com",
	reason: "Stripe customer was deleted",
	createdAt: "2026-10-12T00:00:00.000Z",
};

const body = {
	provider: "stripe",
	externalCustomerId: "cus_old",
	reason: "Stripe customer was deleted",
};

function recordingService(overrides: Partial<ProviderCustomerUnlinkServiceLike> = {}) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const service: ProviderCustomerUnlinkServiceLike = {
		unlinkProviderCustomer: (...args) => {
			calls.push({ method: "unlinkProviderCustomer", args });
			return Promise.resolve({ duplicate: false, unlink });
		},
		listProviderCustomerUnlinks: (...args) => {
			calls.push({ method: "listProviderCustomerUnlinks", args });
			return Promise.resolve({ items: [unlink], nextCursor: "next" });
		},
		...overrides,
	};
	return { calls, service };
}

function capturingLogger() {
	const entries: Array<{ level: string; message: string; fields: unknown }> = [];
	const logger: BillingLogger = {
		info: (message, fields) => {
			entries.push({ level: "info", message, fields });
		},
		warn: (message, fields) => {
			entries.push({ level: "warn", message, fields });
		},
		error: (message, _error, fields) => {
			entries.push({ level: "error", message, fields });
		},
	};
	return { entries, logger };
}

function unlinkApp(service: ProviderCustomerUnlinkServiceLike, logger?: BillingLogger) {
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
			providerCustomerUnlinkService: service,
			...(logger === undefined ? {} : { logger }),
		}),
	);
}

const path = "/v1/admin/provider-customer-unlinks/acct_1";

describe("provider customer unlink routes", () => {
	it("unlinks only with the operator key, an actor and an idempotency key", async () => {
		const { calls, service } = recordingService();
		const { entries, logger } = capturingLogger();
		const app = unlinkApp(service, logger);
		const post = (headers: Record<string, string>) =>
			testRequest(app, path, { method: "POST", headers, body: JSON.stringify(body) });
		const { "x-billing-operator-key": _key, ...withoutOperator } = operatorHeaders;
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;

		const noOperator = await post({ ...withoutOperator, "idempotency-key": "unlink-1" });
		const noActor = await post({ ...withoutActor, "idempotency-key": "unlink-1" });
		const noKey = await post(operatorHeaders);
		const readOnly = await post({
			...operatorHeaders,
			authorization: "Bearer read-key",
			"idempotency-key": "unlink-1",
		});
		const unlinked = await post({ ...operatorHeaders, "idempotency-key": "unlink-1" });

		expect(noOperator.status).toBe(401);
		expect(noActor.status).toBe(400);
		expect(noKey.status).toBe(400);
		expect(readOnly.status).toBe(403);
		expect((await readOnly.json()).error.code).toBe("READ_ONLY_CREDENTIAL");
		expect(unlinked.status).toBe(201);
		expect((await unlinked.json()).data).toEqual({ duplicate: false, unlink });
		expect(calls).toEqual([
			{
				method: "unlinkProviderCustomer",
				args: [
					expect.objectContaining({ projectInstanceKey: "acme" }),
					{
						billingAccountId: "acct_1",
						provider: "stripe",
						externalCustomerId: "cus_old",
						reason: "Stripe customer was deleted",
						actor: "support@example.com",
						idempotencyKey: "unlink-1",
					},
				],
			},
		]);
		// The log names ids only; who did it and why stay in the receipt.
		const logged = entries.filter(
			(entry) => entry.message === "Billing admin provider customer unlinked",
		);
		expect(logged).toEqual([
			{
				level: "info",
				message: "Billing admin provider customer unlinked",
				fields: {
					projectKey: "acme",
					billingAccountId: "acct_1",
					provider: "stripe",
					externalCustomerId: "cus_old",
					unlinkId: unlink.id,
				},
			},
		]);
	});

	it("answers a replayed unlink with 200 and does not log it again", async () => {
		const { service } = recordingService({
			unlinkProviderCustomer: () => Promise.resolve({ duplicate: true, unlink }),
		});
		const { entries, logger } = capturingLogger();

		const response = await testRequest(unlinkApp(service, logger), path, {
			method: "POST",
			headers: { ...operatorHeaders, "idempotency-key": "unlink-1" },
			body: JSON.stringify(body),
		});

		expect(response.status).toBe(200);
		expect((await response.json()).data).toEqual({ duplicate: true, unlink });
		expect(
			entries.some((entry) => entry.message === "Billing admin provider customer unlinked"),
		).toBe(false);
	});

	it("accepts only a Stripe customer id and a bounded reason", async () => {
		const { calls, service } = recordingService();
		const app = unlinkApp(service);
		const post = (payload: unknown) =>
			testRequest(app, path, {
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "unlink-1" },
				body: JSON.stringify(payload),
			});

		const otherProvider = await post({ ...body, provider: "apple" });
		const noProvider = await post({ externalCustomerId: "cus_old", reason: "x" });
		const notACustomer = await post({ ...body, externalCustomerId: "sub_123" });
		const barePrefix = await post({ ...body, externalCustomerId: "cus_" });
		const noReason = await post({ ...body, reason: "  " });
		const longReason = await post({ ...body, reason: "x".repeat(501) });
		const unknownKey = await post({ ...body, newExternalCustomerId: "cus_new" });

		expect([
			otherProvider.status,
			noProvider.status,
			notACustomer.status,
			barePrefix.status,
			noReason.status,
			longReason.status,
			unknownKey.status,
		]).toEqual([400, 400, 400, 400, 400, 400, 400]);
		expect((await unknownKey.json()).error.code).toBe("INVALID_REQUEST");
		expect(calls).toHaveLength(0);
	});

	it("maps a missing link, another linked customer and a link in use to their statuses", async () => {
		const refusing = (error: Error) =>
			recordingService({ unlinkProviderCustomer: () => Promise.reject(error) }).service;
		const post = (service: ProviderCustomerUnlinkServiceLike) =>
			testRequest(unlinkApp(service), path, {
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "unlink-1" },
				body: JSON.stringify(body),
			});

		const missing = await post(
			refusing(providerCustomerUnlinkError("PROVIDER_CUSTOMER_LINK_NOT_FOUND")),
		);
		const mismatch = await post(
			refusing(
				providerCustomerUnlinkError("PROVIDER_CUSTOMER_LINK_MISMATCH", {
					externalCustomerId: "cus_current",
				}),
			),
		);
		const inUse = await post(
			refusing(
				providerCustomerUnlinkError("PROVIDER_CUSTOMER_LINK_IN_USE", {
					blockers: [{ kind: "subscription", count: 1 }],
				}),
			),
		);

		expect(missing.status).toBe(404);
		expect((await missing.json()).error.code).toBe("PROVIDER_CUSTOMER_LINK_NOT_FOUND");
		expect(mismatch.status).toBe(409);
		expect((await mismatch.json()).error).toMatchObject({
			code: "PROVIDER_CUSTOMER_LINK_MISMATCH",
			details: { externalCustomerId: "cus_current" },
		});
		expect(inUse.status).toBe(409);
		expect((await inUse.json()).error).toMatchObject({
			code: "PROVIDER_CUSTOMER_LINK_IN_USE",
			details: { blockers: [{ kind: "subscription", count: 1 }] },
		});
	});

	it("lists receipts behind the operator key with the cursor and limit", async () => {
		const { calls, service } = recordingService();
		const app = unlinkApp(service);
		const { "x-billing-operator-key": _key, ...withoutOperator } = operatorHeaders;

		const noOperator = await testRequest(app, path, { headers: withoutOperator });
		const readOnly = await testRequest(app, path, {
			headers: { ...operatorHeaders, authorization: "Bearer read-key" },
		});
		const listed = await testRequest(app, `${path}?limit=5&cursor=abc`, {
			headers: operatorHeaders,
		});

		expect(noOperator.status).toBe(401);
		expect(readOnly.status).toBe(403);
		expect(await listed.json()).toEqual({
			success: true,
			data: [unlink],
			pagination: { nextCursor: "next" },
		});
		expect(calls.map((call) => call.args.slice(1))).toEqual([
			["acct_1", { limit: 5, cursor: "abc" }],
		]);
	});
});
