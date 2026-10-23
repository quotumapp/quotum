import { z } from "zod";
import {
	billingChannels,
	billingProviders,
	projectionPlanGrantPayloadSchema,
	projectionReversalPayloadSchema,
	projectionSubscriptionSchema,
	projectionTrialPayloadSchema,
	subscriptionStatuses,
} from "../billing/types";
import type { ProjectEnvironment } from "../projects/context";
import { cadenceUnits } from "../shared/cadence";

/**
 * The event every endpoint can be sent on request, to check that it receives and verifies
 * deliveries. It is never recorded from a billing fact, so no endpoint subscribes to it.
 */
export const webhookTestEventType = "webhook.test";

const timestamp = z.iso.datetime({ offset: true });
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const minor = z.number().int().nonnegative();

/** A subscription as it stands after the change an event reports. */
const subscriptionSchema = z
	.object({
		id: z.uuid(),
		externalSubscriptionId: z.string().min(1),
		provider: z.enum(billingProviders),
		channel: z.enum(billingChannels),
		productKey: z.string().min(1),
		status: z.enum(subscriptionStatuses),
		providerStatus: z.string().nullable(),
		startsAt: timestamp,
		expiresAt: timestamp.nullable(),
		currentPeriodStart: timestamp.nullable(),
		currentPeriodEnd: timestamp.nullable(),
		cancelAtPeriodEnd: z.boolean(),
		autoRenew: z.boolean(),
	})
	.strict();

/** The tracked attributes that changed, with the values they had before. */
const previousAttributesSchema = z
	.object({
		status: z.enum(subscriptionStatuses).optional(),
		productKey: z.string().min(1).optional(),
		expiresAt: timestamp.nullable().optional(),
		currentPeriodEnd: timestamp.nullable().optional(),
		cancelAtPeriodEnd: z.boolean().optional(),
		autoRenew: z.boolean().optional(),
	})
	.strict();

const subscriptionChangeSchema = z
	.object({ subscription: subscriptionSchema, previousAttributes: previousAttributesSchema })
	.strict();

const invoiceSchema = z
	.object({
		invoice: z
			.object({
				id: z.uuid(),
				externalInvoiceId: z.string().min(1),
				provider: z.literal("stripe"),
				status: z.string().min(1),
				amountPaidMinor: minor,
				currency: z.string().length(3),
				paidAt: timestamp.nullable(),
				subscriptionId: z.uuid().nullable(),
				externalSubscriptionId: z.string().min(1).nullable(),
			})
			.strict(),
	})
	.strict();

const reversalSchema = z
	.object({
		reversal: projectionReversalPayloadSchema,
		subscription: projectionSubscriptionSchema.optional(),
	})
	.strict();

const usageAlertSchema = z
	.object({
		alert: z
			.object({
				id: z.string().min(1),
				featureKey: z.string().min(1),
				entityId: z.string().min(1).nullable(),
				thresholdType: z.enum(["absolute", "percentage"]),
				thresholdValue: decimal,
				interval: z.enum([...cadenceUnits, "lifetime"]),
				intervalCount: z.number().int().positive().nullable(),
			})
			.strict(),
		window: z.object({ startsAt: timestamp, endsAt: timestamp.nullable() }).strict(),
		/** The threshold in units; a percentage alert's resolved against its usage limit. */
		threshold: decimal,
		currentValue: decimal,
		/** Counts the crossings of this alert in the window, from 1. */
		crossing: z.number().int().positive(),
	})
	.strict();

const autoTopupSchema = z
	.object({
		autoTopup: z
			.object({
				jobId: z.uuid(),
				policyId: z.string().min(1),
				featureKey: z.string().min(1),
				topupKey: z.string().min(1),
				entityId: z.string().min(1).nullable(),
				provider: z.enum(billingProviders),
				amountMinor: minor,
				chargedAmountMinor: minor.nullable(),
				currency: z.string().length(3).nullable(),
				externalInvoiceId: z.string().min(1).nullable(),
				externalPaymentId: z.string().min(1).nullable(),
				error: z.string().nullable(),
			})
			.strict(),
	})
	.strict();

/**
 * The event types an endpoint can subscribe to, each with the schema of its `data`. A billing fact
 * records them in its own transaction; `contracts/v1/domain-events.schema.json` is rendered from
 * these schemas.
 */
export const domainEventDataSchemas = {
	"subscription.activated": subscriptionChangeSchema,
	"subscription.updated": subscriptionChangeSchema,
	"subscription.ended": subscriptionChangeSchema,
	"invoice.paid": invoiceSchema,
	"invoice.payment_failed": invoiceSchema,
	"refund.recorded": reversalSchema,
	"dispute.recorded": reversalSchema,
	"trial.ending": z.object({ trial: projectionTrialPayloadSchema }).strict(),
	"trial.ended": z.object({ trial: projectionTrialPayloadSchema }).strict(),
	"plan_grant.ending": z.object({ planGrant: projectionPlanGrantPayloadSchema }).strict(),
	"plan_grant.ended": z.object({ planGrant: projectionPlanGrantPayloadSchema }).strict(),
	"usage_alert.triggered": usageAlertSchema,
	"auto_topup.succeeded": autoTopupSchema,
	"auto_topup.failed": autoTopupSchema,
	"auto_topup.action_required": autoTopupSchema,
} as const satisfies Record<string, z.ZodType<Record<string, unknown>>>;

export type DomainEventType = keyof typeof domainEventDataSchemas;
export type DomainEventData<T extends DomainEventType> = z.input<
	(typeof domainEventDataSchemas)[T]
>;
export type SubscriptionEventData = z.input<typeof subscriptionChangeSchema>;
export type AutoTopupEventData = z.input<typeof autoTopupSchema>["autoTopup"];

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
