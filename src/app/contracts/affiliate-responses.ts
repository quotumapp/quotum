import { z } from "zod";
import { billingProviderValues } from "./provider-enum";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1AffiliatesByAffiliateKeySummaryResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		affiliateKey: z.string(),
		customers: z.number(),
		revenue: z.array(
			z.object({
				provider: z.enum(billingProviderValues()),
				currency: z.union([z.null(), z.string()]),
				payments: z.number(),
				amountMinor: z.union([z.null(), z.number()]),
				estimated: z.boolean(),
			}),
		),
	}),
});

export const getV1AffiliatesByAffiliateKeyCustomersResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(z.object({ billingAccountId: z.string(), affiliateKeySetAt: z.string() })),
	pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
});
