import { z } from "zod";
import type { ProjectEnvironment } from "../projects/context";

/**
 * The event every endpoint can be sent on request, to check that it receives and verifies
 * deliveries. It is never recorded from a billing fact, so no endpoint subscribes to it.
 */
export const webhookTestEventType = "webhook.test";

/**
 * The event types an endpoint can subscribe to, each with the schema of its `data`. Billing facts
 * record these in their own transaction; a type is listed here once a fact records it.
 */
export const domainEventDataSchemas: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> =
	{};

export const webhookTestDataSchema = z
	.object({
		endpointId: z.string(),
		message: z.string(),
	})
	.strict();

/** Every type that can be delivered, the test event included. */
export function deliverableEventTypes(): string[] {
	return [webhookTestEventType, ...subscribableEventTypes()];
}

export function subscribableEventTypes(): string[] {
	return Object.keys(domainEventDataSchemas).sort();
}

export function isSubscribableEventType(type: string): boolean {
	return Object.hasOwn(domainEventDataSchemas, type);
}

/** The same rule as the `domain_events.type` check constraint. */
export const domainEventTypePattern = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

/**
 * The body of one delivery. `id` is also the `webhook-id` header: it stays the same across retries
 * and replays, so a receiver deduplicates on it.
 */
export interface DomainEventEnvelope {
	id: string;
	type: string;
	version: 1;
	createdAt: string;
	occurredAt: string;
	environment: ProjectEnvironment;
	projectKey: string;
	/** The billing account the event is about, when it is about one. */
	billingAccountId?: string;
	data: Record<string, unknown>;
}
