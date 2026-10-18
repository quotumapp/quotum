import { z } from "zod";
import { projectEnvironments } from "../projects/context";
import {
	type DomainEventEnvelope,
	domainEventDataSchemas,
	webhookTestDataSchema,
	webhookTestEventType,
} from "./types";

type JsonSchema = Record<string, unknown>;

const timestamp = z.iso.datetime({ offset: true });

function envelopeOf(type: string, data: z.ZodType<Record<string, unknown>>) {
	return z.object({
		id: z
			.uuid()
			.describe(
				"The event. It is also the webhook-id header and stays the same across retries and replays: deduplicate on it.",
			),
		type: z.literal(type).describe("What happened. Ignore types you do not handle."),
		version: z.literal(1).describe("Version of this body's format."),
		createdAt: timestamp.describe("When Quotum recorded the event."),
		occurredAt: timestamp.describe("When the fact the event reports happened."),
		environment: z
			.enum(projectEnvironments)
			.describe("The environment of the project instance the event belongs to."),
		projectKey: z.string().min(1).describe("Key of the project instance."),
		billingAccountId: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Your identifier for the billing account the event is about, when it is about one.",
			),
		data: data,
	});
}

/**
 * The body of one webhook delivery, one variant per event type. `contracts/v1/domain-events.schema.json`
 * is rendered from it, so a type is listed here before a fact records it.
 */
export const domainEventDeliverySchema = z.discriminatedUnion("type", [
	envelopeOf(webhookTestEventType, webhookTestDataSchema),
	...Object.entries(domainEventDataSchemas)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([type, data]) => envelopeOf(type, data)),
]);

/** Fails to compile when the worker's envelope stops fitting the published schema. */
export const envelopeFitsContract = (
	envelope: DomainEventEnvelope,
): z.input<typeof domainEventDeliverySchema> =>
	envelope as z.input<typeof domainEventDeliverySchema>;

export function domainEventsJsonSchema(): JsonSchema {
	const rendered = z.toJSONSchema(domainEventDeliverySchema, {
		target: "draft-2020-12",
		io: "input",
		unrepresentable: "any",
		override: ({ jsonSchema }) => {
			delete jsonSchema.additionalProperties;
			// `format` says it; the pattern Zod adds repeats it as a 300-character expression.
			if (jsonSchema.format === "date-time" || jsonSchema.format === "uuid")
				delete jsonSchema.pattern;
		},
	}) as JsonSchema;
	return {
		...rendered,
		title: "Quotum outbound domain event",
		description:
			"Body of a webhook delivery, signed with Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature). Verify the raw body before parsing it, and ignore fields and event types this schema does not name.",
	};
}
