import { z } from "zod";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
const basisSchema = z.enum([
	"data_subject_request",
	"merchant_offboarding",
	"legal_order",
	"other",
]);
const acknowledgementSchema = z.enum(["forfeit_paid_balances", "forfeit_lifetime_purchases"]);

const customerErasureSchema = z.object({
	id: z.string(),
	state: z.enum(["requested", "running", "verifying", "completed", "failed"]),
	basis: basisSchema,
	reference: z.union([z.null(), z.string()]),
	actor: z.string(),
	acknowledged: z.array(acknowledgementSchema),
	step: z.union([z.null(), z.string()]),
	counts: z.record(z.string(), z.number()),
	lastError: z.union([z.null(), z.string()]),
	requestedAt: z.string(),
	completedAt: z.union([z.null(), z.string()]),
	tombstoneExpiresAt: z.string(),
});

const customerErasureMutationSchema = z.object({
	success: z.literal(true),
	data: z.object({ duplicate: z.boolean(), erasure: customerErasureSchema }),
});

export const postV1AdminCustomerErasuresResponse201Schema = customerErasureMutationSchema;
export const postV1AdminCustomerErasuresResponse200Schema = customerErasureMutationSchema;

export const getV1AdminCustomerErasuresByErasureIdResponse200Schema = z.object({
	success: z.literal(true),
	data: customerErasureSchema,
});

export const postV1AdminCustomerErasuresPreviewResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		blockers: z.array(z.object({ kind: z.string(), count: z.number() })),
		forfeits: z.object({ paidBalanceFeatures: z.number(), lifetimePurchases: z.number() }),
		requiredAcknowledgements: z.array(acknowledgementSchema),
		rows: z.record(z.string(), z.number()),
	}),
});
