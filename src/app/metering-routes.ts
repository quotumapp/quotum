import { z } from "zod";
import { InvalidRequestError } from "../billing/errors";
import type { MeteringServiceLike } from "../billing/metering";
import { usageOperationKinds } from "../billing/usage-operations";
import { projectScopedRateLimitGuard } from "../http/rate-limit";
import {
	type BillingMetrics,
	safelyIncrementBillingMetric,
	safelyObserveBillingMetric,
} from "../observability/metrics";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import * as responses from "./contracts/metering-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard, RequestObserver } from "./types";

export interface MeteringRoutesDependencies {
	app: BillingElysia;
	meteringLimiter: { check(key: string): { allowed: boolean; remaining: number; resetAt: Date } };
	rateLimitKeyOptions: { trustProxyHeaders?: boolean };
	meteringService: MeteringServiceLike;
	billingMetrics: BillingMetrics;
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
	registerRequestObserver: (observer: RequestObserver) => void;
}

const subjectParamsSchema = z.object({
	billingAccountId: z.string().trim().min(1).max(256),
});

const operationParamsSchema = subjectParamsSchema.extend({
	operation: z.enum(usageOperationKinds),
	operationId: z.string().trim().min(1).max(200),
});

const balanceParamsSchema = subjectParamsSchema.extend({
	featureKey: z.string().trim().min(1).max(120),
});

const reservationParamsSchema = subjectParamsSchema.extend({
	reservationId: z.uuid(),
});

const usageEventParamsSchema = subjectParamsSchema.extend({
	usageEventId: z.uuid(),
});

const filtersSchema = z.record(
	z.string().trim().min(1).max(120),
	z.union([z.string().max(256), z.number(), z.boolean()]),
);

const usageBodySchema = z
	.object({
		featureKey: z.string().trim().min(1).max(120),
		quantity: z.string().trim().min(1).max(80),
		entityId: z.string().trim().min(1).max(256).nullable().optional(),
		filters: filtersSchema.optional(),
		occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

const reserveBodySchema = usageBodySchema.extend({
	expiresInSeconds: z.number().int().min(1).max(86400).default(300),
});

const confirmBodySchema = z
	.object({
		quantity: z.string().trim().min(1).max(80),
		occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

/** Absent request bodies are allowed; `.optional()` keeps the rendered schema a plain object. */
const emptyBodySchema = z.object({}).strict().optional();

export const correctionBodySchema = z
	.object({
		originalRecordedAt: z.iso.datetime({ offset: true }),
		quantity: z.string().trim().min(1).max(80),
		reason: z.string().trim().min(1).max(500),
		occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

const METERING_LIMITER_PATH_PATTERN = /^\/v1\/billing-accounts\/[^/]+\/(usage|balances)\//;
const USAGE_PATH_PATTERN = /^\/v1\/billing-accounts\/[^/]+\/usage\//;

export function registerMeteringRoutes({
	app,
	meteringLimiter,
	rateLimitKeyOptions,
	meteringService,
	billingMetrics,
	registerPostAuthGuard,
	registerRequestObserver,
}: MeteringRoutesDependencies): void {
	registerRequestObserver({
		// Metering operations only: usage insights reads share the prefix but are not operations.
		matches: (path) => USAGE_PATH_PATTERN.test(path) && meteringOperation(path) !== "unknown",
		finish({ path, durationMs, result }) {
			const labels = { operation: meteringOperation(path), result };
			safelyIncrementBillingMetric(billingMetrics, "billing_metering_operations_total", labels);
			safelyObserveBillingMetric(
				billingMetrics,
				"billing_metering_operation_duration_ms",
				durationMs,
				labels,
			);
		},
	});
	registerPostAuthGuard(
		projectScopedRateLimitGuard({
			limiter: meteringLimiter,
			matches: (path) => METERING_LIMITER_PATH_PATTERN.test(path),
			trustProxyHeaders: rateLimitKeyOptions.trustProxyHeaders,
		}),
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/balances/:featureKey",
		async ({ params, request, project }) => {
			const balance = await meteringService.getBalance(
				privateProject(project),
				params.billingAccountId,
				params.featureKey,
				new URL(request.url).searchParams.get("entityId"),
			);
			return { success: true, data: balance };
		},
		{
			params: balanceParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdBalancesByFeatureKey",
				credentialAccess: "read_only",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/balances/:featureKey",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdBalancesByFeatureKeyResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/usage/operations/:operation/:operationId",
		async ({ params, project }) => {
			const result = await meteringService.getOperation(privateProject(project), params);
			return { success: true, data: result };
		},
		{
			params: operationParamsSchema,
			detail: operationDetail({
				operationId:
					"getV1BillingAccountsByBillingAccountIdUsageOperationsByOperationByOperationId",
				credentialAccess: "read_only",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/operations/:operation/:operationId",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdUsageOperationsByOperationByOperationIdResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/check",
		async ({ params, body, project }) => {
			const result = await meteringService.check(privateProject(project), {
				billingAccountId: params.billingAccountId,
				...usageInput(body),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: subjectParamsSchema,
			body: usageBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdUsageCheck",
				// check reads balances and controls and records nothing.
				credentialAccess: "read_only",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/check",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdUsageCheckResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/consume",
		async ({ params, body, request, project }) => {
			const result = await meteringService.consume(privateProject(project), {
				billingAccountId: params.billingAccountId,
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
				...usageInput(body),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: subjectParamsSchema,
			body: usageBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdUsageConsume",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/consume",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdUsageConsumeResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/reservations",
		async ({ params, body, request, project }) => {
			const result = await meteringService.reserve(privateProject(project), {
				billingAccountId: params.billingAccountId,
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
				expiresInSeconds: body.expiresInSeconds,
				...usageInput(body),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: subjectParamsSchema,
			body: reserveBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdUsageReservations",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/reservations",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdUsageReservationsResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/confirm",
		async ({ params, body, request, project }) => {
			const result = await meteringService.confirm(privateProject(project), {
				billingAccountId: params.billingAccountId,
				reservationId: params.reservationId,
				quantity: body.quantity,
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
				occurredAt: body.occurredAt === undefined ? undefined : dateOrNull(body.occurredAt),
				metadata: body.metadata,
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: reservationParamsSchema,
			body: confirmBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId:
					"postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdConfirm",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/confirm",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdConfirmResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/release",
		async ({ params, request, project }) => {
			const result = await meteringService.release(privateProject(project), {
				billingAccountId: params.billingAccountId,
				reservationId: params.reservationId,
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: reservationParamsSchema,
			body: emptyBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId:
					"postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdRelease",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/release",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdReleaseResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/events/:usageEventId/corrections",
		async ({ params, body, request, project }) => {
			const result = await meteringService.correct(privateProject(project), {
				billingAccountId: params.billingAccountId,
				originalUsageEventId: params.usageEventId,
				originalRecordedAt: new Date(body.originalRecordedAt),
				quantity: body.quantity,
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
				actor: requireActor(request.headers),
				reason: body.reason,
				occurredAt: body.occurredAt === undefined ? undefined : dateOrNull(body.occurredAt),
				metadata: body.metadata,
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: usageEventParamsSchema,
			body: correctionBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdUsageEventsByUsageEventIdCorrections",
				tags: ["metering"],
				path: "/v1/billing-accounts/:billingAccountId/usage/events/:usageEventId/corrections",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdUsageEventsByUsageEventIdCorrectionsResponse200Schema,
				},
			}),
		},
	);
}

function meteringOperation(path: string): string {
	if (path.includes("/usage/operations/")) return "lookup";
	if (path.endsWith("/check")) return "check";
	if (path.endsWith("/consume")) return "consume";
	if (path.endsWith("/confirm")) return "confirm";
	if (path.endsWith("/release")) return "release";
	if (path.endsWith("/corrections")) return "correct";
	if (path.endsWith("/reservations")) return "reserve";
	return "unknown";
}

function usageInput(body: z.infer<typeof usageBodySchema>) {
	return {
		featureKey: body.featureKey,
		quantity: body.quantity,
		entityId: body.entityId,
		filters: body.filters,
		occurredAt: body.occurredAt === undefined ? undefined : dateOrNull(body.occurredAt),
		metadata: body.metadata,
	};
}

function dateOrNull(value: string | null): Date | null {
	return value === null ? null : new Date(value);
}

function requireIdempotencyKey(value: string | null): string {
	const key = value?.trim();
	if (key === undefined || key === "" || key.length > 200) {
		throw new InvalidRequestError(
			"Idempotency-Key header must contain between 1 and 200 characters",
		);
	}
	return key;
}
