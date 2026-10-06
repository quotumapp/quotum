import { z } from "zod";
import type { UsageApiServiceLike } from "../billing/usage-api";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { decimalDigitsQuery } from "../shared/input-bounds";
import {
	accountParamsSchema,
	accountSchema,
	deductionPageSchema,
	envelope,
	publicIdSchema,
	receiptSchema,
} from "./contracts/usage-api";
import { privateProject, rejectCallerProjectSelectorBody } from "./request-context";
import type { BillingElysia } from "./types";

export function registerUsageReceiptRoutes(app: BillingElysia, service: UsageApiServiceLike): void {
	app.put(
		"/v1/billing-accounts/:billingAccountId",
		async ({ params, project }) => ({
			success: true,
			data: await service.createAccount(privateProject(project), params.billingAccountId),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			body: z.object({}).strict().optional(),
			params: accountParamsSchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "putV1BillingAccountsByBillingAccountId",
				tags: ["accounts"],
				path: "/v1/billing-accounts/:billingAccountId",
				responses: { 200: envelope(accountSchema) },
			}),
		},
	);
	app.get(
		"/v1/billing-accounts/:billingAccountId",
		async ({ params, project }) => ({
			success: true,
			data: await service.getAccount(privateProject(project), params.billingAccountId),
		}),
		{
			params: accountParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountId",
				credentialAccess: "read_only",
				tags: ["accounts"],
				path: "/v1/billing-accounts/:billingAccountId",
				responses: { 200: envelope(accountSchema) },
			}),
		},
	);
	app.get(
		"/v1/billing-accounts/:billingAccountId/usage/receipts/:receiptId",
		async ({ params, query, project }) => ({
			success: true,
			data: await service.getReceipt(privateProject(project), { ...params, ...query }),
		}),
		{
			params: accountParamsSchema.extend({ receiptId: z.string().min(1).max(503) }),
			query: z.object({ entityId: publicIdSchema.optional() }).strict(),
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdUsageReceiptsByReceiptId",
				credentialAccess: "read_only",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/receipts/:receiptId",
				responses: { 200: envelope(receiptSchema) },
			}),
		},
	);
	app.get(
		"/v1/billing-accounts/:billingAccountId/usage/receipts/:receiptId/deductions",
		async ({ params, query, project }) => ({
			success: true,
			data: await service.listReceiptDeductions(privateProject(project), { ...params, ...query }),
		}),
		{
			params: accountParamsSchema.extend({ receiptId: z.string().min(1).max(503) }),
			query: z
				.object({
					entityId: publicIdSchema.optional(),
					cursor: z.string().max(1024).optional(),
					limit: decimalDigitsQuery(z.coerce.number().int().min(1).max(100).optional()),
				})
				.strict(),
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdUsageReceiptsByReceiptIdDeductions",
				credentialAccess: "read_only",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/receipts/:receiptId/deductions",
				responses: { 200: envelope(deductionPageSchema) },
			}),
		},
	);
}
