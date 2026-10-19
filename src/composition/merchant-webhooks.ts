import { z } from "zod";
import {
	webhookDeliveryListQuerySchema,
	webhookEndpointCreateBodySchema,
	webhookEndpointUpdateBodySchema,
	webhookReplayBodySchema,
	webhookSecretRotationBodySchema,
} from "../app/webhook-endpoint-routes";
import { InvalidRequestError } from "../billing/errors";
import { requireIdempotencyKey } from "../billing/idempotency-key";
import type { WebhookEndpointServiceLike } from "../events/endpoints";
import { deliverableEventTypes, subscribableEventTypes } from "../events/types";
import type {
	MerchantBillingCommand,
	MerchantBillingOperation,
} from "../platform/application/billing-port";
import type { ProjectInstanceContext } from "../projects/context";
import { describeRequestIssues, requestIssues } from "../shared/request-issues";

const webhookOperations = new Set<MerchantBillingOperation>([
	"webhooks.endpoints",
	"webhooks.endpoints.create",
	"webhooks.endpoints.detail",
	"webhooks.endpoints.update",
	"webhooks.endpoints.delete",
	"webhooks.endpoints.rotate-secret",
	"webhooks.endpoints.test",
	"webhooks.endpoints.replay",
	"webhooks.deliveries",
	"webhooks.deliveries.retry",
	"webhooks.event-types",
]);

export function isWebhookOperation(operation: MerchantBillingOperation): boolean {
	return webhookOperations.has(operation);
}

/**
 * The console's webhook endpoint operations, answered as the `/v1/admin/webhook-*` routes answer
 * them. The console stores what a write answers, so the platform withholds a disclosed secret from
 * that stored copy (`withheldSecret`); this answer carries it once, like `/v1`.
 */
export async function dispatchWebhookOperation(
	service: WebhookEndpointServiceLike,
	project: ProjectInstanceContext,
	command: MerchantBillingCommand,
): Promise<{ status: number; body: unknown }> {
	const [id = ""] = command.parameters;
	const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } });
	const endpointId = () => parse(z.uuid(), id);
	switch (command.operation) {
		case "webhooks.endpoints":
			return ok(await service.listEndpoints(project));
		case "webhooks.endpoints.create": {
			const body = parse(webhookEndpointCreateBodySchema, command.body);
			const result = await service.createEndpoint(project, {
				url: body.url,
				description: body.description ?? null,
				eventTypes: body.eventTypes,
				enabled: body.enabled,
				actor: command.actor,
				idempotencyKey: requireIdempotencyKey(command.idempotencyKey),
			});
			return ok(result, result.duplicate ? 200 : 201);
		}
		case "webhooks.endpoints.detail":
			return ok(await service.getEndpoint(project, endpointId()));
		case "webhooks.endpoints.update":
			return ok(
				await service.updateEndpoint(
					project,
					endpointId(),
					parse(webhookEndpointUpdateBodySchema, command.body),
				),
			);
		case "webhooks.endpoints.delete": {
			const deleted = await service.deleteEndpoint(project, endpointId());
			return ok({ id: deleted.id, deleted: true });
		}
		case "webhooks.endpoints.rotate-secret": {
			const body = parse(webhookSecretRotationBodySchema, command.body ?? {});
			return ok(
				await service.rotateSecret(project, endpointId(), {
					overlapHours: body.overlapHours,
					idempotencyKey: requireIdempotencyKey(command.idempotencyKey),
				}),
			);
		}
		case "webhooks.endpoints.test":
			return ok(await service.sendTestEvent(project, endpointId()), 202);
		case "webhooks.endpoints.replay": {
			const body = parse(webhookReplayBodySchema, command.body);
			return ok(
				await service.replay(project, endpointId(), {
					from: new Date(body.from),
					to: new Date(body.to),
					eventTypes: body.eventTypes,
				}),
				202,
			);
		}
		case "webhooks.deliveries": {
			const query = parse(webhookDeliveryListQuerySchema, command.query);
			const result = await service.listDeliveries(project, {
				limit: query.limit,
				cursor: query.cursor ?? null,
				endpointId: query.endpointId ?? null,
				status: query.status ?? null,
				eventType: query.eventType ?? null,
				billingAccountId: query.billingAccountId ?? null,
			});
			return {
				status: 200,
				body: { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } },
			};
		}
		case "webhooks.deliveries.retry":
			return ok(await service.retryDelivery(project, parse(z.uuid(), id)));
		case "webhooks.event-types":
			return ok({ subscribable: subscribableEventTypes(), deliverable: deliverableEventTypes() });
		default:
			throw new InvalidRequestError("Unsupported billing operation");
	}
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		const { issues } = result.error;
		throw new InvalidRequestError(
			describeRequestIssues(
				"Invalid billing operation input",
				requestIssues(null, issues),
				issues.length,
			),
		);
	}
	return result.data;
}
