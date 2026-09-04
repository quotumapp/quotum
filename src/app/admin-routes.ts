import type { Context, Hono, MiddlewareHandler } from "hono";
import {
	parseBillingAccountIdParam,
	parseCatalogProductListQuery,
	parseCatalogStoreProductListQuery,
	parseCustomerIdParam,
	parseCustomerProjectionJobListQuery,
	parseCustomerPurchaseListQuery,
	parseCustomerSearchQuery,
	parseCustomerStoreEventListQuery,
	parseCustomerSubscriptionListQuery,
	parseEventIdParam,
	parseProjectionJobListQuery,
	parsePurchaseListQuery,
	parseStatsSummaryQuery,
	parseStoreEventDetailQuery,
	parseStoreEventListQuery,
	parseSubscriptionListQuery,
} from "../admin/query";
import type { AdminBillingReader, AdminListResult } from "../admin/types";
import { BillingError } from "../billing/errors";
import { constantTimeEquals } from "../http/api-key";
import { type RateLimitResult, rateLimitMiddleware } from "../http/rate-limit";
import { type BillingLogger, safelyLogInfo } from "../observability/logger";
import type { BillingMetrics } from "../observability/metrics";
import type { BillingAdminOperations } from "../operations/admin";
import type { ProjectInstanceContext } from "../projects/context";
import type { BillingContext, BillingHonoEnv } from "./types";

type RateLimiter = { check(key: string): RateLimitResult };

export interface AdminRoutesDependencies {
	app: Hono<BillingHonoEnv>;
	adminLimiter: RateLimiter;
	rateLimitKey: (c: Context) => string;
	operatorApiKey: string | null;
	billingMetrics: BillingMetrics;
	billingLogger: BillingLogger;
	getAdminBillingReader: () => AdminBillingReader | null;
	adminOperations: BillingAdminOperations | null;
}

export function registerAdminRoutes({
	app,
	adminLimiter,
	rateLimitKey,
	operatorApiKey,
	billingMetrics,
	billingLogger,
	getAdminBillingReader,
	adminOperations,
}: AdminRoutesDependencies): void {
	app.use("/v1/admin/*", rateLimitMiddleware({ limiter: adminLimiter, key: rateLimitKey }));
	app.use("/v1/admin/store-events/:eventId/replay", requireOperatorApiKey(operatorApiKey));
	app.use("/v1/admin/reconciliation/subscriptions/run", requireOperatorApiKey(operatorApiKey));
	app.use("/v1/admin/projection-jobs/:jobId/retry", requireOperatorApiKey(operatorApiKey));
	app.use("/v1/admin/metrics", requireOperatorApiKey(operatorApiKey));

	app.get("/v1/admin/metrics", (c) => {
		c.header("content-type", "text/plain; version=0.0.4");
		return c.body(billingMetrics.renderPrometheus());
	});

	app.get("/v1/admin/customers/search", async (c) => {
		const input = parseCustomerSearchQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).searchCustomers(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/customers/by-billing-account/:billingAccountId", async (c) => {
		const billingAccountId = parseBillingAccountIdParam(c.req.param("billingAccountId"));
		const result = await requireAdminBillingReader(
			getAdminBillingReader(),
		).getCustomerByBillingAccountId(privateProject(c), billingAccountId);
		return c.json(adminDetailResponse(result));
	});

	app.get("/v1/admin/customers/:customerId/purchases", async (c) => {
		const input = parseCustomerPurchaseListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listPurchases(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/customers/:customerId/subscriptions", async (c) => {
		const input = parseCustomerSubscriptionListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listSubscriptions(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/customers/:customerId/store-events", async (c) => {
		const input = parseCustomerStoreEventListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listStoreEvents(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/customers/:customerId/projection-jobs", async (c) => {
		const input = parseCustomerProjectionJobListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listProjectionJobs(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/customers/:customerId", async (c) => {
		const customerId = parseCustomerIdParam(c.req.param("customerId"));
		const result = await requireAdminBillingReader(getAdminBillingReader()).getCustomerById(
			privateProject(c),
			customerId,
		);
		return c.json(adminDetailResponse(result));
	});

	app.get("/v1/admin/purchases", async (c) => {
		const input = parsePurchaseListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listPurchases(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/subscriptions", async (c) => {
		const input = parseSubscriptionListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listSubscriptions(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/store-events", async (c) => {
		const input = parseStoreEventListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listStoreEvents(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/store-events/:eventId", async (c) => {
		const project = privateProject(c);
		const eventId = parseEventIdParam(c.req.param("eventId"));
		const detailQuery = parseStoreEventDetailQuery(queryParams(c));
		if (detailQuery.includeRawPayload) {
			safelyLogInfo(billingLogger, "Billing admin raw store event payload read", {
				projectKey: project.projectInstanceKey,
				eventId,
			});
		}
		const result = await requireAdminBillingReader(getAdminBillingReader()).getStoreEvent(project, {
			eventId,
			includeRawPayload: detailQuery.includeRawPayload,
		});
		return c.json(adminDetailResponse(result));
	});

	app.get("/v1/admin/projection-jobs", async (c) => {
		const input = parseProjectionJobListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listProjectionJobs(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/catalog/products", async (c) => {
		const input = parseCatalogProductListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listCatalogProducts(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	app.get("/v1/admin/stats/summary", async (c) => {
		const input = parseStatsSummaryQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).getStatsSummary(
			privateProject(c),
			input,
		);
		return c.json(adminDetailResponse(result));
	});

	app.get("/v1/admin/catalog/store-products", async (c) => {
		const input = parseCatalogStoreProductListQuery(queryParams(c));
		const result = await requireAdminBillingReader(
			getAdminBillingReader(),
		).listCatalogStoreProducts(privateProject(c), input);
		return c.json(adminListResponse(result));
	});

	app.post("/v1/admin/store-events/:eventId/replay", async (c) => {
		const project = privateProject(c);
		const eventId = c.req.param("eventId");
		safelyLogInfo(billingLogger, "Billing admin store event replay requested", {
			projectKey: project.projectInstanceKey,
			eventId,
		});
		const result = await requireBillingAdminOperations(adminOperations).replayStoreEvent(
			project,
			eventId,
		);
		return c.json({ success: true, data: result });
	});

	app.post("/v1/admin/reconciliation/subscriptions/run", async (c) => {
		const project = privateProject(c);
		safelyLogInfo(billingLogger, "Billing admin subscription reconciliation requested", {
			projectKey: project.projectInstanceKey,
		});
		const result =
			await requireBillingAdminOperations(adminOperations).runSubscriptionReconciliation();
		return c.json({ success: true, data: result });
	});

	app.post("/v1/admin/projection-jobs/:jobId/retry", async (c) => {
		const project = privateProject(c);
		const jobId = c.req.param("jobId");
		safelyLogInfo(billingLogger, "Billing admin projection retry requested", {
			projectKey: project.projectInstanceKey,
			jobId,
		});
		const result = await requireBillingAdminOperations(adminOperations).retryProjectionSyncJob(
			project,
			jobId,
		);
		return c.json({ success: true, data: result });
	});
}

export function requireOperatorApiKey(operatorApiKey: string | null): MiddlewareHandler {
	return async (c, next) => {
		if (operatorApiKey === null) {
			return c.json(
				{
					success: false,
					error: {
						code: "BILLING_OPERATOR_NOT_CONFIGURED",
						message: "Billing operator key is not configured",
					},
				},
				501,
			);
		}

		if (!constantTimeEquals(c.req.header("x-billing-operator-key") ?? "", operatorApiKey)) {
			return c.json(
				{
					success: false,
					error: {
						code: "UNAUTHORIZED",
						message: "Invalid billing operator key",
					},
				},
				401,
			);
		}

		await next();
	};
}

function privateProject(c: BillingContext): ProjectInstanceContext {
	const project = c.get("project");
	if (project === undefined) {
		throw new BillingError("Billing project context is required", "BILLING_PROJECT_REQUIRED", 401);
	}
	return project;
}

function queryParams(c: { req: { url: string } }): URLSearchParams {
	return new URL(c.req.url).searchParams;
}

function adminDetailResponse<T>(data: T): { success: true; data: T } {
	return { success: true, data };
}

function adminListResponse<T>(result: AdminListResult<T>): {
	success: true;
	data: T[];
	pagination: { nextCursor: string | null };
} {
	return {
		success: true,
		data: result.items,
		pagination: { nextCursor: result.nextCursor },
	};
}

function requireAdminBillingReader(reader: AdminBillingReader | null): AdminBillingReader {
	if (reader === null) {
		throw new BillingError(
			"Billing admin reader is not configured",
			"BILLING_ADMIN_NOT_CONFIGURED",
			501,
		);
	}

	return reader;
}

function requireBillingAdminOperations(
	adminOperations: BillingAdminOperations | null,
): BillingAdminOperations {
	if (adminOperations === null) {
		throw new BillingError(
			"Billing admin operations are not configured",
			"BILLING_ADMIN_NOT_CONFIGURED",
			501,
		);
	}

	return adminOperations;
}
