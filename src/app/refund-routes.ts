import { z } from "zod";
import {
	publicRefundRequest,
	type RefundRequestStore,
	refundRequestStatuses,
} from "../billing/refunds";
import { operationDetail } from "../shared/http";
import { decimalDigitsQuery } from "../shared/input-bounds";
import { privateProject } from "./request-context";
import type { BillingElysia } from "./types";

const refundRequestSchema = z.object({
	id: z.uuid(),
	billingAccountId: z.string(),
	provider: z.literal("stripe"),
	targetKind: z.enum(["subscription_payment", "purchase"]),
	externalInvoiceId: z.string().nullable(),
	purchaseId: z.uuid().nullable(),
	providerPaymentId: z.string(),
	amountMinor: z.number().int(),
	currency: z.string(),
	mode: z.enum(["full", "prorated"]),
	basis: z.enum(["full", "remaining_time", "unconsumed_credit"]),
	cancelImmediately: z.boolean(),
	reason: z.string(),
	status: z.enum(refundRequestStatuses),
	providerRefundId: z.string().nullable(),
	failureCode: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	completedAt: z.iso.datetime().nullable(),
});

export const listRefundsParamsSchema = z.object({
	billingAccountId: z.string().trim().min(1).max(200),
});
export const listRefundsQuerySchema = z
	.object({ limit: decimalDigitsQuery(z.coerce.number().int().min(1).max(100)).default(25) })
	.strict();
export const listRefundsResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(refundRequestSchema),
});

/**
 * Reads the refunds Quotum asked a provider for. A refund's status can move after the execution
 * answered, from `pending` to `succeeded` or `failed`, so this is where a caller sees the outcome.
 */
export function registerRefundRoutes(input: {
	app: BillingElysia;
	store: RefundRequestStore;
}): void {
	input.app.get(
		"/v1/billing-accounts/:billingAccountId/refunds",
		async ({ params, query, project }) => ({
			success: true,
			data: (
				await input.store.listRefundRequests(privateProject(project), {
					billingAccountId: params.billingAccountId,
					limit: query.limit,
				})
			).map(publicRefundRequest),
		}),
		{
			params: listRefundsParamsSchema,
			query: listRefundsQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdRefunds",
				credentialAccess: "read_only",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/refunds",
				description: "Lists the refunds requested for the billing account, newest first.",
				responses: { 200: listRefundsResponseSchema },
			}),
		},
	);
}
