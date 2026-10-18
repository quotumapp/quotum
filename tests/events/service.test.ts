import { describe, expect, it } from "bun:test";
import type { WebhookEndpointRecord } from "../../src/events/endpoints";
import type { SealedWebhookSecret, WebhookSecretSealer } from "../../src/events/secret-sealer";
import { WebhookEndpointService, type WebhookEndpointStore } from "../../src/events/service";
import { projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext("acme");
const secret = "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==";
const endpointId = "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e20";

const record = (overrides: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord => ({
	id: endpointId,
	url: "https://hooks.example.com/quotum",
	description: null,
	eventTypes: [],
	enabled: true,
	disabledReason: null,
	secretGeneration: 1,
	previousSecretExpiresAt: null,
	failingSince: null,
	createdBy: "support@example.com",
	createdAt: "2026-10-19T08:00:00.000Z",
	updatedAt: "2026-10-19T08:00:00.000Z",
	...overrides,
});

const sealer: WebhookSecretSealer = {
	activeKeyId: "k1",
	seal: (value, scope) => ({
		keyId: "k1",
		nonce: `${scope.projectId}:${scope.endpointId}:${scope.generation}`,
		tag: "tag",
		ciphertext: `sealed:${value}`,
	}),
	open: (envelope) => envelope.ciphertext.replace("sealed:", ""),
};

function recordingStore(duplicate = false) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const store: WebhookEndpointStore = {
		insertEndpoint: (...args) => {
			calls.push({ method: "insertEndpoint", args });
			return Promise.resolve({ duplicate, endpoint: record() });
		},
		listEndpoints: () => Promise.resolve([record()]),
		getEndpoint: () => Promise.resolve(record()),
		updateEndpoint: (...args) => {
			calls.push({ method: "updateEndpoint", args });
			return Promise.resolve(record());
		},
		deleteEndpoint: () => Promise.resolve({ id: endpointId }),
		rotateSecret: (projectId, id, rotation) => {
			calls.push({
				method: "rotateSecret",
				args: [projectId, id, rotation.seal(2), rotation.overlapHours, rotation.idempotencyKey],
			});
			return Promise.resolve({ duplicate, endpoint: record({ secretGeneration: 2 }) });
		},
		insertTestEvent: () => Promise.resolve({ eventId: "event", deliveryId: "delivery" }),
		replay: (...args) => {
			calls.push({ method: "replay", args });
			return Promise.resolve(4);
		},
		listDeliveries: () => Promise.resolve({ items: [], nextCursor: null }),
		retryDelivery: (_projectId, deliveryId) =>
			Promise.resolve({ deliveryId, status: "pending" as const }),
	};
	return { calls, store };
}

function service(store: WebhookEndpointStore, allowInsecureHttp = false) {
	return new WebhookEndpointService({
		store,
		sealer: () => sealer,
		allowInsecureHttp,
		newId: () => endpointId,
		generateSecret: () => secret,
	});
}

const create = {
	url: " https://Hooks.Example.com/quotum ",
	description: "  Billing events  ",
	eventTypes: [] as string[],
	enabled: true,
	actor: "support@example.com",
	idempotencyKey: "create-1",
};

describe("webhook endpoint service", () => {
	it("discloses a new endpoint's secret once and stores only its sealed form", async () => {
		const { calls, store } = recordingStore();

		const result = await service(store).createEndpoint(project, create);

		expect(result).toEqual({
			duplicate: false,
			endpoint: record(),
			secret,
			secretDisclosed: true,
		});
		const [insert] = calls;
		const stored = insert?.args[1] as { secretEnvelope: SealedWebhookSecret; url: string };
		expect(insert?.args[0]).toBe(project.projectInstanceId);
		expect(stored.url).toBe("https://hooks.example.com/quotum");
		expect(stored.secretEnvelope).toEqual({
			keyId: "k1",
			nonce: `${project.projectInstanceId}:${endpointId}:1`,
			tag: "tag",
			ciphertext: `sealed:${secret}`,
		});
		expect(JSON.stringify({ ...stored, secretEnvelope: null })).not.toContain(secret);
		expect(insert?.args[1]).toMatchObject({
			description: "Billing events",
			eventTypes: [],
			createdBy: "support@example.com",
			idempotencyKey: "create-1",
		});
	});

	it("returns no secret when a create or a rotation is replayed", async () => {
		const { store } = recordingStore(true);

		const created = await service(store).createEndpoint(project, create);
		const rotated = await service(store).rotateSecret(project, endpointId, {
			overlapHours: 24,
			idempotencyKey: "rotate-1",
		});

		expect(created).toMatchObject({ duplicate: true, secret: null, secretDisclosed: false });
		expect(rotated).toMatchObject({ duplicate: true, secret: null, secretDisclosed: false });
	});

	it("hashes equal requests equally, whatever the spelling of the same terms", async () => {
		const first = recordingStore();
		const second = recordingStore();

		await service(first.store).createEndpoint(project, create);
		await service(second.store).createEndpoint(project, {
			...create,
			url: "https://hooks.example.com/quotum",
			description: "Billing events",
		});

		const hash = (calls: typeof first.calls) =>
			(calls[0]?.args[1] as { requestHash: string } | undefined)?.requestHash;
		expect(hash(first.calls)).toBe(hash(second.calls));
		expect(hash(first.calls)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("refuses URLs that are not https, carry credentials or a fragment, and unknown types", async () => {
		const { calls, store } = recordingStore();
		const attempt = (overrides: Partial<typeof create>) =>
			service(store).createEndpoint(project, { ...create, ...overrides });

		await expect(attempt({ url: "http://hooks.example.com" })).rejects.toThrow(
			"url must be an https URL",
		);
		await expect(attempt({ url: "https://user:pass@hooks.example.com" })).rejects.toThrow(
			"without credentials",
		);
		await expect(attempt({ url: "https://hooks.example.com/#hash" })).rejects.toThrow(
			"without credentials or a fragment",
		);
		await expect(attempt({ url: "hooks.example.com" })).rejects.toThrow("absolute URL");
		await expect(attempt({ eventTypes: ["invoice.paid"] })).rejects.toMatchObject({
			code: "WEBHOOK_EVENT_TYPE_UNKNOWN",
			details: { unknown: ["invoice.paid"] },
		});
		expect(calls).toEqual([]);
	});

	it("accepts plain http only where the deployment approved private receivers", async () => {
		const { calls, store } = recordingStore();

		await service(store, true).createEndpoint(project, {
			...create,
			url: "http://billing.internal:8080/hooks",
		});

		expect((calls[0]?.args[1] as { url: string } | undefined)?.url).toBe(
			"http://billing.internal:8080/hooks",
		);
	});

	it("seals a rotated secret for the next generation and bounds the overlap", async () => {
		const { calls, store } = recordingStore();

		const rotated = await service(store).rotateSecret(project, endpointId, {
			overlapHours: 0,
			idempotencyKey: "rotate-1",
		});

		expect(rotated).toMatchObject({ duplicate: false, secret, secretDisclosed: true });
		expect(calls[0]?.args).toEqual([
			project.projectInstanceId,
			endpointId,
			{
				keyId: "k1",
				nonce: `${project.projectInstanceId}:${endpointId}:2`,
				tag: "tag",
				ciphertext: `sealed:${secret}`,
			},
			0,
			"rotate-1",
		]);
		await expect(
			service(store).rotateSecret(project, endpointId, {
				overlapHours: 169,
				idempotencyKey: "rotate-2",
			}),
		).rejects.toThrow("overlapHours must be a whole number from 0 to 168");
	});

	it("needs a change to update and normalizes what it changes", async () => {
		const { calls, store } = recordingStore();

		await expect(service(store).updateEndpoint(project, endpointId, {})).rejects.toThrow(
			"An update must change url, description, eventTypes or enabled",
		);
		await service(store).updateEndpoint(project, endpointId, {
			description: "   ",
			enabled: false,
		});

		expect(calls).toEqual([
			{
				method: "updateEndpoint",
				args: [project.projectInstanceId, endpointId, { description: null, enabled: false }],
			},
		]);
	});

	it("replays only a forward window", async () => {
		const { calls, store } = recordingStore();
		const from = new Date("2026-10-18T00:00:00Z");
		const to = new Date("2026-10-19T00:00:00Z");

		expect(await service(store).replay(project, endpointId, { from, to, eventTypes: [] })).toEqual({
			queued: 4,
		});
		await expect(
			service(store).replay(project, endpointId, { from: to, to: from, eventTypes: [] }),
		).rejects.toThrow("from must be earlier than to");
		expect(calls).toEqual([
			{
				method: "replay",
				args: [project.projectInstanceId, endpointId, { from, to, eventTypes: [] }],
			},
		]);
	});
});
