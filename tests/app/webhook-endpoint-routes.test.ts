import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import {
	type WebhookDeliveryRecord,
	type WebhookEndpointRecord,
	type WebhookEndpointServiceLike,
	webhookError,
} from "../../src/events/endpoints";
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

const endpointId = "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e20";
const deliveryId = "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e30";
const secret = "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==";

const endpoint: WebhookEndpointRecord = {
	id: endpointId,
	url: "https://hooks.example.com/quotum",
	description: "Billing events",
	eventTypes: [],
	enabled: true,
	disabledReason: null,
	secretGeneration: 1,
	previousSecretExpiresAt: null,
	failingSince: null,
	createdBy: "support@example.com",
	createdAt: "2026-10-19T08:00:00.000Z",
	updatedAt: "2026-10-19T08:00:00.000Z",
};

const delivery: WebhookDeliveryRecord = {
	id: deliveryId,
	endpointId,
	eventId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e10",
	eventType: "webhook.test",
	billingAccountId: null,
	status: "failed",
	attempts: 12,
	nextAttemptAt: null,
	lastError: "Receiver answered 500",
	lastStatusCode: 500,
	lastAttemptAt: "2026-10-19T09:00:00.000Z",
	deliveredAt: null,
	occurredAt: "2026-10-19T08:00:00.000Z",
	createdAt: "2026-10-19T08:00:00.000Z",
};

function recordingService(overrides: Partial<WebhookEndpointServiceLike> = {}) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const record =
		<T>(method: string, value: T) =>
		(...args: unknown[]) => {
			calls.push({ method, args: args.slice(1) });
			return Promise.resolve(value);
		};
	const service: WebhookEndpointServiceLike = {
		createEndpoint: record("createEndpoint", {
			duplicate: false,
			endpoint,
			secret,
			secretDisclosed: true,
		}),
		listEndpoints: record("listEndpoints", [endpoint]),
		getEndpoint: record("getEndpoint", endpoint),
		updateEndpoint: record("updateEndpoint", { ...endpoint, enabled: false }),
		deleteEndpoint: record("deleteEndpoint", { id: endpointId }),
		rotateSecret: record("rotateSecret", {
			duplicate: false,
			endpoint: { ...endpoint, secretGeneration: 2 },
			secret,
			secretDisclosed: true,
		}),
		sendTestEvent: record("sendTestEvent", { eventId: delivery.eventId, deliveryId }),
		replay: record("replay", { queued: 3 }),
		listDeliveries: record("listDeliveries", { items: [delivery], nextCursor: "next" }),
		retryDelivery: record("retryDelivery", { deliveryId, status: "pending" as const }),
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

function webhookApp(service: WebhookEndpointServiceLike, logger?: BillingLogger) {
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
			webhookEndpointService: service,
			...(logger === undefined ? {} : { logger }),
		}),
	);
}

describe("webhook endpoint routes", () => {
	it("creates an endpoint only with the operator key, an actor and an idempotency key", async () => {
		const { calls, service } = recordingService();
		const { entries, logger } = logs();
		const app = webhookApp(service, logger);
		const post = (headers: Record<string, string>) =>
			testRequest(app, "/v1/admin/webhook-endpoints", {
				method: "POST",
				headers,
				body: JSON.stringify({ url: endpoint.url, description: "Billing events" }),
			});
		const { "x-billing-operator-key": _key, ...withoutOperator } = operatorHeaders;
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;

		const noOperator = await post({ ...withoutOperator, "idempotency-key": "create-1" });
		const noActor = await post({ ...withoutActor, "idempotency-key": "create-1" });
		const noKey = await post(operatorHeaders);
		const readOnly = await post({
			...operatorHeaders,
			authorization: "Bearer read-key",
			"idempotency-key": "create-1",
		});
		const created = await post({ ...operatorHeaders, "idempotency-key": "create-1" });

		expect(noOperator.status).toBe(403);
		expect(noActor.status).toBe(400);
		expect(noKey.status).toBe(400);
		expect(readOnly.status).toBe(403);
		expect(created.status).toBe(201);
		expect((await created.json()).data).toEqual({
			duplicate: false,
			endpoint,
			secret,
			secretDisclosed: true,
		});
		expect(calls).toEqual([
			{
				method: "createEndpoint",
				args: [
					{
						url: endpoint.url,
						description: "Billing events",
						eventTypes: [],
						enabled: true,
						actor: "support@example.com",
						idempotencyKey: "create-1",
					},
				],
			},
		]);
		// The log line names the endpoint, never its URL, its secret or the operator.
		expect(entries).toHaveLength(1);
		const logged = JSON.stringify(entries);
		expect(logged).toContain(endpointId);
		expect(logged).not.toContain(endpoint.url);
		expect(logged).not.toContain(secret);
		expect(logged).not.toContain("support@example.com");
	});

	it("answers a replayed create with 200 and no secret", async () => {
		const { service } = recordingService({
			createEndpoint: () =>
				Promise.resolve({ duplicate: true, endpoint, secret: null, secretDisclosed: false }),
		});
		const { entries, logger } = logs();

		const response = await testRequest(webhookApp(service, logger), "/v1/admin/webhook-endpoints", {
			method: "POST",
			headers: { ...operatorHeaders, "idempotency-key": "create-1" },
			body: JSON.stringify({ url: endpoint.url }),
		});

		expect(response.status).toBe(200);
		expect((await response.json()).data).toEqual({
			duplicate: true,
			endpoint,
			secret: null,
			secretDisclosed: false,
		});
		expect(entries).toHaveLength(0);
	});

	it("refuses unknown fields and a description over the limit", async () => {
		const { calls, service } = recordingService();
		const app = webhookApp(service);
		const post = (body: unknown) =>
			testRequest(app, "/v1/admin/webhook-endpoints", {
				method: "POST",
				headers: { ...operatorHeaders, "idempotency-key": "create-2" },
				body: JSON.stringify(body),
			});

		const unknown = await post({ url: endpoint.url, secret: "mine" });
		const long = await post({ url: endpoint.url, description: "x".repeat(501) });

		expect(unknown.status).toBe(400);
		expect(long.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("lists, reads, updates and deletes endpoints", async () => {
		const { calls, service } = recordingService();
		const app = webhookApp(service);
		const path = `/v1/admin/webhook-endpoints/${endpointId}`;

		const listed = await testRequest(app, "/v1/admin/webhook-endpoints", {
			headers: operatorHeaders,
		});
		const read = await testRequest(app, path, { headers: operatorHeaders });
		const updated = await testRequest(app, path, {
			method: "PATCH",
			headers: operatorHeaders,
			body: JSON.stringify({ enabled: false }),
		});
		const deleted = await testRequest(app, path, { method: "DELETE", headers: operatorHeaders });

		expect(listed.status).toBe(200);
		expect((await listed.json()).data).toEqual([endpoint]);
		expect(read.status).toBe(200);
		expect(updated.status).toBe(200);
		expect((await updated.json()).data.enabled).toBe(false);
		expect(deleted.status).toBe(200);
		expect((await deleted.json()).data).toEqual({ id: endpointId, deleted: true });
		expect(calls.map((call) => call.method)).toEqual([
			"listEndpoints",
			"getEndpoint",
			"updateEndpoint",
			"deleteEndpoint",
		]);
		expect(calls[2]?.args).toEqual([endpointId, { enabled: false }]);
	});

	it("requires an actor on an update and a delete", async () => {
		const { calls, service } = recordingService();
		const app = webhookApp(service);
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;
		const path = `/v1/admin/webhook-endpoints/${endpointId}`;

		const update = await testRequest(app, path, {
			method: "PATCH",
			headers: withoutActor,
			body: JSON.stringify({ enabled: false }),
		});
		const remove = await testRequest(app, path, { method: "DELETE", headers: withoutActor });

		expect(update.status).toBe(400);
		expect(remove.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("refuses an endpoint id that is not a UUID before reaching the service", async () => {
		const { calls, service } = recordingService();

		const response = await testRequest(webhookApp(service), "/v1/admin/webhook-endpoints/abc", {
			headers: operatorHeaders,
		});

		expect(response.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("maps a missing endpoint to 404", async () => {
		const { service } = recordingService({
			getEndpoint: () => Promise.reject(webhookError("WEBHOOK_ENDPOINT_NOT_FOUND")),
		});

		const response = await testRequest(
			webhookApp(service),
			`/v1/admin/webhook-endpoints/${endpointId}`,
			{ headers: operatorHeaders },
		);

		expect(response.status).toBe(404);
		expect((await response.json()).error.code).toBe("WEBHOOK_ENDPOINT_NOT_FOUND");
	});

	it("rotates a secret with an idempotency key and a default overlap", async () => {
		const { calls, service } = recordingService();
		const app = webhookApp(service);
		const path = `/v1/admin/webhook-endpoints/${endpointId}/rotate-secret`;

		const noKey = await testRequest(app, path, {
			method: "POST",
			headers: operatorHeaders,
			body: "{}",
		});
		const rotated = await testRequest(app, path, {
			method: "POST",
			headers: { ...operatorHeaders, "idempotency-key": "rotate-1" },
			body: "{}",
		});
		const tooLong = await testRequest(app, path, {
			method: "POST",
			headers: { ...operatorHeaders, "idempotency-key": "rotate-2" },
			body: JSON.stringify({ overlapHours: 169 }),
		});

		expect(noKey.status).toBe(400);
		expect(rotated.status).toBe(200);
		expect((await rotated.json()).data.secret).toBe(secret);
		expect(tooLong.status).toBe(400);
		expect(calls).toEqual([
			{
				method: "rotateSecret",
				args: [endpointId, { overlapHours: 24, idempotencyKey: "rotate-1" }],
			},
		]);
	});

	it("queues a test event and a replay", async () => {
		const { calls, service } = recordingService();
		const app = webhookApp(service);

		const test = await testRequest(app, `/v1/admin/webhook-endpoints/${endpointId}/test`, {
			method: "POST",
			headers: operatorHeaders,
		});
		const replay = await testRequest(app, `/v1/admin/webhook-endpoints/${endpointId}/replay`, {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ from: "2026-10-18T00:00:00Z", to: "2026-10-19T00:00:00Z" }),
		});
		const badRange = await testRequest(app, `/v1/admin/webhook-endpoints/${endpointId}/replay`, {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ from: "yesterday", to: "2026-10-19T00:00:00Z" }),
		});

		expect(test.status).toBe(202);
		expect((await test.json()).data).toEqual({ eventId: delivery.eventId, deliveryId });
		expect(replay.status).toBe(202);
		expect((await replay.json()).data).toEqual({ queued: 3 });
		expect(badRange.status).toBe(400);
		expect(calls).toEqual([
			{ method: "sendTestEvent", args: [endpointId] },
			{
				method: "replay",
				args: [
					endpointId,
					{
						from: new Date("2026-10-18T00:00:00Z"),
						to: new Date("2026-10-19T00:00:00Z"),
						eventTypes: [],
					},
				],
			},
		]);
	});

	it("lists deliveries with filters and retries a failed one", async () => {
		const { calls, service } = recordingService();
		const app = webhookApp(service);

		const listed = await testRequest(
			app,
			`/v1/admin/webhook-deliveries?endpointId=${endpointId}&status=failed&limit=10`,
			{ headers: operatorHeaders },
		);
		const retried = await testRequest(app, `/v1/admin/webhook-deliveries/${deliveryId}/retry`, {
			method: "POST",
			headers: operatorHeaders,
		});
		const badStatus = await testRequest(app, "/v1/admin/webhook-deliveries?status=lost", {
			headers: operatorHeaders,
		});

		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({
			success: true,
			data: [delivery],
			pagination: { nextCursor: "next" },
		});
		expect(retried.status).toBe(200);
		expect((await retried.json()).data).toEqual({ deliveryId, status: "pending" });
		expect(badStatus.status).toBe(400);
		expect(calls).toEqual([
			{
				method: "listDeliveries",
				args: [
					{
						limit: 10,
						cursor: null,
						endpointId,
						status: "failed",
						eventType: null,
						billingAccountId: null,
					},
				],
			},
			{ method: "retryDelivery", args: [deliveryId] },
		]);
	});

	it("lists the event types an endpoint can receive", async () => {
		const { service } = recordingService();

		const response = await testRequest(webhookApp(service), "/v1/admin/webhook-event-types", {
			headers: operatorHeaders,
		});

		expect(response.status).toBe(200);
		const { data } = await response.json();
		expect(data.deliverable).toContain("webhook.test");
		expect(data.subscribable).not.toContain("webhook.test");
	});
});
