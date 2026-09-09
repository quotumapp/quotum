import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
	paginationSchema,
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
import { type RateLimitResult, rateLimitMiddleware } from "../http/rate-limit";
import { type BillingLogger, safelyLogInfo } from "../observability/logger";
import type { BillingMetrics } from "../observability/metrics";
import type { BillingAdminOperations } from "../operations/admin";
import { constantTimeEquals } from "../shared/constant-time-equals";
import { defineContract, registerRoute } from "../shared/http-contract";
import * as responses from "./contracts/admin-responses";
import { privateProject } from "./request-context";
import type { BillingHonoEnv } from "./types";

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

	registerRoute(app, adminContracts.getV1AdminMetrics, (c) => {
		c.header("content-type", "text/plain; version=0.0.4");
		return c.body(billingMetrics.renderPrometheus());
	});

	registerRoute(app, adminContracts.getV1AdminCustomersSearch, async (c) => {
		const input = parseCustomerSearchQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).searchCustomers(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(
		app,
		adminContracts.getV1AdminCustomersByBillingAccountByBillingAccountId,
		async (c) => {
			const billingAccountId = parseBillingAccountIdParam(c.req.param("billingAccountId"));
			const result = await requireAdminBillingReader(
				getAdminBillingReader(),
			).getCustomerByBillingAccountId(privateProject(c), billingAccountId);
			return c.json(adminDetailResponse(result));
		},
	);

	registerRoute(app, adminContracts.getV1AdminCustomersByCustomerIdPurchases, async (c) => {
		const input = parseCustomerPurchaseListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listPurchases(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminCustomersByCustomerIdSubscriptions, async (c) => {
		const input = parseCustomerSubscriptionListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listSubscriptions(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminCustomersByCustomerIdStoreEvents, async (c) => {
		const input = parseCustomerStoreEventListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listStoreEvents(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminCustomersByCustomerIdProjectionJobs, async (c) => {
		const input = parseCustomerProjectionJobListQuery(c.req.param("customerId"), queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listProjectionJobs(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminCustomersByCustomerId, async (c) => {
		const customerId = parseCustomerIdParam(c.req.param("customerId"));
		const result = await requireAdminBillingReader(getAdminBillingReader()).getCustomerById(
			privateProject(c),
			customerId,
		);
		return c.json(adminDetailResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminPurchases, async (c) => {
		const input = parsePurchaseListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listPurchases(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminSubscriptions, async (c) => {
		const input = parseSubscriptionListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listSubscriptions(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminStoreEvents, async (c) => {
		const input = parseStoreEventListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listStoreEvents(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminStoreEventsByEventId, async (c) => {
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

	registerRoute(app, adminContracts.getV1AdminProjectionJobs, async (c) => {
		const input = parseProjectionJobListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listProjectionJobs(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminCatalogProducts, async (c) => {
		const input = parseCatalogProductListQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).listCatalogProducts(
			privateProject(c),
			input,
		);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminStatsSummary, async (c) => {
		const input = parseStatsSummaryQuery(queryParams(c));
		const result = await requireAdminBillingReader(getAdminBillingReader()).getStatsSummary(
			privateProject(c),
			input,
		);
		return c.json(adminDetailResponse(result));
	});

	registerRoute(app, adminContracts.getV1AdminCatalogStoreProducts, async (c) => {
		const input = parseCatalogStoreProductListQuery(queryParams(c));
		const result = await requireAdminBillingReader(
			getAdminBillingReader(),
		).listCatalogStoreProducts(privateProject(c), input);
		return c.json(adminListResponse(result));
	});

	registerRoute(app, adminContracts.postV1AdminStoreEventsByEventIdReplay, async (c) => {
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

	registerRoute(app, adminContracts.postV1AdminReconciliationSubscriptionsRun, async (c) => {
		const project = privateProject(c);
		safelyLogInfo(billingLogger, "Billing admin subscription reconciliation requested", {
			projectKey: project.projectInstanceKey,
		});
		const result =
			await requireBillingAdminOperations(adminOperations).runSubscriptionReconciliation();
		return c.json({ success: true, data: result });
	});

	registerRoute(app, adminContracts.postV1AdminProjectionJobsByJobIdRetry, async (c) => {
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

export const adminContracts = {
	getV1AdminMetrics: defineContract("get", "/v1/admin/metrics", {
		operationId: "getV1AdminMetrics",
		tags: ["admin"],
		responses: { 200: z.string() },
		contentType: "text/plain",
	}),
	getV1AdminCustomersSearch: defineContract("get", "/v1/admin/customers/search", {
		operationId: "getV1AdminCustomersSearch",
		tags: ["admin"],
		responses: { "200": responses.getV1AdminCustomersSearchResponse200Schema },
	}),
	getV1AdminCustomersByBillingAccountByBillingAccountId: defineContract(
		"get",
		"/v1/admin/customers/by-billing-account/:billingAccountId",
		{
			operationId: "getV1AdminCustomersByBillingAccountByBillingAccountId",
			tags: ["admin"],
			params: z.object({ billingAccountId: z.string().min(1) }),
			responses: {
				"200": responses.getV1AdminCustomersByBillingAccountByBillingAccountIdResponse200Schema,
			},
		},
	),
	getV1AdminCustomersByCustomerIdPurchases: defineContract(
		"get",
		"/v1/admin/customers/:customerId/purchases",
		{
			operationId: "getV1AdminCustomersByCustomerIdPurchases",
			tags: ["admin"],
			params: z.object({ customerId: z.string().min(1) }),
			responses: { "200": responses.getV1AdminCustomersByCustomerIdPurchasesResponse200Schema },
		},
	),
	getV1AdminCustomersByCustomerIdSubscriptions: defineContract(
		"get",
		"/v1/admin/customers/:customerId/subscriptions",
		{
			operationId: "getV1AdminCustomersByCustomerIdSubscriptions",
			tags: ["admin"],
			params: z.object({ customerId: z.string().min(1) }),
			responses: { "200": responses.getV1AdminCustomersByCustomerIdSubscriptionsResponse200Schema },
		},
	),
	getV1AdminCustomersByCustomerIdStoreEvents: defineContract(
		"get",
		"/v1/admin/customers/:customerId/store-events",
		{
			operationId: "getV1AdminCustomersByCustomerIdStoreEvents",
			tags: ["admin"],
			params: z.object({ customerId: z.string().min(1) }),
			responses: { "200": responses.getV1AdminCustomersByCustomerIdStoreEventsResponse200Schema },
		},
	),
	getV1AdminCustomersByCustomerIdProjectionJobs: defineContract(
		"get",
		"/v1/admin/customers/:customerId/projection-jobs",
		{
			operationId: "getV1AdminCustomersByCustomerIdProjectionJobs",
			tags: ["admin"],
			params: z.object({ customerId: z.string().min(1) }),
			responses: {
				"200": responses.getV1AdminCustomersByCustomerIdProjectionJobsResponse200Schema,
			},
		},
	),
	getV1AdminCustomersByCustomerId: defineContract("get", "/v1/admin/customers/:customerId", {
		operationId: "getV1AdminCustomersByCustomerId",
		tags: ["admin"],
		params: z.object({ customerId: z.string().min(1) }),
		responses: { "200": responses.getV1AdminCustomersByCustomerIdResponse200Schema },
	}),
	getV1AdminPurchases: defineContract("get", "/v1/admin/purchases", {
		operationId: "getV1AdminPurchases",
		tags: ["admin"],
		responses: { "200": responses.getV1AdminPurchasesResponse200Schema },
	}),
	getV1AdminSubscriptions: defineContract("get", "/v1/admin/subscriptions", {
		operationId: "getV1AdminSubscriptions",
		tags: ["admin"],
		responses: { "200": responses.getV1AdminSubscriptionsResponse200Schema },
	}),
	getV1AdminStoreEvents: defineContract("get", "/v1/admin/store-events", {
		operationId: "getV1AdminStoreEvents",
		tags: ["admin"],
		responses: { "200": responses.getV1AdminStoreEventsResponse200Schema },
	}),
	getV1AdminStoreEventsByEventId: defineContract("get", "/v1/admin/store-events/:eventId", {
		operationId: "getV1AdminStoreEventsByEventId",
		tags: ["admin"],
		params: z.object({ eventId: z.string().min(1) }),
		responses: { "200": responses.getV1AdminStoreEventsByEventIdResponse200Schema },
	}),
	getV1AdminProjectionJobs: defineContract("get", "/v1/admin/projection-jobs", {
		operationId: "getV1AdminProjectionJobs",
		tags: ["admin"],
		responses: { "200": responses.getV1AdminProjectionJobsResponse200Schema },
	}),
	getV1AdminCatalogProducts: defineContract("get", "/v1/admin/catalog/products", {
		operationId: "getV1AdminCatalogProducts",
		query: paginationSchema,
		tags: ["admin"],
		responses: { "200": responses.getV1AdminCatalogProductsResponse200Schema },
	}),
	getV1AdminStatsSummary: defineContract("get", "/v1/admin/stats/summary", {
		operationId: "getV1AdminStatsSummary",
		tags: ["admin"],
		responses: { "200": responses.getV1AdminStatsSummaryResponse200Schema },
	}),
	getV1AdminCatalogStoreProducts: defineContract("get", "/v1/admin/catalog/store-products", {
		operationId: "getV1AdminCatalogStoreProducts",
		tags: ["admin"],
		responses: { "200": responses.getV1AdminCatalogStoreProductsResponse200Schema },
	}),
	postV1AdminStoreEventsByEventIdReplay: defineContract(
		"post",
		"/v1/admin/store-events/:eventId/replay",
		{
			operationId: "postV1AdminStoreEventsByEventIdReplay",
			tags: ["admin"],
			params: z.object({ eventId: z.string().min(1) }),
			responses: { "200": responses.postV1AdminStoreEventsByEventIdReplayResponse200Schema },
		},
	),
	postV1AdminReconciliationSubscriptionsRun: defineContract(
		"post",
		"/v1/admin/reconciliation/subscriptions/run",
		{
			operationId: "postV1AdminReconciliationSubscriptionsRun",
			tags: ["admin"],
			responses: { "200": responses.postV1AdminReconciliationSubscriptionsRunResponse200Schema },
		},
	),
	postV1AdminProjectionJobsByJobIdRetry: defineContract(
		"post",
		"/v1/admin/projection-jobs/:jobId/retry",
		{
			operationId: "postV1AdminProjectionJobsByJobIdRetry",
			tags: ["admin"],
			params: z.object({ jobId: z.string().min(1) }),
			responses: { "200": responses.postV1AdminProjectionJobsByJobIdRetryResponse200Schema },
		},
	),
} as const;
