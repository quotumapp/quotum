import { z } from "zod";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
const operatorGrantSchema = z.object({
	id: z.string(),
	billingAccountId: z.string(),
	featureKey: z.string(),
	entityId: z.union([z.null(), z.string()]),
	allocationId: z.string(),
	quantity: z.string(),
	expiresAt: z.union([z.null(), z.string()]),
	status: z.enum(["active", "expired", "revoked"]),
	consumedQuantity: z.string(),
	heldQuantity: z.string(),
	reversedQuantity: z.string(),
	availableQuantity: z.string(),
	actor: z.string(),
	reason: z.string(),
	createdAt: z.string(),
	revocation: z.union([
		z.null(),
		z.object({
			actor: z.string(),
			reason: z.string(),
			revokedAt: z.string(),
			revokedQuantity: z.string(),
		}),
	]),
});

const operatorGrantMutationSchema = z.object({
	success: z.literal(true),
	data: z.object({ duplicate: z.boolean(), grant: operatorGrantSchema }),
});

const administrativeDebitSchema = z.object({
	id: z.string(),
	billingAccountId: z.string(),
	actor: z.string(),
	reason: z.string(),
	createdAt: z.string(),
	allocations: z.array(
		z.object({
			allocationId: z.string(),
			featureKey: z.string(),
			entityId: z.union([z.null(), z.string()]),
			sourceKind: z.string(),
			quantity: z.string(),
		}),
	),
});

const administrativeDebitMutationSchema = z.object({
	success: z.literal(true),
	data: z.object({ duplicate: z.boolean(), debit: administrativeDebitSchema }),
});

const pagination = z.object({ nextCursor: z.union([z.null(), z.string()]) });

export const postV1AdminOperatorGrantsByBillingAccountIdResponse201Schema =
	operatorGrantMutationSchema;
export const postV1AdminOperatorGrantsByBillingAccountIdResponse200Schema =
	operatorGrantMutationSchema;

export const getV1AdminOperatorGrantsByBillingAccountIdResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(operatorGrantSchema),
	pagination,
});

export const getV1AdminOperatorGrantsByBillingAccountIdByGrantIdResponse200Schema = z.object({
	success: z.literal(true),
	data: operatorGrantSchema,
});

export const postV1AdminOperatorGrantsByBillingAccountIdByGrantIdRevokeResponse200Schema =
	operatorGrantMutationSchema;

export const postV1AdminAdministrativeDebitsByBillingAccountIdResponse201Schema =
	administrativeDebitMutationSchema;
export const postV1AdminAdministrativeDebitsByBillingAccountIdResponse200Schema =
	administrativeDebitMutationSchema;

export const getV1AdminAdministrativeDebitsByBillingAccountIdResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(administrativeDebitSchema),
	pagination,
});
