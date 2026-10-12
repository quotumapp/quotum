import { z } from "zod";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
const providerCustomerUnlinkSchema = z.object({
	id: z.string(),
	billingAccountId: z.string(),
	provider: z.literal("stripe"),
	externalCustomerId: z.string(),
	providerAccountId: z.union([z.null(), z.string()]),
	linkedAt: z.string(),
	actor: z.string(),
	reason: z.string(),
	createdAt: z.string(),
});

const providerCustomerUnlinkMutationSchema = z.object({
	success: z.literal(true),
	data: z.object({ duplicate: z.boolean(), unlink: providerCustomerUnlinkSchema }),
});

export const postV1AdminProviderCustomerUnlinksByBillingAccountIdResponse201Schema =
	providerCustomerUnlinkMutationSchema;
export const postV1AdminProviderCustomerUnlinksByBillingAccountIdResponse200Schema =
	providerCustomerUnlinkMutationSchema;

export const getV1AdminProviderCustomerUnlinksByBillingAccountIdResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(providerCustomerUnlinkSchema),
	pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
});
