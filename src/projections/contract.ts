import { z } from "zod";
import { projectionPayloadFields, refineProjectionPayload } from "../billing/types";
import type { BillingProjectionInput } from "./delivery";

const fields = projectionPayloadFields.shape;

/**
 * The body of one `billing_state_v1` delivery: the stored job payload inside the envelope the
 * projection worker adds. `contracts/v1/projection-delivery.schema.json` is rendered from it, so a
 * field the worker sends belongs here first.
 */
export const projectionDeliverySchema = projectionPayloadFields
	.extend({
		schemaVersion: z.literal(1).describe("Version of this body's format."),
		projectKey: z.string().min(1).describe("Key of the project instance the delivery is for."),
		jobId: z
			.uuid()
			.describe(
				"The delivery job. A retry repeats it; do not use it as the identity of a fact or a row.",
			),
		idempotencyKey: z
			.string()
			.min(1)
			.describe(
				"Stable across retries of one delivery and unique within the project. Deduplicate on projectKey and this key.",
			),
		billingAccountId: fields.billingAccountId.describe("Your identifier for the billing account."),
		generatedAt: fields.generatedAt.describe(
			"When the snapshot was computed. Equals entitlements.generatedAt.",
		),
		entitlements: fields.entitlements.describe(
			"Every entitlement of the account. Each entry's metadata names its current source.",
		),
		balances: fields.balances.describe(
			"Exact decimal strings for each metered feature. A read model: authorize with the metering API.",
		),
		reason: fields.reason.describe("What caused the delivery."),
		purchase: fields.purchase.describe(
			"A purchase to record once by transactionId. Never sent with reversal or trial.",
		),
		reversal: fields.reversal.describe(
			"A refund or dispute to record once by transactionId. With a subscription fact it reports a returned subscription payment and reverses nothing. Never sent with purchase or trial.",
		),
		trial: fields.trial.describe(
			"A trial that is ending or has ended. Never sent with purchase or reversal.",
		),
		subscription: fields.subscription.describe(
			"State of the subscription the delivery is about. Not an inventory of the account's subscriptions.",
		),
		sequence: fields.sequence.describe(
			"Per-account order of snapshots. Skip the snapshot of a lower sequence than one already applied, but still record its facts. Absent means unordered: apply it as current.",
		),
	})
	.superRefine(refineProjectionPayload);

/** Fails to compile when the worker's delivery stops fitting the published schema. */
export const deliveryFitsContract = (
	delivery: BillingProjectionInput,
): z.input<typeof projectionDeliverySchema> => delivery;

type JsonSchema = Record<string, unknown>;

/**
 * The rules `refineProjectionPayload` and the trial schema enforce in code. JSON Schema can state
 * these; it cannot state that two fields are equal, which the descriptions say instead.
 */
const factRules: JsonSchema[] = [
	{ not: { required: ["purchase", "reversal"] } },
	{ not: { required: ["trial", "purchase"] } },
	{ not: { required: ["trial", "reversal"] } },
];
const trialRule: JsonSchema = {
	if: { properties: { source: { const: "subscription" } } },
	// biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword.
	then: {
		required: ["provider", "channel", "externalSubscriptionId", "productKey"],
		not: { required: ["planGrantId"] },
	},
	else: {
		required: ["planGrantId", "planKey"],
		not: {
			anyOf: [
				{ required: ["provider"] },
				{ required: ["channel"] },
				{ required: ["externalSubscriptionId"] },
			],
		},
	},
};

/**
 * JSON Schema (draft 2020-12) for the delivery body. Objects stay open: a later release may add a
 * field, and a receiver that validates against this schema must keep accepting the delivery.
 */
export function projectionDeliveryJsonSchema(): JsonSchema {
	const rendered = z.toJSONSchema(projectionDeliverySchema, {
		target: "draft-2020-12",
		io: "input",
		unrepresentable: "any",
		override: ({ jsonSchema }) => {
			delete jsonSchema.additionalProperties;
			// `format` says it; the pattern Zod adds repeats it as a 300-character expression.
			if (jsonSchema.format === "date-time") delete jsonSchema.pattern;
		},
	}) as JsonSchema & { properties: Record<string, JsonSchema> };
	return {
		...rendered,
		title: "Quotum billing_state_v1 projection delivery",
		description:
			"Body of the signed POST to <projectionUrl>/internal/billing/projections. Ignore fields this schema does not name.",
		properties: {
			...rendered.properties,
			trial: { ...rendered.properties.trial, ...trialRule },
		},
		allOf: factRules,
	};
}
