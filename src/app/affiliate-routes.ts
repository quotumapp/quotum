import { z } from "zod";
import type { AffiliateServiceLike } from "../billing/affiliates";
import { operationDetail } from "../shared/http";
import { decimalDigitsQuery } from "../shared/input-bounds";
import * as responses from "./contracts/affiliate-responses";
import { privateProject } from "./request-context";
import type { BillingElysia } from "./types";

export interface AffiliateRoutesDependencies {
	app: BillingElysia;
	service: AffiliateServiceLike;
}

/** The caller's opaque name for a partner; it also has to fit one URL path segment. */
export const affiliateKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9._-]+$/u);

const affiliateParams = z.object({ affiliateKey: affiliateKeySchema }).strict();

const listCustomersQuerySchema = z
	.object({
		limit: decimalDigitsQuery(z.coerce.number().int().positive().max(100).default(25)),
		cursor: z.uuid().optional(),
	})
	.strict();

export function registerAffiliateRoutes({ app, service }: AffiliateRoutesDependencies): void {
	app.get(
		"/v1/affiliates/:affiliateKey/summary",
		async ({ params, project }) => ({
			success: true,
			data: await service.getAffiliateSummary(privateProject(project), params.affiliateKey),
		}),
		{
			params: affiliateParams,
			detail: operationDetail({
				operationId: "getV1AffiliatesByAffiliateKeySummary",
				tags: ["affiliates"],
				path: "/v1/affiliates/:affiliateKey/summary",
				description:
					"Customers and revenue attributed to one affiliate key. App Store and Google Play amounts are estimates: the product's catalog price once per payment.",
				credentialAccess: "read_only",
				responses: { 200: responses.getV1AffiliatesByAffiliateKeySummaryResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/affiliates/:affiliateKey/customers",
		async ({ params, query, project }) => {
			const result = await service.listAffiliateCustomers(
				privateProject(project),
				params.affiliateKey,
				{ limit: query.limit, cursor: query.cursor ?? null },
			);
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: affiliateParams,
			query: listCustomersQuerySchema,
			detail: operationDetail({
				operationId: "getV1AffiliatesByAffiliateKeyCustomers",
				tags: ["affiliates"],
				path: "/v1/affiliates/:affiliateKey/customers",
				credentialAccess: "read_only",
				responses: { 200: responses.getV1AffiliatesByAffiliateKeyCustomersResponse200Schema },
			}),
		},
	);
}
