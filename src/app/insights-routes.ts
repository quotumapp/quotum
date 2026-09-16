import { z } from "zod";
import { BillingError } from "../billing/errors";
import { decodeUsageCursor, encodeUsageCursor } from "../billing/insights";
import { operationDetail } from "../shared/http";
import * as responses from "./contracts/insights-responses";
import { privateProject } from "./request-context";
import type { BillingElysia, BillingInsightsServiceLike } from "./types";

const accountParamsSchema = z.object({ billingAccountId: z.string().trim().min(1) });
const usageEventsFilterFields = {
	featureKey: z.string().trim().min(1).optional(),
	entityId: z.string().trim().min(1).optional(),
	operation: z.enum(["consume", "confirm", "correction"]).optional(),
	from: z.iso.datetime({ offset: true }).optional(),
	to: z.iso.datetime({ offset: true }).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
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
		from: z.iso.datetime({ offset: true }).optional(),
		to: z.iso.datetime({ offset: true }).optional(),
		interval: z.enum(["hour", "day"]).default("day"),
	})
	.strict();

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
				tags: ["insights"],
				path: "/v1/billing-accounts/:billingAccountId/usage/series",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdUsageSeriesResponse200Schema,
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

function invalidInsightsRequest(message: string): BillingError {
	return new BillingError(message, "INVALID_REQUEST", 400);
}
