import { describe, expect, it } from "bun:test";
import type {
	ClaimedWebhookDelivery,
	WebhookDeliveryFailure,
} from "../../src/db/repository/domain-events";
import type { WebhookPost } from "../../src/events/delivery";
import type { WebhookSecretSealer } from "../../src/events/secret-sealer";
import { generateWebhookSecret, verifyWebhookSignature } from "../../src/events/signing";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import {
	type DomainEventDeliveryStore,
	DomainEventDeliveryWorker,
} from "../../src/workers/domain-event-delivery";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext("acme");
const now = new Date("2026-10-19T08:00:00.000Z");
const current = generateWebhookSecret();
const previous = generateWebhookSecret();

/** Opens an envelope whose ciphertext names the secret by generation, and records each scope. */
function sealer(opened: unknown[]): WebhookSecretSealer {
	return {
		activeKeyId: "k1",
		seal: () => {
			throw new Error("the worker never seals");
		},
		open: (envelope, scope) => {
			opened.push(scope);
			return envelope.ciphertext === "current" ? current : previous;
		},
	};
}

const envelope = (ciphertext: string) => ({ keyId: "k1", nonce: "n", tag: "t", ciphertext });

function delivery(overrides: Partial<ClaimedWebhookDelivery> = {}): ClaimedWebhookDelivery {
	return {
		id: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e30",
		projectId: project.projectInstanceId,
		projectKey: project.projectInstanceKey,
		eventId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e10",
		endpointId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e20",
		attempts: 0,
		type: "webhook.test",
		data: { endpointId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e20", message: "hello" },
		occurredAt: "2026-10-19T07:59:00.000Z",
		createdAt: "2026-10-19T07:59:01.000Z",
		customerId: null,
		billingAccountId: null,
		url: "https://hooks.example.com/quotum",
		secretGeneration: 3,
		secretEnvelope: envelope("current"),
		previousSecretEnvelope: null,
		...overrides,
	};
}

function store(claimed: ClaimedWebhookDelivery[], endpointDisabled = false, heldAccounts = false) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const value: DomainEventDeliveryStore = {
		dispatchEvents: (limit) => {
			calls.push({ method: "dispatchEvents", args: [limit] });
			return Promise.resolve(2);
		},
		claimDeliveries: (workerId, limit) => {
			calls.push({ method: "claimDeliveries", args: [workerId, limit] });
			return Promise.resolve(claimed);
		},
		markDeliverySucceeded: (...args) => {
			calls.push({ method: "markDeliverySucceeded", args });
			return Promise.resolve();
		},
		markDeliveryFailed: (...args) => {
			calls.push({ method: "markDeliveryFailed", args });
			return Promise.resolve({ endpointDisabled });
		},
		holdIfAccountErased: (...args) => {
			calls.push({ method: "holdIfAccountErased", args });
			return Promise.resolve(heldAccounts);
		},
		deleteExpiredEvents: (...args) => {
			calls.push({ method: "deleteExpiredEvents", args });
			return Promise.resolve(0);
		},
	};
	return { calls, store: value };
}

function recordingPost(status: number, retryAfter?: string) {
	const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
	const post: WebhookPost = async (url, body, headers) => {
		sent.push({ url, body, headers });
		return { status, body: "", ...(retryAfter === undefined ? {} : { retryAfter }) };
	};
	return { post, sent };
}

function worker(
	value: DomainEventDeliveryStore,
	post: WebhookPost,
	options: { opened?: unknown[]; metrics?: ReturnType<typeof createInMemoryBillingMetrics> } = {},
) {
	return new DomainEventDeliveryWorker({
		workerId: "worker-a",
		maxAttempts: 12,
		retentionDays: 30,
		batchSize: 10,
		concurrency: 2,
		store: value,
		sealer: () => sealer(options.opened ?? []),
		post,
		projectContextResolver: projectContextResolver({ contexts: [project] }),
		now: () => now,
		jitterMs: () => 0,
		...(options.metrics === undefined ? {} : { metrics: options.metrics }),
	});
}

describe("domain event delivery worker", () => {
	it("fans out, sends a signed envelope and marks the delivery delivered", async () => {
		const { calls, store: value } = store([
			delivery({ customerId: "customer-42", billingAccountId: "user_42" }),
		]);
		const { post, sent } = recordingPost(200);
		const metrics = createInMemoryBillingMetrics();

		const result = await worker(value, post, { metrics }).runOnce();

		expect(result).toEqual({
			dispatched: 2,
			claimed: 1,
			succeeded: 1,
			failed: 0,
			held: 0,
			expired: 0,
		});
		const [attempt] = sent;
		expect(attempt?.url).toBe("https://hooks.example.com/quotum");
		expect(JSON.parse(attempt?.body ?? "{}")).toEqual({
			id: delivery().eventId,
			type: "webhook.test",
			version: 1,
			createdAt: "2026-10-19T07:59:01.000Z",
			occurredAt: "2026-10-19T07:59:00.000Z",
			environment: "production",
			projectKey: "acme",
			billingAccountId: "user_42",
			data: delivery().data,
		});
		expect(
			verifyWebhookSignature({
				secret: current,
				body: attempt?.body ?? "",
				webhookId: attempt?.headers["webhook-id"] ?? "",
				timestamp: attempt?.headers["webhook-timestamp"] ?? "",
				signature: attempt?.headers["webhook-signature"] ?? "",
				now: () => now,
			}),
		).toBe(true);
		expect(calls.map((call) => call.method)).toEqual([
			"dispatchEvents",
			"claimDeliveries",
			"holdIfAccountErased",
			"markDeliverySucceeded",
			"deleteExpiredEvents",
		]);
		expect(calls[2]?.args).toEqual([project.projectInstanceId, delivery().id, "worker-a"]);
		expect(calls[3]?.args).toEqual([project.projectInstanceId, delivery().id, "worker-a", 200]);
		expect(calls[4]?.args).toEqual([30, 1000]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_event_delivery_total{code="HTTP_200",result="succeeded"} 1',
		);
	});

	it("never sends a delivery about an account being erased, and skips the check without one", async () => {
		const held = store([delivery({ customerId: "customer-42" })], false, true);
		const heldPost = recordingPost(200);
		const unowned = store([delivery({ customerId: null })], false, true);
		const unownedPost = recordingPost(200);

		const heldRun = await worker(held.store, heldPost.post).runOnce();
		const unownedRun = await worker(unowned.store, unownedPost.post).runOnce();

		expect(heldRun).toMatchObject({ claimed: 1, succeeded: 0, failed: 0, held: 1 });
		expect(heldPost.sent).toEqual([]);
		expect(held.calls.map((call) => call.method)).not.toContain("markDeliveryFailed");
		expect(unownedRun).toMatchObject({ succeeded: 1, held: 0 });
		expect(unowned.calls.map((call) => call.method)).not.toContain("holdIfAccountErased");
	});

	it("signs with the replaced secret too while a rotation overlap lasts", async () => {
		const opened: unknown[] = [];
		const { store: value } = store([
			delivery({ previousSecretEnvelope: envelope("previous"), billingAccountId: null }),
		]);
		const { post, sent } = recordingPost(204);

		await worker(value, post, { opened }).runOnce();

		const headers = sent[0]?.headers ?? {};
		expect(headers["webhook-signature"]?.split(" ")).toHaveLength(2);
		expect(opened).toEqual([
			{ projectId: project.projectInstanceId, endpointId: delivery().endpointId, generation: 3 },
			{ projectId: project.projectInstanceId, endpointId: delivery().endpointId, generation: 2 },
		]);
		const verify = (secret: string) =>
			verifyWebhookSignature({
				secret,
				body: sent[0]?.body ?? "",
				webhookId: headers["webhook-id"] ?? "",
				timestamp: headers["webhook-timestamp"] ?? "",
				signature: headers["webhook-signature"] ?? "",
				now: () => now,
			});
		expect(verify(current)).toBe(true);
		expect(verify(previous)).toBe(true);
		expect(JSON.parse(sent[0]?.body ?? "{}")).not.toHaveProperty("billingAccountId");
	});

	it("backs off a failure, honoring a longer Retry-After, and gives up after the last attempt", async () => {
		const failures: WebhookDeliveryFailure[] = [];
		const run = async (attempts: number, status: number, retryAfter?: string) => {
			const { calls, store: value } = store([delivery({ attempts })]);
			await worker(value, recordingPost(status, retryAfter).post).runOnce();
			failures.push(calls.find((call) => call.method === "markDeliveryFailed")?.args[3] as never);
		};

		await run(0, 500);
		await run(0, 429, "600");
		await run(0, 503, "10");
		await run(11, 500);

		expect(failures.map((failure) => failure.nextAttemptAt?.toISOString() ?? null)).toEqual([
			"2026-10-19T08:01:00.000Z",
			"2026-10-19T08:10:00.000Z",
			"2026-10-19T08:01:00.000Z",
			null,
		]);
		expect(failures[0]).toMatchObject({ error: "Receiver answered 500", statusCode: 500 });
	});

	it("counts an envelope it cannot build as a failed attempt, and warns when an endpoint is disabled", async () => {
		const warnings: unknown[] = [];
		const { calls, store: value } = store([delivery({ projectKey: "unknown" })], true);
		const failing = new DomainEventDeliveryWorker({
			workerId: "worker-a",
			maxAttempts: 12,
			retentionDays: 30,
			batchSize: 10,
			store: value,
			sealer: () => sealer([]),
			post: recordingPost(200).post,
			projectContextResolver: projectContextResolver({ contexts: [project] }),
			now: () => now,
			jitterMs: () => 0,
			logger: {
				info: () => undefined,
				warn: (message, fields) => {
					warnings.push({ message, fields });
				},
				error: () => undefined,
			},
		});

		const result = await failing.runOnce();

		expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
		const failure = calls.find((call) => call.method === "markDeliveryFailed")?.args[3];
		expect(failure).toMatchObject({ statusCode: null });
		expect(warnings).toEqual([
			{
				message: "Webhook endpoint disabled after failing deliveries",
				fields: { projectKey: "unknown", endpointId: delivery().endpointId },
			},
		]);
	});

	it("deletes expired events at most every ten minutes", async () => {
		let clock = now.getTime();
		const { calls, store: value } = store([]);
		const timed = new DomainEventDeliveryWorker({
			workerId: "worker-a",
			maxAttempts: 12,
			retentionDays: 30,
			batchSize: 10,
			store: value,
			sealer: () => sealer([]),
			post: recordingPost(200).post,
			projectContextResolver: projectContextResolver({ contexts: [project] }),
			now: () => new Date(clock),
		});

		await timed.runOnce();
		clock += 5 * 60_000;
		await timed.runOnce();
		clock += 5 * 60_000;
		await timed.runOnce();

		expect(calls.filter((call) => call.method === "deleteExpiredEvents")).toHaveLength(2);
	});

	it("refuses a concurrency below one", () => {
		expect(
			() =>
				new DomainEventDeliveryWorker({
					workerId: "worker-a",
					maxAttempts: 12,
					retentionDays: 30,
					batchSize: 10,
					concurrency: 0,
					store: store([]).store,
					sealer: () => sealer([]),
					post: recordingPost(200).post,
					projectContextResolver: projectContextResolver({ contexts: [project] }),
				}),
		).toThrow("domain event delivery concurrency must be greater than zero");
	});
});
