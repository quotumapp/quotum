import { z } from "zod";
import { requireIdempotencyKey } from "../billing/idempotency-key";
import {
	type WebhookEndpointServiceLike,
	webhookDeliveryStatuses,
	webhookDescriptionMaxLength,
	webhookEventTypesMax,
	webhookSecretOverlapHoursDefault,
	webhookSecretOverlapHoursMax,
	webhookUrlMaxLength,
} from "../events/endpoints";
import { deliverableEventTypes, subscribableEventTypes } from "../events/types";
import { type BillingLogger, safelyLogInfo } from "../observability/logger";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { decimalDigitsQuery } from "../shared/input-bounds";
import { operatorKeyPaths } from "../shared/operator-key-paths";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/webhook-endpoint-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

/**
 * Outbound webhook endpoints and their deliveries: where a project's billing events are sent. Not
 * to be confused with the inbound provider webhooks in `webhook-routes.ts`.
 */
export interface WebhookEndpointRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	service: WebhookEndpointServiceLike;
	billingLogger: BillingLogger;
	registerPostAuthGuard(guard: PostAuthGuard): void;
}

const url = z.string().trim().min(1).max(webhookUrlMaxLength);
const description = z.union([z.null(), z.string().max(webhookDescriptionMaxLength)]);
const eventTypes = z.array(z.string().trim().min(1).max(100)).max(webhookEventTypesMax);

export const webhookEndpointCreateBodySchema = z
	.object({
		url,
		description: description.optional(),
		eventTypes: eventTypes.default([]),
		enabled: z.boolean().default(true),
	})
	.strict();

export const webhookEndpointUpdateBodySchema = z
	.object({
		url: url.optional(),
		description: description.optional(),
		eventTypes: eventTypes.optional(),
		enabled: z.boolean().optional(),
	})
	.strict();

export const webhookSecretRotationBodySchema = z
	.object({
		overlapHours: z
			.number()
			.int()
			.min(0)
			.max(webhookSecretOverlapHoursMax)
			.default(webhookSecretOverlapHoursDefault),
	})
	.strict();

const instant = z.iso.datetime({ offset: true });

export const webhookReplayBodySchema = z
	.object({ from: instant, to: instant, eventTypes: eventTypes.default([]) })
	.strict();

const endpointParams = z.object({ endpointId: z.uuid() }).strict();
const deliveryParams = z.object({ deliveryId: z.uuid() }).strict();

export const webhookDeliveryListQuerySchema = z
	.object({
		limit: decimalDigitsQuery(z.coerce.number().int().positive().max(100).default(25)),
		cursor: z.string().trim().min(1).optional(),
		endpointId: z.uuid().optional(),
		status: z.enum(webhookDeliveryStatuses).optional(),
		eventType: z.string().trim().min(1).max(100).optional(),
		billingAccountId: z.string().trim().min(1).max(200).optional(),
	})
	.strict();

const tags = ["webhooks"];

export function registerWebhookEndpointRoutes({
	app,
	operatorApiKey,
	service,
	billingLogger,
	registerPostAuthGuard,
}: WebhookEndpointRoutesDependencies): void {
	registerPostAuthGuard(operatorApiKeyGuard(operatorApiKey, operatorKeyPaths.webhookEndpoints));

	app.post(
		"/v1/admin/webhook-endpoints",
		async ({ body, request, project, set }) => {
			const scopedProject = privateProject(project);
			const result = await service.createEndpoint(scopedProject, {
				url: body.url,
				description: body.description ?? null,
				eventTypes: body.eventTypes,
				enabled: body.enabled,
				actor: requireActor(request.headers),
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			});
			if (!result.duplicate) {
				// Ids only: the URL and the secret stay out of log lines.
				safelyLogInfo(billingLogger, "Billing admin webhook endpoint created", {
					projectKey: scopedProject.projectInstanceKey,
					endpointId: result.endpoint.id,
				});
			}
			set.status = result.duplicate ? 200 : 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: webhookEndpointCreateBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminWebhookEndpoints",
				tags,
				path: "/v1/admin/webhook-endpoints",
				responses: {
					200: responses.postV1AdminWebhookEndpointsResponse200Schema,
					201: responses.postV1AdminWebhookEndpointsResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/webhook-endpoints",
		async ({ project }) => ({
			success: true,
			data: await service.listEndpoints(privateProject(project)),
		}),
		{
			detail: operationDetail({
				operationId: "getV1AdminWebhookEndpoints",
				tags,
				path: "/v1/admin/webhook-endpoints",
				responses: { 200: responses.getV1AdminWebhookEndpointsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/webhook-endpoints/:endpointId",
		async ({ params, project }) => ({
			success: true,
			data: await service.getEndpoint(privateProject(project), params.endpointId),
		}),
		{
			params: endpointParams,
			detail: operationDetail({
				operationId: "getV1AdminWebhookEndpointsByEndpointId",
				tags,
				path: "/v1/admin/webhook-endpoints/:endpointId",
				responses: { 200: responses.getV1AdminWebhookEndpointsByEndpointIdResponse200Schema },
			}),
		},
	);

	app.patch(
		"/v1/admin/webhook-endpoints/:endpointId",
		async ({ body, params, request, project }) => {
			requireActor(request.headers);
			return {
				success: true,
				data: await service.updateEndpoint(privateProject(project), params.endpointId, body),
			};
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: endpointParams,
			body: webhookEndpointUpdateBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "patchV1AdminWebhookEndpointsByEndpointId",
				tags,
				path: "/v1/admin/webhook-endpoints/:endpointId",
				responses: { 200: responses.patchV1AdminWebhookEndpointsByEndpointIdResponse200Schema },
			}),
		},
	);

	app.delete(
		"/v1/admin/webhook-endpoints/:endpointId",
		async ({ params, request, project }) => {
			requireActor(request.headers);
			const deleted = await service.deleteEndpoint(privateProject(project), params.endpointId);
			return { success: true, data: { id: deleted.id, deleted: true } };
		},
		{
			parse: "none",
			params: endpointParams,
			detail: operationDetail({
				operationId: "deleteV1AdminWebhookEndpointsByEndpointId",
				tags,
				path: "/v1/admin/webhook-endpoints/:endpointId",
				responses: { 200: responses.deleteV1AdminWebhookEndpointsByEndpointIdResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/webhook-endpoints/:endpointId/rotate-secret",
		async ({ body, params, request, project }) => {
			requireActor(request.headers);
			const scopedProject = privateProject(project);
			const result = await service.rotateSecret(scopedProject, params.endpointId, {
				overlapHours: body.overlapHours,
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			});
			if (!result.duplicate) {
				safelyLogInfo(billingLogger, "Billing admin webhook secret rotated", {
					projectKey: scopedProject.projectInstanceKey,
					endpointId: result.endpoint.id,
				});
			}
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: endpointParams,
			body: webhookSecretRotationBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminWebhookEndpointsByEndpointIdRotateSecret",
				tags,
				path: "/v1/admin/webhook-endpoints/:endpointId/rotate-secret",
				responses: {
					200: responses.postV1AdminWebhookEndpointsByEndpointIdRotateSecretResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/webhook-endpoints/:endpointId/test",
		async ({ params, request, project, set }) => {
			requireActor(request.headers);
			const result = await service.sendTestEvent(privateProject(project), params.endpointId);
			set.status = 202;
			return { success: true, data: result };
		},
		{
			parse: "none",
			params: endpointParams,
			detail: operationDetail({
				operationId: "postV1AdminWebhookEndpointsByEndpointIdTest",
				tags,
				path: "/v1/admin/webhook-endpoints/:endpointId/test",
				responses: { 202: responses.postV1AdminWebhookEndpointsByEndpointIdTestResponse202Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/webhook-endpoints/:endpointId/replay",
		async ({ body, params, request, project, set }) => {
			requireActor(request.headers);
			const result = await service.replay(privateProject(project), params.endpointId, {
				from: new Date(body.from),
				to: new Date(body.to),
				eventTypes: body.eventTypes,
			});
			set.status = 202;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: endpointParams,
			body: webhookReplayBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminWebhookEndpointsByEndpointIdReplay",
				tags,
				path: "/v1/admin/webhook-endpoints/:endpointId/replay",
				responses: {
					202: responses.postV1AdminWebhookEndpointsByEndpointIdReplayResponse202Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/webhook-deliveries",
		async ({ query, project }) => {
			const result = await service.listDeliveries(privateProject(project), {
				limit: query.limit,
				cursor: query.cursor ?? null,
				endpointId: query.endpointId ?? null,
				status: query.status ?? null,
				eventType: query.eventType ?? null,
				billingAccountId: query.billingAccountId ?? null,
			});
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			query: webhookDeliveryListQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminWebhookDeliveries",
				tags,
				path: "/v1/admin/webhook-deliveries",
				responses: { 200: responses.getV1AdminWebhookDeliveriesResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/webhook-deliveries/:deliveryId/retry",
		async ({ params, request, project }) => {
			requireActor(request.headers);
			return {
				success: true,
				data: await service.retryDelivery(privateProject(project), params.deliveryId),
			};
		},
		{
			parse: "none",
			params: deliveryParams,
			detail: operationDetail({
				operationId: "postV1AdminWebhookDeliveriesByDeliveryIdRetry",
				tags,
				path: "/v1/admin/webhook-deliveries/:deliveryId/retry",
				responses: {
					200: responses.postV1AdminWebhookDeliveriesByDeliveryIdRetryResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/webhook-event-types",
		() => ({
			success: true,
			data: { subscribable: subscribableEventTypes(), deliverable: deliverableEventTypes() },
		}),
		{
			detail: operationDetail({
				operationId: "getV1AdminWebhookEventTypes",
				tags,
				path: "/v1/admin/webhook-event-types",
				responses: { 200: responses.getV1AdminWebhookEventTypesResponse200Schema },
			}),
		},
	);
}
