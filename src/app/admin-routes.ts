import { z } from "zod";
import {
	paginationSchema,
	parseBillingAccountIdParam,
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
import { projectScopedRateLimitGuard } from "../http/rate-limit";
import { type BillingLogger, safelyLogInfo } from "../observability/logger";
import type { BillingMetrics } from "../observability/metrics";
import type { BillingAdminOperations } from "../operations/admin";
import { constantTimeEquals } from "../shared/constant-time-equals";
import { operationDetail } from "../shared/http";
import * as responses from "./contracts/admin-responses";
import { privateProject } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

const OPERATOR_PATH_PATTERN =
	/^\/v1\/admin\/(store-events\/[^/]+\/replay|projection-jobs\/[^/]+\/retry|reconciliation\/subscriptions\/run|metrics)$/;

const billingAccountIdParamsSchema = z.object({ billingAccountId: z.string().min(1) });
const customerIdParamsSchema = z.object({ customerId: z.string().min(1) });
const eventIdParamsSchema = z.object({ eventId: z.string().min(1) });
const jobIdParamsSchema = z.object({ jobId: z.string().min(1) });

export interface AdminRoutesDependencies {
	app: BillingElysia;
	adminLimiter: { check(key: string): { allowed: boolean; remaining: number; resetAt: Date } };
	rateLimitKeyOptions: { trustProxyHeaders?: boolean };
	operatorApiKey: string | null;
	billingMetrics: BillingMetrics;
	billingLogger: BillingLogger;
	getAdminBillingReader: () => AdminBillingReader | null;
	adminOperations: BillingAdminOperations | null;
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
}

export function registerAdminRoutes({
	app,
	adminLimiter,
	rateLimitKeyOptions,
	operatorApiKey,
	billingMetrics,
	billingLogger,
	getAdminBillingReader,
	adminOperations,
	registerPostAuthGuard,
}: AdminRoutesDependencies): void {
	registerPostAuthGuard(
		projectScopedRateLimitGuard({
			limiter: adminLimiter,
			matches: (p) => p.startsWith("/v1/admin/"),
			trustProxyHeaders: rateLimitKeyOptions.trustProxyHeaders,
		}),
	);
	registerPostAuthGuard(
		operatorApiKeyGuard(
			operatorApiKey,
			(p) => OPERATOR_PATH_PATTERN.test(p) || p.startsWith("/v1/admin/catalog/"),
		),
	);

	app.get(
		"/v1/admin/metrics",
		() =>
			new Response(billingMetrics.renderPrometheus(), {
				headers: { "content-type": "text/plain; version=0.0.4" },
			}),
		{
			detail: operationDetail({
				operationId: "getV1AdminMetrics",
				tags: ["admin"],
				path: "/v1/admin/metrics",
				responses: { 200: z.string() },
				contentType: "text/plain",
			}),
		},
	);

	app.get(
		"/v1/admin/customers/search",
		async ({ request, project }) => {
			const input = parseCustomerSearchQuery(queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).searchCustomers(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminCustomersSearch",
				tags: ["admin"],
				path: "/v1/admin/customers/search",
				responses: { 200: responses.getV1AdminCustomersSearchResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/customers/by-billing-account/:billingAccountId",
		async ({ params, project }) => {
			const billingAccountId = parseBillingAccountIdParam(params.billingAccountId);
			const result = await requireAdminBillingReader(
				getAdminBillingReader(),
			).getCustomerByBillingAccountId(privateProject(project), billingAccountId);
			return adminDetailResponse(result);
		},
		{
			params: billingAccountIdParamsSchema,
			detail: operationDetail({
				operationId: "getV1AdminCustomersByBillingAccountByBillingAccountId",
				tags: ["admin"],
				path: "/v1/admin/customers/by-billing-account/:billingAccountId",
				responses: {
					200: responses.getV1AdminCustomersByBillingAccountByBillingAccountIdResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/customers/:customerId/purchases",
		async ({ params, request, project }) => {
			const input = parseCustomerPurchaseListQuery(params.customerId, queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listPurchases(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			params: customerIdParamsSchema,
			detail: operationDetail({
				operationId: "getV1AdminCustomersByCustomerIdPurchases",
				tags: ["admin"],
				path: "/v1/admin/customers/:customerId/purchases",
				responses: { 200: responses.getV1AdminCustomersByCustomerIdPurchasesResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/customers/:customerId/subscriptions",
		async ({ params, request, project }) => {
			const input = parseCustomerSubscriptionListQuery(params.customerId, queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listSubscriptions(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			params: customerIdParamsSchema,
			detail: operationDetail({
				operationId: "getV1AdminCustomersByCustomerIdSubscriptions",
				tags: ["admin"],
				path: "/v1/admin/customers/:customerId/subscriptions",
				responses: { 200: responses.getV1AdminCustomersByCustomerIdSubscriptionsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/customers/:customerId/store-events",
		async ({ params, request, project }) => {
			const input = parseCustomerStoreEventListQuery(params.customerId, queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listStoreEvents(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			params: customerIdParamsSchema,
			detail: operationDetail({
				operationId: "getV1AdminCustomersByCustomerIdStoreEvents",
				tags: ["admin"],
				path: "/v1/admin/customers/:customerId/store-events",
				responses: { 200: responses.getV1AdminCustomersByCustomerIdStoreEventsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/customers/:customerId/projection-jobs",
		async ({ params, request, project }) => {
			const input = parseCustomerProjectionJobListQuery(params.customerId, queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listProjectionJobs(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			params: customerIdParamsSchema,
			detail: operationDetail({
				operationId: "getV1AdminCustomersByCustomerIdProjectionJobs",
				tags: ["admin"],
				path: "/v1/admin/customers/:customerId/projection-jobs",
				responses: {
					200: responses.getV1AdminCustomersByCustomerIdProjectionJobsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/customers/:customerId",
		async ({ params, project }) => {
			const customerId = parseCustomerIdParam(params.customerId);
			const result = await requireAdminBillingReader(getAdminBillingReader()).getCustomerById(
				privateProject(project),
				customerId,
			);
			return adminDetailResponse(result);
		},
		{
			params: customerIdParamsSchema,
			detail: operationDetail({
				operationId: "getV1AdminCustomersByCustomerId",
				tags: ["admin"],
				path: "/v1/admin/customers/:customerId",
				responses: { 200: responses.getV1AdminCustomersByCustomerIdResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/purchases",
		async ({ request, project }) => {
			const input = parsePurchaseListQuery(queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listPurchases(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminPurchases",
				tags: ["admin"],
				path: "/v1/admin/purchases",
				responses: { 200: responses.getV1AdminPurchasesResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/subscriptions",
		async ({ request, project }) => {
			const input = parseSubscriptionListQuery(queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listSubscriptions(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminSubscriptions",
				tags: ["admin"],
				path: "/v1/admin/subscriptions",
				responses: { 200: responses.getV1AdminSubscriptionsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/store-events",
		async ({ request, project }) => {
			const input = parseStoreEventListQuery(queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listStoreEvents(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminStoreEvents",
				tags: ["admin"],
				path: "/v1/admin/store-events",
				responses: { 200: responses.getV1AdminStoreEventsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/store-events/:eventId",
		async ({ params, request, project }) => {
			const scopedProject = privateProject(project);
			const eventId = parseEventIdParam(params.eventId);
			const detailQuery = parseStoreEventDetailQuery(queryParams(request));
			if (detailQuery.includeRawPayload) {
				safelyLogInfo(billingLogger, "Billing admin raw store event payload read", {
					projectKey: scopedProject.projectInstanceKey,
					eventId,
				});
			}
			const result = await requireAdminBillingReader(getAdminBillingReader()).getStoreEvent(
				scopedProject,
				{
					eventId,
					includeRawPayload: detailQuery.includeRawPayload,
				},
			);
			return adminDetailResponse(result);
		},
		{
			params: eventIdParamsSchema,
			detail: operationDetail({
				operationId: "getV1AdminStoreEventsByEventId",
				tags: ["admin"],
				path: "/v1/admin/store-events/:eventId",
				responses: { 200: responses.getV1AdminStoreEventsByEventIdResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/projection-jobs",
		async ({ request, project }) => {
			const input = parseProjectionJobListQuery(queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).listProjectionJobs(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminProjectionJobs",
				tags: ["admin"],
				path: "/v1/admin/projection-jobs",
				responses: { 200: responses.getV1AdminProjectionJobsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/catalog/products",
		async ({ query, project }) => {
			const input = { limit: query.limit, cursor: query.cursor ?? null };
			const result = await requireAdminBillingReader(getAdminBillingReader()).listCatalogProducts(
				privateProject(project),
				input,
			);
			return adminListResponse(result);
		},
		{
			query: paginationSchema,
			detail: operationDetail({
				operationId: "getV1AdminCatalogProducts",
				tags: ["admin"],
				path: "/v1/admin/catalog/products",
				responses: { 200: responses.getV1AdminCatalogProductsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/stats/summary",
		async ({ request, project }) => {
			const input = parseStatsSummaryQuery(queryParams(request));
			const result = await requireAdminBillingReader(getAdminBillingReader()).getStatsSummary(
				privateProject(project),
				input,
			);
			return adminDetailResponse(result);
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminStatsSummary",
				tags: ["admin"],
				path: "/v1/admin/stats/summary",
				responses: { 200: responses.getV1AdminStatsSummaryResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/catalog/store-products",
		async ({ request, project }) => {
			const input = parseCatalogStoreProductListQuery(queryParams(request));
			const result = await requireAdminBillingReader(
				getAdminBillingReader(),
			).listCatalogStoreProducts(privateProject(project), input);
			return adminListResponse(result);
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminCatalogStoreProducts",
				tags: ["admin"],
				path: "/v1/admin/catalog/store-products",
				responses: { 200: responses.getV1AdminCatalogStoreProductsResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/store-events/:eventId/replay",
		async ({ params, project }) => {
			const scopedProject = privateProject(project);
			const eventId = params.eventId;
			safelyLogInfo(billingLogger, "Billing admin store event replay requested", {
				projectKey: scopedProject.projectInstanceKey,
				eventId,
			});
			const result = await requireBillingAdminOperations(adminOperations).replayStoreEvent(
				scopedProject,
				eventId,
			);
			return { success: true, data: result };
		},
		{
			params: eventIdParamsSchema,
			detail: operationDetail({
				operationId: "postV1AdminStoreEventsByEventIdReplay",
				tags: ["admin"],
				path: "/v1/admin/store-events/:eventId/replay",
				responses: { 200: responses.postV1AdminStoreEventsByEventIdReplayResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/reconciliation/subscriptions/run",
		async ({ project }) => {
			const scopedProject = privateProject(project);
			safelyLogInfo(billingLogger, "Billing admin subscription reconciliation requested", {
				projectKey: scopedProject.projectInstanceKey,
			});
			const result =
				await requireBillingAdminOperations(adminOperations).runSubscriptionReconciliation();
			return { success: true, data: result };
		},
		{
			detail: operationDetail({
				operationId: "postV1AdminReconciliationSubscriptionsRun",
				tags: ["admin"],
				path: "/v1/admin/reconciliation/subscriptions/run",
				responses: { 200: responses.postV1AdminReconciliationSubscriptionsRunResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/projection-jobs/:jobId/retry",
		async ({ params, project }) => {
			const scopedProject = privateProject(project);
			const jobId = params.jobId;
			safelyLogInfo(billingLogger, "Billing admin projection retry requested", {
				projectKey: scopedProject.projectInstanceKey,
				jobId,
			});
			const result = await requireBillingAdminOperations(adminOperations).retryProjectionSyncJob(
				scopedProject,
				jobId,
			);
			return { success: true, data: result };
		},
		{
			params: jobIdParamsSchema,
			detail: operationDetail({
				operationId: "postV1AdminProjectionJobsByJobIdRetry",
				tags: ["admin"],
				path: "/v1/admin/projection-jobs/:jobId/retry",
				responses: { 200: responses.postV1AdminProjectionJobsByJobIdRetryResponse200Schema },
			}),
		},
	);
}

export function operatorApiKeyGuard(
	operatorApiKey: string | null,
	matches: (path: string) => boolean,
): PostAuthGuard {
	return {
		matches,
		guard({ request }) {
			if (operatorApiKey === null) {
				throw new BillingError(
					"Billing operator key is not configured",
					"BILLING_OPERATOR_NOT_CONFIGURED",
					501,
				);
			}

			if (
				!constantTimeEquals(request.headers.get("x-billing-operator-key") ?? "", operatorApiKey)
			) {
				throw new BillingError("Invalid billing operator key", "UNAUTHORIZED", 401);
			}
		},
	};
}

function queryParams(request: Request): URLSearchParams {
	return new URL(request.url).searchParams;
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
