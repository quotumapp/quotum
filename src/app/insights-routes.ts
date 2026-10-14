import { z } from "zod";
import { BillingError } from "../billing/errors";
import {
	decodeInvoiceCursor,
	decodeUsageCursor,
	encodeInvoiceCursor,
	encodeUsageCursor,
	invoiceStatusValues,
	withoutInvoiceLinks,
} from "../billing/insights";
import { operationDetail } from "../shared/http";
import { decimalDigitsQuery, storableDateTimeSchema } from "../shared/input-bounds";
import * as responses from "./contracts/insights-responses";
import { privateProject } from "./request-context";
import type { BillingElysia, BillingInsightsServiceLike } from "./types";

const accountParamsSchema = z.object({ billingAccountId: z.string().trim().min(1) });
const usageEventsFilterFields = {
	featureKey: z.string().trim().min(1).optional(),
	entityId: z.string().trim().min(1).optional(),
	operation: z.enum(["consume", "confirm", "correction"]).optional(),
	from: storableDateTimeSchema().optional(),
	to: storableDateTimeSchema().optional(),
	limit: decimalDigitsQuery(z.coerce.number().int().min(1).max(200).default(50)),
	cursor: z.string().trim().min(1).optional(),
};
export const usageEventsQuerySchema = z.object(usageEventsFilterFields).strict();
export const projectUsageEventsQuerySchema = z
	.object({
		billingAccountId: z.string().trim().min(1).optional(),
		...usageEventsFilterFields,
	})
	.strict();
export const usageSeriesQuerySchema = z
	.object({
		featureKey: z.string().trim().min(1).optional(),
		from: storableDateTimeSchema().optional(),
		to: storableDateTimeSchema().optional(),
		interval: z.enum(["hour", "day"]).default("day"),
	})
	.strict();

export const invoicesQuerySchema = z
	.object({
		status: z.enum(invoiceStatusValues).optional(),
		limit: decimalDigitsQuery(z.coerce.number().int().min(1).max(100).default(25)),
		cursor: z.string().trim().min(1).optional(),
	})
	.strict();
export const invoiceIdSchema = z.uuid();
const invoiceParamsSchema = accountParamsSchema.extend({ invoiceId: invoiceIdSchema });

export function registerInsightsRoutes(input: {
	app: BillingElysia;
	service: BillingInsightsServiceLike;
}): void {
	const { app, service } = input;

	app.get(
		"/v1/billing-accounts/:billingAccountId/billing-summary",
		async ({ params, project }) => {
			const summary = await service.getCustomerBillingSummary(
				privateProject(project),
				params.billingAccountId,
			);
			return { success: true, data: summary };
		},
		{
			params: accountParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdBillingSummary",
				credentialAccess: "read_only",
				tags: ["insights"],
				path: "/v1/billing-accounts/:billingAccountId/billing-summary",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdBillingSummaryResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/usage/events",
		async ({ params, query, project }) => {
			const billingAccountId = params.billingAccountId;
			const { from, to, cursor } = parseUsageEventsRangeAndCursor(query);
			const page = await service.listUsageEvents(privateProject(project), {
				billingAccountId,
				featureKey: query.featureKey,
				entityId: query.entityId,
				operation: query.operation,
				from,
				to,
				limit: query.limit,
				cursor,
			});
			return {
				success: true,
				data: page.items,
				pagination: {
					nextCursor: page.nextCursor === null ? null : encodeUsageCursor(page.nextCursor),
				},
			};
		},
		{
			params: accountParamsSchema,
			query: usageEventsQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdUsageEvents",
				credentialAccess: "read_only",
				tags: ["insights"],
				path: "/v1/billing-accounts/:billingAccountId/usage/events",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdUsageEventsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/usage-events",
		async ({ query, project }) => {
			const { from, to, cursor } = parseUsageEventsRangeAndCursor(query);
			const page = await service.listProjectUsageEvents(privateProject(project), {
				billingAccountId: query.billingAccountId,
				featureKey: query.featureKey,
				entityId: query.entityId,
				operation: query.operation,
				from,
				to,
				limit: query.limit,
				cursor,
			});
			return {
				success: true,
				data: page.items,
				pagination: {
					nextCursor: page.nextCursor === null ? null : encodeUsageCursor(page.nextCursor),
				},
			};
		},
		{
			query: projectUsageEventsQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminUsageEvents",
				credentialAccess: "read_only",
				tags: ["insights"],
				path: "/v1/admin/usage-events",
				responses: {
					200: responses.getV1AdminUsageEventsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/usage/series",
		async ({ params, query, project }) => {
			const billingAccountId = params.billingAccountId;
			const range = dateRange(query.from, query.to, 90);
			const points = await service.getUsageSeries(privateProject(project), {
				billingAccountId,
				featureKey: query.featureKey,
				from: range.from,
				to: range.to,
				interval: query.interval,
			});
			return {
				success: true,
				data: points,
				meta: {
					from: range.from.toISOString(),
					to: range.to.toISOString(),
					interval: query.interval,
				},
			};
		},
		{
			params: accountParamsSchema,
			query: usageSeriesQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdUsageSeries",
				credentialAccess: "read_only",
				tags: ["insights"],
				path: "/v1/billing-accounts/:billingAccountId/usage/series",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdUsageSeriesResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/invoices",
		async ({ params, query, project }) => {
			const page = await service.listInvoices(privateProject(project), {
				billingAccountId: params.billingAccountId,
				status: query.status,
				limit: query.limit,
				cursor: parseInvoiceCursor(query.cursor),
			});
			return {
				success: true,
				data: page.items,
				pagination: {
					nextCursor: page.nextCursor === null ? null : encodeInvoiceCursor(page.nextCursor),
				},
			};
		},
		{
			params: accountParamsSchema,
			query: invoicesQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdInvoices",
				credentialAccess: "read_only",
				tags: ["insights"],
				path: "/v1/billing-accounts/:billingAccountId/invoices",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdInvoicesResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/invoices/:invoiceId",
		async ({ params, project, credentialAccess }) => {
			const invoice = await service.getInvoice(
				privateProject(project),
				params.billingAccountId,
				params.invoiceId,
			);
			// The links let anyone holding them view, and for an open invoice pay it, so a read-only
			// key never gets them, as it never gets a raw provider payload.
			return {
				success: true,
				data: credentialAccess === "full" ? invoice : withoutInvoiceLinks(invoice),
			};
		},
		{
			params: invoiceParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdInvoicesByInvoiceId",
				credentialAccess: "read_only",
				tags: ["insights"],
				path: "/v1/billing-accounts/:billingAccountId/invoices/:invoiceId",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdInvoicesByInvoiceIdResponse200Schema,
				},
			}),
		},
	);
}

export function dateRange(
	fromValue: string | undefined,
	toValue: string | undefined,
	maxDays: number,
) {
	const to = toValue === undefined ? new Date() : new Date(toValue);
	const from =
		fromValue === undefined ? new Date(to.getTime() - 30 * 24 * 60 * 60_000) : new Date(fromValue);
	if (from >= to || to.getTime() - from.getTime() > maxDays * 24 * 60 * 60_000) {
		throw invalidInsightsRequest(`Usage range must be positive and no longer than ${maxDays} days`);
	}
	return { from, to };
}

export function parseUsageEventsRangeAndCursor(query: {
	from?: string;
	to?: string;
	cursor?: string;
}) {
	const range = dateRange(query.from, query.to, 90);
	const cursor = query.cursor === undefined ? null : decodeUsageCursor(query.cursor);
	if (query.cursor !== undefined && cursor === null) {
		throw invalidInsightsRequest("Invalid usage cursor");
	}
	return { from: range.from, to: range.to, cursor };
}

export function parseInvoiceCursor(value: string | undefined) {
	if (value === undefined) return null;
	const cursor = decodeInvoiceCursor(value);
	if (cursor === null) throw invalidInsightsRequest("Invalid invoice cursor");
	return cursor;
}

function invalidInsightsRequest(message: string): BillingError {
	return new BillingError(message, "INVALID_REQUEST", 400);
}
