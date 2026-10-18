import { z } from "zod";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
const nullableString = z.union([z.null(), z.string()]);

const webhookEndpointSchema = z.object({
	id: z.string(),
	url: z.string(),
	description: nullableString,
	eventTypes: z.array(z.string()),
	enabled: z.boolean(),
	disabledReason: z.union([z.null(), z.enum(["operator", "failing"])]),
	secretGeneration: z.number(),
	previousSecretExpiresAt: nullableString,
	failingSince: nullableString,
	createdBy: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/** A secret appears once, in the response that created it; a replay carries `null`. */
const secretMutationSchema = z.object({
	success: z.literal(true),
	data: z.object({
		duplicate: z.boolean(),
		endpoint: webhookEndpointSchema,
		secret: nullableString,
		secretDisclosed: z.boolean(),
	}),
});

const endpointSchema = z.object({ success: z.literal(true), data: webhookEndpointSchema });

const webhookDeliverySchema = z.object({
	id: z.string(),
	endpointId: z.string(),
	eventId: z.string(),
	eventType: z.string(),
	billingAccountId: nullableString,
	status: z.enum(["pending", "processing", "succeeded", "failed"]),
	attempts: z.number(),
	nextAttemptAt: nullableString,
	lastError: nullableString,
	lastStatusCode: z.union([z.null(), z.number()]),
	lastAttemptAt: nullableString,
	deliveredAt: nullableString,
	occurredAt: z.string(),
	createdAt: z.string(),
});

export const postV1AdminWebhookEndpointsResponse201Schema = secretMutationSchema;
export const postV1AdminWebhookEndpointsResponse200Schema = secretMutationSchema;

export const getV1AdminWebhookEndpointsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(webhookEndpointSchema),
});

export const getV1AdminWebhookEndpointsByEndpointIdResponse200Schema = endpointSchema;
export const patchV1AdminWebhookEndpointsByEndpointIdResponse200Schema = endpointSchema;

export const deleteV1AdminWebhookEndpointsByEndpointIdResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ id: z.string(), deleted: z.literal(true) }),
});

export const postV1AdminWebhookEndpointsByEndpointIdRotateSecretResponse200Schema =
	secretMutationSchema;

export const postV1AdminWebhookEndpointsByEndpointIdTestResponse202Schema = z.object({
	success: z.literal(true),
	data: z.object({ eventId: z.string(), deliveryId: z.string() }),
});

export const postV1AdminWebhookEndpointsByEndpointIdReplayResponse202Schema = z.object({
	success: z.literal(true),
	data: z.object({ queued: z.number() }),
});

export const getV1AdminWebhookDeliveriesResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(webhookDeliverySchema),
	pagination: z.object({ nextCursor: nullableString }),
});

export const postV1AdminWebhookDeliveriesByDeliveryIdRetryResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ deliveryId: z.string(), status: z.literal("pending") }),
});

export const getV1AdminWebhookEventTypesResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ subscribable: z.array(z.string()), deliverable: z.array(z.string()) }),
});
