import { describe, expect, it } from "bun:test";
import type { AdminBillingReader } from "../../src/admin/types";
import { createMerchantBillingPort } from "../../src/composition/merchant-billing";
import type { BillingRepository } from "../../src/db/repository";
import {
	type WebhookEndpointRecord,
	type WebhookEndpointServiceLike,
	webhookError,
} from "../../src/events/endpoints";
import { subscribableEventTypes } from "../../src/events/types";
import type { MerchantBillingCommand } from "../../src/platform/application/billing-port";
import type { ProviderCapabilityReads } from "../../src/providers/capability-read-types";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext("acme");
const inactive = projectInstanceContext("globex", { lifecycleStatus: "inactive" });
const endpointId = "11111111-1111-4111-8111-111111111111";
const deliveryId = "22222222-2222-4222-8222-222222222222";

const endpoint: WebhookEndpointRecord = {
	id: endpointId,
	url: "https://hooks.example.com/quotum",
	description: null,
	eventTypes: [],
	enabled: true,
	disabledReason: null,
	secretGeneration: 1,
	previousSecretExpiresAt: null,
	failingSince: null,
	createdBy: "merchant:principal",
	createdAt: "2026-10-19T08:00:00.000Z",
	updatedAt: "2026-10-19T08:00:00.000Z",
};

/** Records each call with the project it was made for, and answers as the real service would. */
function recordingService(calls: unknown[][]): WebhookEndpointServiceLike {
	return {
		async createEndpoint(context, input) {
			calls.push(["create", context.projectInstanceId, input]);
			const duplicate = input.idempotencyKey === "repeat";
			return {
				duplicate,
				endpoint,
				secret: duplicate ? null : "whsec_c2VjcmV0",
				secretDisclosed: !duplicate,
			};
		},
		async listEndpoints(context) {
			calls.push(["list", context.projectInstanceId]);
			return [endpoint];
		},
		async getEndpoint(context, id) {
			calls.push(["get", context.projectInstanceId, id]);
			throw webhookError("WEBHOOK_ENDPOINT_NOT_FOUND");
		},
		async updateEndpoint(context, id, input) {
			calls.push(["update", context.projectInstanceId, id, input]);
			return { ...endpoint, enabled: false };
		},
		async deleteEndpoint(context, id) {
			calls.push(["delete", context.projectInstanceId, id]);
			return { id };
		},
		async rotateSecret(context, id, input) {
			calls.push(["rotate", context.projectInstanceId, id, input]);
			return { duplicate: false, endpoint, secret: "whsec_bmV3", secretDisclosed: true };
		},
		async sendTestEvent(context, id) {
			calls.push(["test", context.projectInstanceId, id]);
			return { eventId: "33333333-3333-4333-8333-333333333333", deliveryId };
		},
		async replay(context, id, input) {
			calls.push(["replay", context.projectInstanceId, id, input]);
			return { queued: 3 };
		},
		async listDeliveries(context, options) {
			calls.push(["deliveries", context.projectInstanceId, options]);
			return { items: [], nextCursor: null };
		},
		async retryDelivery(context, id) {
			calls.push(["retry", context.projectInstanceId, id]);
			return { deliveryId: id, status: "pending" };
		},
	};
}

function port(calls: unknown[][]) {
	return createMerchantBillingPort({
		repository: {} as BillingRepository,
		reader: {} as AdminBillingReader,
		resolver: projectContextResolver({ contexts: [project, inactive] }),
		providers: {
			appleStoreKitService: async () => null,
			googlePlayBillingService: async () => null,
			stripeBillingService: async () => null,
			paddleBillingService: async () => null,
		},
		capabilityReads: {} as ProviderCapabilityReads,
		webhooks: recordingService(calls),
	});
}

function command(
	operation: MerchantBillingCommand["operation"],
	overrides: Partial<MerchantBillingCommand> = {},
): MerchantBillingCommand {
	return {
		operation,
		parameters: [endpointId],
		projectInstanceId: project.projectInstanceId,
		actor: "merchant:principal",
		query: {},
		body: {},
		idempotencyKey: "console-key",
		...overrides,
	};
}

describe("merchant webhook operations", () => {
	it("creates an endpoint as the member and discloses its secret once", async () => {
		const calls: unknown[][] = [];
		const billing = port(calls);
		const body = { url: "https://hooks.example.com/quotum", eventTypes: ["invoice.paid"] };
		const created = await billing.dispatch(
			command("webhooks.endpoints.create", { parameters: [], body }),
		);
		expect(created).toEqual({
			status: 201,
			body: {
				success: true,
				data: { duplicate: false, endpoint, secret: "whsec_c2VjcmV0", secretDisclosed: true },
			},
		});
		const repeated = await billing.dispatch(
			command("webhooks.endpoints.create", { parameters: [], body, idempotencyKey: "repeat" }),
		);
		expect(repeated.status).toBe(200);
		expect(calls[0]).toEqual([
			"create",
			project.projectInstanceId,
			{
				url: body.url,
				description: null,
				eventTypes: ["invoice.paid"],
				enabled: true,
				actor: "merchant:principal",
				idempotencyKey: "console-key",
			},
		]);
	});

	it("refuses a create without an idempotency key or with an unknown field", async () => {
		const calls: unknown[][] = [];
		const billing = port(calls);
		const body = { url: "https://hooks.example.com/quotum" };
		for (const refused of [
			command("webhooks.endpoints.create", { parameters: [], body, idempotencyKey: null }),
			command("webhooks.endpoints.create", { parameters: [], body: { ...body, secret: "x" } }),
			command("webhooks.endpoints.update", { body: { enabled: "no" } }),
			command("webhooks.endpoints.replay", { body: { from: "yesterday" } }),
			command("webhooks.endpoints.detail", { parameters: ["not-a-uuid"] }),
			command("webhooks.deliveries", { parameters: [], query: { limit: "500" } }),
		]) {
			const result = await billing.dispatch(refused);
			expect(result.status, refused.operation).toBe(400);
			expect(result.body).toMatchObject({ success: false, error: { code: "INVALID_REQUEST" } });
		}
		expect(calls).toEqual([]);
	});

	it("maps each operation onto the service for the selected environment", async () => {
		const calls: unknown[][] = [];
		const billing = port(calls);
		const id = project.projectInstanceId;
		expect(await billing.dispatch(command("webhooks.endpoints", { parameters: [] }))).toEqual({
			status: 200,
			body: { success: true, data: [endpoint] },
		});
		expect(
			await billing.dispatch(command("webhooks.endpoints.update", { body: { enabled: false } })),
		).toMatchObject({ status: 200, body: { data: { enabled: false } } });
		expect(await billing.dispatch(command("webhooks.endpoints.delete"))).toEqual({
			status: 200,
			body: { success: true, data: { id: endpointId, deleted: true } },
		});
		expect(await billing.dispatch(command("webhooks.endpoints.rotate-secret"))).toMatchObject({
			status: 200,
			body: { data: { secret: "whsec_bmV3", secretDisclosed: true } },
		});
		expect(await billing.dispatch(command("webhooks.endpoints.test"))).toMatchObject({
			status: 202,
			body: { data: { deliveryId } },
		});
		const window = { from: "2026-10-18T00:00:00Z", to: "2026-10-19T00:00:00Z" };
		expect(
			await billing.dispatch(command("webhooks.endpoints.replay", { body: window })),
		).toMatchObject({ status: 202, body: { data: { queued: 3 } } });
		expect(
			await billing.dispatch(
				command("webhooks.deliveries", {
					parameters: [],
					query: { status: "failed", endpointId, limit: "10" },
				}),
			),
		).toEqual({ status: 200, body: { success: true, data: [], pagination: { nextCursor: null } } });
		expect(
			await billing.dispatch(command("webhooks.deliveries.retry", { parameters: [deliveryId] })),
		).toEqual({ status: 200, body: { success: true, data: { deliveryId, status: "pending" } } });
		expect(
			await billing.dispatch(command("webhooks.event-types", { parameters: [] })),
		).toMatchObject({ status: 200, body: { data: { subscribable: subscribableEventTypes() } } });
		expect(calls).toEqual([
			["list", id],
			["update", id, endpointId, { enabled: false }],
			["delete", id, endpointId],
			["rotate", id, endpointId, { overlapHours: 24, idempotencyKey: "console-key" }],
			["test", id, endpointId],
			[
				"replay",
				id,
				endpointId,
				{ from: new Date(window.from), to: new Date(window.to), eventTypes: [] },
			],
			[
				"deliveries",
				id,
				{
					limit: 10,
					cursor: null,
					endpointId,
					status: "failed",
					eventType: null,
					billingAccountId: null,
				},
			],
			["retry", id, deliveryId],
		]);
	});

	it("answers a service refusal with its error envelope", async () => {
		const billing = port([]);
		expect(await billing.dispatch(command("webhooks.endpoints.detail"))).toMatchObject({
			status: 404,
			body: { success: false, error: { code: "WEBHOOK_ENDPOINT_NOT_FOUND" } },
		});
	});

	it("refuses webhook operations on an environment that is not active", async () => {
		const calls: unknown[][] = [];
		const result = await port(calls).dispatch(
			command("webhooks.endpoints", {
				parameters: [],
				projectInstanceId: inactive.projectInstanceId,
			}),
		);
		expect(result).toMatchObject({ status: 404, body: { error: { code: "CONTEXT_UNAVAILABLE" } } });
		expect(calls).toEqual([]);
	});
});
