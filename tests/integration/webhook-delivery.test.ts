import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createWebhookSecretSealer } from "../../src/composition/webhook-secrets";
import { configureErasureKeyring } from "../../src/db/erasure-keyring";
import {
	DomainEventDeliveryRepository,
	recordDomainEvent,
} from "../../src/db/repository/domain-events";
import { ensureCustomer } from "../../src/db/repository/identities";
import type { WebhookPost } from "../../src/events/delivery";
import { WebhookEndpointService } from "../../src/events/service";
import { ConnectionCipher } from "../../src/platform/connections/cipher";
import { erasureKeyFromBase64 } from "../../src/shared/erasure-digest";
import { DomainEventDeliveryWorker } from "../../src/workers/domain-event-delivery";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const acme = integrationProjectContext("acme");
const globex = integrationProjectContext("globex");
const actor = "support@example.com";
const cipher = new ConnectionCipher("k1", new Map([["k1", Buffer.alloc(32, 1)]]));
let context: LocalPostgresContext;

interface Received {
	body: string;
	headers: Record<string, string>;
}

/** A receiver on loopback, answering each request from a queue of statuses (200 when empty). */
function receiver() {
	const received: Received[] = [];
	const statuses: Array<{ status: number; retryAfter?: string }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			received.push({
				body: await request.text(),
				headers: Object.fromEntries(request.headers.entries()),
			});
			const next = statuses.shift() ?? { status: 200 };
			return new Response("ok", {
				status: next.status,
				headers: next.retryAfter === undefined ? {} : { "retry-after": next.retryAfter },
			});
		},
	});
	return {
		received,
		statuses,
		url: `http://127.0.0.1:${server.port}/hooks`,
		stop: () => server.stop(true),
	};
}

/** Plain loopback HTTP; the destination policy is covered by the safe-http tests. */
const directPost: WebhookPost = async (url, body, headers) => {
	const response = await fetch(url, { method: "POST", body, headers });
	const retryAfter = response.headers.get("retry-after");
	return {
		status: response.status,
		body: await response.text(),
		...(retryAfter === null ? {} : { retryAfter }),
	};
};

/** Verifies Standard Webhooks headers without the code under test. */
function verifiedBy(secret: string, request: Received | undefined): boolean {
	if (request === undefined) return false;
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const expected = createHmac("sha256", key)
		.update(
			`${request.headers["webhook-id"]}.${request.headers["webhook-timestamp"]}.${request.body}`,
		)
		.digest("base64");
	return (request.headers["webhook-signature"] ?? "").split(" ").includes(`v1,${expected}`);
}

localDescribe("outbound webhook delivery", () => {
	let hooks: ReturnType<typeof receiver>;

	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		hooks = receiver();
	});

	afterEach(() => {
		hooks.stop();
		configureErasureKeyring(null);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	function fixture(sealerCipher = cipher) {
		const service = new WebhookEndpointService({
			store: context.repository.webhookEndpoints,
			sealer: () => createWebhookSecretSealer(sealerCipher),
			allowInsecureHttp: true,
		});
		const created = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			webhookEndpointService: service,
		});
		const headers = (project = "acme", idempotencyKey?: string): HeadersInit => ({
			...created.authHeaders(project),
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": actor,
			"content-type": "application/json",
			...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
		});
		const call = (
			method: string,
			path: string,
			body?: unknown,
			idempotencyKey?: string,
			project?: string,
		) =>
			testRequest(created.app, path, {
				method,
				headers: headers(project, idempotencyKey),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		const worker = (workerId = "worker-a", maxAttempts = 12) =>
			new DomainEventDeliveryWorker({
				workerId,
				maxAttempts,
				retentionDays: 30,
				batchSize: 25,
				store: context.repository.domainEventDeliveries,
				sealer: () => createWebhookSecretSealer(sealerCipher),
				post: directPost,
				projectContextResolver: context.projectContextResolver,
				jitterMs: () => 0,
			});
		const createEndpoint = async (
			key: string,
			body: Record<string, unknown> = {},
			project?: string,
		) => {
			const response = await call(
				"POST",
				"/v1/admin/webhook-endpoints",
				{ url: hooks.url, ...body },
				key,
				project,
			);
			return { status: response.status, ...(await response.json()) };
		};
		return { call, worker, createEndpoint };
	}

	it("creates an endpoint, discloses its secret once and seals it at rest", async () => {
		const { createEndpoint } = fixture();

		const created = await createEndpoint("create-1", { description: "Billing events" });
		const replayed = await createEndpoint("create-1", { description: "Billing events" });
		const conflicting = await createEndpoint("create-1", { description: "Other" });

		expect(created.status).toBe(201);
		expect(created.data.secret).toMatch(/^whsec_/);
		expect(replayed.status).toBe(200);
		expect(replayed.data).toMatchObject({ duplicate: true, secret: null, secretDisclosed: false });
		expect(conflicting.status).toBe(409);
		const [row] = await context.sql`
			SELECT secret_envelope::text AS envelope, created_by FROM webhook_endpoints
			WHERE project_id = ${acme.projectInstanceId}
		`;
		expect(row.envelope).not.toContain(created.data.secret);
		expect(row.envelope).toContain('"keyId": "k1"');
		expect(row.created_by).toBe(actor);
	});

	it("caps the endpoints of a project and keeps projects apart", async () => {
		const { call, createEndpoint } = fixture();
		for (let index = 0; index < 20; index += 1) {
			expect((await createEndpoint(`create-${index}`)).status).toBe(201);
		}

		const over = await createEndpoint("create-20");
		const other = await createEndpoint("create-20", {}, "globex");
		const acmeList = await (await call("GET", "/v1/admin/webhook-endpoints")).json();
		const foreign = await call("GET", `/v1/admin/webhook-endpoints/${other.data.endpoint.id}`);

		expect(over.status).toBe(409);
		expect(over.error.code).toBe("WEBHOOK_ENDPOINT_LIMIT_REACHED");
		expect(other.status).toBe(201);
		expect(acmeList.data).toHaveLength(20);
		expect(foreign.status).toBe(404);
	});

	it("delivers a test event with a signature a receiver can verify", async () => {
		const { call, createEndpoint, worker } = fixture();
		const endpoint = await createEndpoint("create-1");

		const queued = await call(
			"POST",
			`/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}/test`,
		);
		const run = await worker().runOnce();

		expect(queued.status).toBe(202);
		const { eventId, deliveryId } = (await queued.json()).data;
		expect(run).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
		expect(hooks.received).toHaveLength(1);
		const [request] = hooks.received;
		expect(verifiedBy(endpoint.data.secret, request)).toBe(true);
		expect(request?.headers["webhook-id"]).toBe(eventId);
		expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
			id: eventId,
			type: "webhook.test",
			version: 1,
			environment: acme.environment,
			projectKey: "acme",
			data: { endpointId: endpoint.data.endpoint.id },
		});
		const listed = await (await call("GET", "/v1/admin/webhook-deliveries")).json();
		expect(listed.data).toEqual([
			expect.objectContaining({
				id: deliveryId,
				status: "succeeded",
				attempts: 1,
				lastStatusCode: 200,
				nextAttemptAt: null,
			}),
		]);
	});

	it("records a fact only while an enabled endpoint subscribes, once per source", async () => {
		const { call, createEndpoint } = fixture();
		const customer = await ensureCustomer(context.db as never, acme.projectInstanceId, "user_42");
		const record = (sourceKey: string, type = "invoice.paid") =>
			recordDomainEvent(context.db as never, acme.projectInstanceId, {
				type,
				sourceKey,
				customerId: customer.id,
				occurredAt: new Date(),
				data: { invoiceId: "in_1" },
			});

		expect(await record("invoice:in_1")).toBeNull();
		const endpoint = await createEndpoint("create-1");
		const first = await record("invoice:in_1");
		const again = await record("invoice:in_1");
		await call("PATCH", `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}`, {
			enabled: false,
		});
		const whileDisabled = await record("invoice:in_2");

		expect(first).not.toBeNull();
		expect(again).toBeNull();
		expect(whileDisabled).toBeNull();
		const rows = await context.sql`
			SELECT type, source_key FROM domain_events WHERE project_id = ${acme.projectInstanceId}
		`;
		expect(rows).toEqual([{ type: "invoice.paid", source_key: "invoice:in_1" }]);
		const other = await context.sql`
			SELECT count(*)::int AS count FROM domain_events WHERE project_id = ${globex.projectInstanceId}
		`;
		expect(other[0].count).toBe(0);
	});

	it("fans an event out only to enabled endpoints that subscribe and existed when it was recorded", async () => {
		const { createEndpoint, worker } = fixture();
		const all = await createEndpoint("create-all");
		const other = await createEndpoint("create-other");
		await context.sql`
			UPDATE webhook_endpoints SET event_types = ARRAY['refund.recorded']
			WHERE id = ${other.data.endpoint.id}
		`;
		const eventId = await recordDomainEvent(context.db as never, acme.projectInstanceId, {
			type: "invoice.paid",
			sourceKey: "invoice:in_1",
			customerId: null,
			occurredAt: new Date(),
			data: { invoiceId: "in_1" },
		});
		const later = await createEndpoint("create-later");

		const run = await worker().runOnce();

		expect(run).toMatchObject({ dispatched: 1, claimed: 1, succeeded: 1 });
		const deliveries = await context.sql`
			SELECT endpoint_id FROM webhook_deliveries WHERE event_id = ${eventId}
		`;
		expect(deliveries.map((row: { endpoint_id: string }) => row.endpoint_id)).toEqual([
			all.data.endpoint.id,
		]);
		expect(later.status).toBe(201);
		expect(verifiedBy(all.data.secret, hooks.received[0])).toBe(true);
	});

	it("retries with backoff, fails for good after the last attempt, and retries on request", async () => {
		const { call, createEndpoint, worker } = fixture();
		const endpoint = await createEndpoint("create-1");
		await call("POST", `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}/test`);
		hooks.statuses.push({ status: 500 }, { status: 503, retryAfter: "120" });

		await worker("worker-a", 2).runOnce();
		const [afterFirst] = await context.sql`
			SELECT status, attempts, last_status_code, next_attempt_at > now() AS deferred
			FROM webhook_deliveries
		`;
		await context.sql`UPDATE webhook_deliveries SET next_attempt_at = now()`;
		await worker("worker-a", 2).runOnce();
		const [afterSecond] = await context.sql`
			SELECT status, attempts, last_status_code FROM webhook_deliveries
		`;
		const [{ id }] = await context.sql`SELECT id FROM webhook_deliveries`;
		const retried = await call("POST", `/v1/admin/webhook-deliveries/${id}/retry`);
		const again = await call("POST", `/v1/admin/webhook-deliveries/${id}/retry`);
		await worker().runOnce();

		expect(afterFirst).toEqual({
			status: "pending",
			attempts: 1,
			last_status_code: 500,
			deferred: true,
		});
		expect(afterSecond).toEqual({ status: "failed", attempts: 2, last_status_code: 503 });
		expect(retried.status).toBe(200);
		expect(again.status).toBe(409);
		expect((await again.json()).error.code).toBe("WEBHOOK_DELIVERY_NOT_FAILED");
		expect(hooks.received).toHaveLength(3);
		const [final] = await context.sql`SELECT status FROM webhook_deliveries`;
		expect(final.status).toBe("succeeded");
	});

	it("holds deliveries while an endpoint is disabled and disables one that keeps failing", async () => {
		const { call, createEndpoint, worker } = fixture();
		const endpoint = await createEndpoint("create-1");
		const path = `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}`;
		await call("POST", `${path}/test`);
		await call("PATCH", path, { enabled: false });

		const held = await worker().runOnce();
		const disabledTest = await call("POST", `${path}/test`);
		await call("PATCH", path, { enabled: true });
		const resumed = await worker().runOnce();

		expect(held.claimed).toBe(0);
		expect(disabledTest.status).toBe(409);
		expect(resumed.succeeded).toBe(1);

		await call("POST", `${path}/test`);
		await context.sql`
			UPDATE webhook_endpoints SET failing_since = now() - INTERVAL '73 hours'
			WHERE id = ${endpoint.data.endpoint.id}
		`;
		hooks.statuses.push({ status: 500 });
		await worker().runOnce();
		const read = await (await call("GET", path)).json();
		expect(read.data).toMatchObject({ enabled: false, disabledReason: "failing" });
	});

	it("reclaims a stale lease and refuses the old worker's marker", async () => {
		const { call, createEndpoint, worker } = fixture();
		const endpoint = await createEndpoint("create-1");
		await call("POST", `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}/test`);
		const deliveries = new DomainEventDeliveryRepository(context.db as never);
		const [claimed] = await deliveries.claimDeliveries("worker-old", 10);
		await context.sql`
			UPDATE webhook_deliveries SET locked_at = now() - INTERVAL '6 minutes' WHERE id = ${claimed?.id ?? ""}
		`;

		const run = await worker("worker-new").runOnce();

		expect(run.succeeded).toBe(1);
		await expect(
			deliveries.markDeliverySucceeded(
				acme.projectInstanceId,
				claimed?.id ?? "",
				"worker-old",
				200,
			),
		).rejects.toThrow("is not locked by worker worker-old");
	});

	it("replays a window with the same webhook-id and signs with both secrets during a rotation", async () => {
		const { call, createEndpoint, worker } = fixture();
		const endpoint = await createEndpoint("create-1");
		const path = `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}`;
		const eventId = await recordDomainEvent(context.db as never, acme.projectInstanceId, {
			type: "invoice.paid",
			sourceKey: "invoice:in_1",
			customerId: null,
			occurredAt: new Date(),
			data: { invoiceId: "in_1" },
		});
		await worker().runOnce();

		const rotated = await (
			await call("POST", `${path}/rotate-secret`, { overlapHours: 24 }, "rotate-1")
		).json();
		const rotatedAgain = await (
			await call("POST", `${path}/rotate-secret`, { overlapHours: 24 }, "rotate-1")
		).json();
		const from = new Date(Date.now() - 60_000).toISOString();
		const to = new Date(Date.now() + 60_000).toISOString();
		const replayed = await (await call("POST", `${path}/replay`, { from, to })).json();
		await worker().runOnce();

		expect(rotated.data).toMatchObject({ duplicate: false, secretDisclosed: true });
		expect(rotated.data.endpoint.secretGeneration).toBe(2);
		expect(rotatedAgain.data).toMatchObject({ duplicate: true, secret: null });
		expect(replayed.data).toEqual({ queued: 1 });
		expect(hooks.received).toHaveLength(2);
		const [original, replay] = hooks.received;
		expect(original?.headers["webhook-id"]).toBe(eventId ?? "");
		expect(replay?.headers["webhook-id"]).toBe(eventId ?? "");
		expect(verifiedBy(endpoint.data.secret, replay)).toBe(true);
		expect(verifiedBy(rotated.data.secret, replay)).toBe(true);

		await call("POST", `${path}/rotate-secret`, { overlapHours: 0 }, "rotate-2");
		await call("POST", `${path}/test`);
		await worker().runOnce();
		expect(hooks.received[2]?.headers["webhook-signature"]?.split(" ")).toHaveLength(1);
	});

	it("deletes events past retention and forgets a replaced secret once its overlap ends", async () => {
		const { call, createEndpoint, worker } = fixture();
		const endpoint = await createEndpoint("create-1");
		await call(
			"POST",
			`/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}/rotate-secret`,
			{ overlapHours: 1 },
			"rotate-1",
		);
		await call("POST", `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}/test`);
		await worker().runOnce();
		await context.sql`UPDATE domain_events SET created_at = now() - INTERVAL '31 days'`;
		await context.sql`
			UPDATE webhook_endpoints SET previous_secret_expires_at = now() - INTERVAL '1 minute'
		`;

		const deleted = await context.repository.domainEventDeliveries.deleteExpiredEvents(30, 100);

		expect(deleted).toBe(1);
		const [counts] = await context.sql`
			SELECT
				(SELECT count(*)::int FROM domain_events) AS events,
				(SELECT count(*)::int FROM webhook_deliveries) AS deliveries,
				(SELECT count(*)::int FROM webhook_endpoints WHERE previous_secret_envelope IS NOT NULL) AS overlaps
		`;
		expect(counts).toEqual({ events: 0, deliveries: 0, overlaps: 0 });
	});

	it("re-seals endpoint secrets with a new deployment key and keeps delivering", async () => {
		const { call, createEndpoint } = fixture();
		const endpoint = await createEndpoint("create-1");
		await call(
			"POST",
			`/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}/rotate-secret`,
			{ overlapHours: 24 },
			"rotate-1",
		);
		const rotatedCipher = new ConnectionCipher(
			"k2",
			new Map([
				["k2", Buffer.alloc(32, 2)],
				["k1", Buffer.alloc(32, 1)],
			]),
		);

		const first = await context.repository.domainEventDeliveries.resealEndpointSecrets(
			createWebhookSecretSealer(rotatedCipher),
		);
		const second = await context.repository.domainEventDeliveries.resealEndpointSecrets(
			createWebhookSecretSealer(rotatedCipher),
		);
		const after = fixture(new ConnectionCipher("k2", new Map([["k2", Buffer.alloc(32, 2)]])));
		await after.call("POST", `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}/test`);
		const run = await after.worker().runOnce();

		expect(first).toBe(1);
		expect(second).toBe(0);
		const [row] = await context.sql`
			SELECT secret_envelope->>'keyId' AS current, previous_secret_envelope->>'keyId' AS previous
			FROM webhook_endpoints
		`;
		expect(row).toEqual({ current: "k2", previous: "k2" });
		expect(run.succeeded).toBe(1);
		expect(verifiedBy(endpoint.data.secret, hooks.received[0])).toBe(true);
	});

	it("counts an account's events in an erasure preview and blocks while one is in flight", async () => {
		configureErasureKeyring(
			{
				current: erasureKeyFromBase64("erasure-test", Buffer.alloc(32, 5).toString("base64")),
				previous: null,
			},
			30,
		);
		const { call, createEndpoint } = fixture();
		await createEndpoint("create-1");
		const customer = await ensureCustomer(context.db as never, acme.projectInstanceId, "user_42");
		await recordDomainEvent(context.db as never, acme.projectInstanceId, {
			type: "invoice.paid",
			sourceKey: "invoice:in_1",
			customerId: customer.id,
			occurredAt: new Date(),
			data: { invoiceId: "in_1" },
		});
		await context.repository.domainEventDeliveries.dispatchEvents(10);
		await context.repository.domainEventDeliveries.claimDeliveries("worker-a", 10);

		const preview = await (
			await call("POST", "/v1/admin/customer-erasures/preview", { billingAccountId: "user_42" })
		).json();

		expect(preview.data.rows.domain_events).toBe(1);
		expect(preview.data.blockers).toContainEqual({ kind: "webhook_delivery", count: 1 });
	});
	it("keeps one endpoint's disabled backlog from stalling every other delivery", async () => {
		const { call, createEndpoint, worker } = fixture();
		const stalled = await createEndpoint("create-stalled");
		for (let index = 0; index < 260; index += 1) {
			await recordDomainEvent(context.db as never, acme.projectInstanceId, {
				type: "invoice.paid",
				sourceKey: `invoice:${index}`,
				customerId: null,
				occurredAt: new Date(),
				data: { invoiceId: `in_${index}` },
			});
		}
		while ((await context.repository.domainEventDeliveries.dispatchEvents(100)) > 0) {}
		// Disabled behind the API's back, so nothing parks the backlog: the claim alone must cope.
		await context.sql`
			UPDATE webhook_endpoints SET enabled = false, disabled_reason = 'operator'
			WHERE id = ${stalled.data.endpoint.id}
		`;
		const other = await createEndpoint("create-other", {}, "globex");
		await call(
			"POST",
			`/v1/admin/webhook-endpoints/${other.data.endpoint.id}/test`,
			undefined,
			undefined,
			"globex",
		);

		const run = await worker().runOnce();

		expect(run).toMatchObject({ claimed: 1, succeeded: 1 });
		expect(hooks.received).toHaveLength(1);
		expect(verifiedBy(other.data.secret, hooks.received[0])).toBe(true);
	});

	it("parks a disabled endpoint's deliveries, retries and replays, and resumes them when enabled", async () => {
		const { call, createEndpoint, worker } = fixture();
		const endpoint = await createEndpoint("create-1");
		const path = `/v1/admin/webhook-endpoints/${endpoint.data.endpoint.id}`;
		for (const key of ["invoice:in_1", "invoice:in_2"]) {
			await recordDomainEvent(context.db as never, acme.projectInstanceId, {
				type: "invoice.paid",
				sourceKey: key,
				customerId: null,
				occurredAt: new Date(),
				data: { invoiceId: key },
			});
		}
		await context.repository.domainEventDeliveries.dispatchEvents(10);
		const parked = async () => {
			const [row] = await context.sql`
				SELECT count(*) FILTER (WHERE next_attempt_at = 'infinity')::int AS parked,
					count(*)::int AS total
				FROM webhook_deliveries
			`;
			return row;
		};

		await call("PATCH", path, { enabled: false });
		const afterDisable = await parked();
		const from = new Date(Date.now() - 60_000).toISOString();
		const to = new Date(Date.now() + 60_000).toISOString();
		await call("POST", `${path}/replay`, { from, to });
		const afterReplay = await parked();
		await call("PATCH", path, { enabled: true });
		const afterEnable = await parked();
		const run = await worker().runOnce();

		expect(afterDisable).toEqual({ parked: 2, total: 2 });
		expect(afterReplay).toEqual({ parked: 2, total: 2 });
		expect(afterEnable).toEqual({ parked: 0, total: 2 });
		expect(run).toMatchObject({ claimed: 2, succeeded: 2 });
	});

	it("never sends a delivery about an account whose erasure was requested", async () => {
		const { createEndpoint, worker } = fixture();
		await createEndpoint("create-1");
		const customer = await ensureCustomer(context.db as never, acme.projectInstanceId, "user_42");
		for (const key of ["invoice:in_1", "invoice:in_2"]) {
			await recordDomainEvent(context.db as never, acme.projectInstanceId, {
				type: "invoice.paid",
				sourceKey: key,
				customerId: customer.id,
				occurredAt: new Date(),
				data: { invoiceId: key },
			});
		}
		const deliveries = context.repository.domainEventDeliveries;
		await deliveries.dispatchEvents(10);
		const [claimed] = await deliveries.claimDeliveries("worker-a", 1);
		await context.sql`UPDATE customers SET erased_at = now() WHERE id = ${customer.id}`;

		const held = await deliveries.holdIfAccountErased(
			acme.projectInstanceId,
			claimed?.id ?? "",
			"worker-a",
		);
		const run = await worker("worker-b").runOnce();

		expect(claimed?.customerId).toBe(customer.id);
		expect(held).toBe(true);
		expect(run).toMatchObject({ claimed: 0, succeeded: 0 });
		expect(hooks.received).toHaveLength(0);
		const rows = await context.sql`
			SELECT status, next_attempt_at = 'infinity' AS parked FROM webhook_deliveries ORDER BY id
		`;
		expect(rows).toEqual([
			{ status: "pending", parked: true },
			{ status: "pending", parked: false },
		]);
	});

	it("counts endpoints a rotation skipped while they were locked", async () => {
		const { createEndpoint } = fixture();
		const endpoint = await createEndpoint("create-1");
		const next = createWebhookSecretSealer(
			new ConnectionCipher(
				"k2",
				new Map([
					["k2", Buffer.alloc(32, 2)],
					["k1", Buffer.alloc(32, 1)],
				]),
			),
		);
		const deliveries = context.repository.domainEventDeliveries;

		const whileLocked = await context.sql.begin(async (tx) => {
			await tx`SELECT id FROM webhook_endpoints WHERE id = ${endpoint.data.endpoint.id} FOR UPDATE`;
			return {
				resealed: await deliveries.resealEndpointSecrets(next),
				remaining: await deliveries.countEndpointSecretsSealedWithOtherKeys("k2"),
			};
		});
		const resealed = await deliveries.resealEndpointSecrets(next);

		expect(whileLocked).toEqual({ resealed: 0, remaining: 1 });
		expect(resealed).toBe(1);
		expect(await deliveries.countEndpointSecretsSealedWithOtherKeys("k2")).toBe(0);
	});
});
