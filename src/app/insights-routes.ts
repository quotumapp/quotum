import type { Context, Hono } from "hono";
import { z } from "zod";
import { BillingError } from "../billing/errors";
import { decodeUsageCursor, encodeUsageCursor } from "../billing/insights";
import type { ProjectInstanceContext } from "../projects/context";
import type { BillingContext, BillingHonoEnv, BillingInsightsServiceLike } from "./types";

const accountParamsSchema = z.object({ billingAccountId: z.string().trim().min(1) });
const usageEventsQuerySchema = z
	.object({
		featureKey: z.string().trim().min(1).optional(),
		entityId: z.string().trim().min(1).optional(),
		operation: z.enum(["consume", "confirm", "correction"]).optional(),
		from: z.iso.datetime({ offset: true }).optional(),
		to: z.iso.datetime({ offset: true }).optional(),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		cursor: z.string().trim().min(1).optional(),
	})
	.strict();
const usageSeriesQuerySchema = z
	.object({
		featureKey: z.string().trim().min(1).optional(),
		from: z.iso.datetime({ offset: true }).optional(),
		to: z.iso.datetime({ offset: true }).optional(),
		interval: z.enum(["hour", "day"]).default("day"),
	})
	.strict();

export function registerInsightsRoutes(input: {
	app: Hono<BillingHonoEnv>;
	service: BillingInsightsServiceLike;
}): void {
	const { app, service } = input;
	app.get("/v1/billing-accounts/:billingAccountId/billing-summary", async (c) => {
		const billingAccountId = accountId(c);
		const summary = await service.getCustomerBillingSummary(privateProject(c), billingAccountId);
		return c.json({ success: true, data: summary });
	});

	app.get("/v1/billing-accounts/:billingAccountId/usage/events", async (c) => {
		const billingAccountId = accountId(c);
		const parsed = usageEventsQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw invalidInsightsRequest("Invalid usage events query");
		const range = dateRange(parsed.data.from, parsed.data.to, 90);
		const cursor = parsed.data.cursor === undefined ? null : decodeUsageCursor(parsed.data.cursor);
		if (parsed.data.cursor !== undefined && cursor === null) {
			throw invalidInsightsRequest("Invalid usage cursor");
		}
		const page = await service.listUsageEvents(privateProject(c), {
			billingAccountId,
			featureKey: parsed.data.featureKey,
			entityId: parsed.data.entityId,
			operation: parsed.data.operation,
			from: range.from,
			to: range.to,
			limit: parsed.data.limit,
			cursor,
		});
		return c.json({
			success: true,
			data: page.items,
			pagination: {
				nextCursor: page.nextCursor === null ? null : encodeUsageCursor(page.nextCursor),
			},
		});
	});

	app.get("/v1/billing-accounts/:billingAccountId/usage/series", async (c) => {
		const billingAccountId = accountId(c);
		const parsed = usageSeriesQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw invalidInsightsRequest("Invalid usage series query");
		const range = dateRange(parsed.data.from, parsed.data.to, 90);
		const points = await service.getUsageSeries(privateProject(c), {
			billingAccountId,
			featureKey: parsed.data.featureKey,
			from: range.from,
			to: range.to,
			interval: parsed.data.interval,
		});
		return c.json({
			success: true,
			data: points,
			meta: {
				from: range.from.toISOString(),
				to: range.to.toISOString(),
				interval: parsed.data.interval,
			},
		});
	});
}

function dateRange(fromValue: string | undefined, toValue: string | undefined, maxDays: number) {
	const to = toValue === undefined ? new Date() : new Date(toValue);
	const from =
		fromValue === undefined ? new Date(to.getTime() - 30 * 24 * 60 * 60_000) : new Date(fromValue);
	if (from >= to || to.getTime() - from.getTime() > maxDays * 24 * 60 * 60_000) {
		throw invalidInsightsRequest(`Usage range must be positive and no longer than ${maxDays} days`);
	}
	return { from, to };
}

function accountId(c: Context): string {
	const parsed = accountParamsSchema.safeParse(c.req.param());
	if (!parsed.success) throw invalidInsightsRequest("Invalid billing account route parameters");
	return parsed.data.billingAccountId;
}

function privateProject(c: BillingContext): ProjectInstanceContext {
	const project = c.get("project");
	if (project === undefined) {
		throw new BillingError("Billing project context is required", "BILLING_PROJECT_REQUIRED", 401);
	}
	return project;
}

function invalidInsightsRequest(message: string): BillingError {
	return new BillingError(message, "INVALID_REQUEST", 400);
}
