import type { Context, Hono } from "hono";
import { z } from "zod";
import { BillingError, InvalidRequestError } from "../billing/errors";
import type { MeteringServiceLike } from "../billing/metering";
import { type RateLimitResult, rateLimitMiddleware } from "../http/rate-limit";
import {
	type BillingMetrics,
	safelyIncrementBillingMetric,
	safelyObserveBillingMetric,
} from "../observability/metrics";
import type { ProjectContext } from "../projects/context";
import type { BillingContext, BillingHonoEnv } from "./types";

type RateLimiter = { check(key: string): RateLimitResult };

export interface MeteringRoutesDependencies {
	app: Hono<BillingHonoEnv>;
	meteringLimiter: RateLimiter;
	rateLimitKey: (c: Context) => string;
	meteringService: MeteringServiceLike;
	billingMetrics: BillingMetrics;
	parsePrivateJson(request: Request): Promise<unknown>;
}

const subjectParamsSchema = z.object({
	billingAccountId: z.string().trim().min(1).max(256),
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
	z.union([z.string().max(256), z.number().finite(), z.boolean()]),
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
	expiresInSeconds: z.number().int().min(1).max(86400),
});

const confirmBodySchema = z
	.object({
		quantity: z.string().trim().min(1).max(80),
		occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

const emptyBodySchema = z.object({}).strict();

const correctionBodySchema = z
	.object({
		originalRecordedAt: z.iso.datetime({ offset: true }),
		quantity: z.string().trim().min(1).max(80),
		reason: z.string().trim().min(1).max(500),
		occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export function registerMeteringRoutes({
	app,
	meteringLimiter,
	rateLimitKey,
	meteringService,
	billingMetrics,
	parsePrivateJson,
}: MeteringRoutesDependencies): void {
	app.use("/v1/billing-accounts/:billingAccountId/usage/*", async (c, next) => {
		const startedAt = performance.now();
		try {
			await next();
		} finally {
			const labels = {
				operation: meteringOperation(c.req.path),
				result: c.res.status >= 400 ? "failed" : "completed",
			};
			safelyIncrementBillingMetric(billingMetrics, "billing_metering_operations_total", labels);
			safelyObserveBillingMetric(
				billingMetrics,
				"billing_metering_operation_duration_ms",
				performance.now() - startedAt,
				labels,
			);
		}
	});
	app.use(
		"/v1/billing-accounts/:billingAccountId/usage/*",
		rateLimitMiddleware({ limiter: meteringLimiter, key: rateLimitKey }),
	);
	app.use(
		"/v1/billing-accounts/:billingAccountId/balances/*",
		rateLimitMiddleware({ limiter: meteringLimiter, key: rateLimitKey }),
	);

	app.get("/v1/billing-accounts/:billingAccountId/balances/:featureKey", async (c) => {
		const params = parseSchema(
			balanceParamsSchema,
			c.req.param(),
			"Invalid balance route parameters",
		);
		const balance = await meteringService.getBalance(
			privateProject(c),
			params.billingAccountId,
			params.featureKey,
			new URL(c.req.url).searchParams.get("entityId"),
		);
		return c.json({ success: true, data: balance });
	});

	app.post("/v1/billing-accounts/:billingAccountId/usage/check", async (c) => {
		const params = parseSchema(
			subjectParamsSchema,
			c.req.param(),
			"Invalid usage route parameters",
		);
		const body = parseSchema(
			usageBodySchema,
			await parsePrivateJson(c.req.raw),
			"Invalid usage check body",
		);
		const result = await meteringService.check(privateProject(c), {
			billingAccountId: params.billingAccountId,
			...usageInput(body),
		});
		return c.json({ success: true, data: result });
	});

	app.post("/v1/billing-accounts/:billingAccountId/usage/consume", async (c) => {
		const params = parseSchema(
			subjectParamsSchema,
			c.req.param(),
			"Invalid usage route parameters",
		);
		const body = parseSchema(
			usageBodySchema,
			await parsePrivateJson(c.req.raw),
			"Invalid usage consume body",
		);
		const result = await meteringService.consume(privateProject(c), {
			billingAccountId: params.billingAccountId,
			idempotencyKey: requireIdempotencyKey(c.req.header("idempotency-key")),
			...usageInput(body),
		});
		return c.json({ success: true, data: result });
	});

	app.post("/v1/billing-accounts/:billingAccountId/usage/reservations", async (c) => {
		const params = parseSchema(
			subjectParamsSchema,
			c.req.param(),
			"Invalid usage route parameters",
		);
		const body = parseSchema(
			reserveBodySchema,
			await parsePrivateJson(c.req.raw),
			"Invalid usage reservation body",
		);
		const result = await meteringService.reserve(privateProject(c), {
			billingAccountId: params.billingAccountId,
			idempotencyKey: requireIdempotencyKey(c.req.header("idempotency-key")),
			expiresInSeconds: body.expiresInSeconds,
			...usageInput(body),
		});
		return c.json({ success: true, data: result });
	});

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/confirm",
		async (c) => {
			const params = parseSchema(
				reservationParamsSchema,
				c.req.param(),
				"Invalid reservation route parameters",
			);
			const body = parseSchema(
				confirmBodySchema,
				await parsePrivateJson(c.req.raw),
				"Invalid reservation confirmation body",
			);
			const result = await meteringService.confirm(privateProject(c), {
				billingAccountId: params.billingAccountId,
				reservationId: params.reservationId,
				quantity: body.quantity,
				idempotencyKey: requireIdempotencyKey(c.req.header("idempotency-key")),
				occurredAt: body.occurredAt === undefined ? undefined : dateOrNull(body.occurredAt),
				metadata: body.metadata,
			});
			return c.json({ success: true, data: result });
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/reservations/:reservationId/release",
		async (c) => {
			const params = parseSchema(
				reservationParamsSchema,
				c.req.param(),
				"Invalid reservation route parameters",
			);
			parseSchema(
				emptyBodySchema,
				await optionalPrivateJson(c.req.raw, parsePrivateJson),
				"Invalid reservation release body",
			);
			const result = await meteringService.release(privateProject(c), {
				billingAccountId: params.billingAccountId,
				reservationId: params.reservationId,
				idempotencyKey: requireIdempotencyKey(c.req.header("idempotency-key")),
			});
			return c.json({ success: true, data: result });
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage/events/:usageEventId/corrections",
		async (c) => {
			const params = parseSchema(
				usageEventParamsSchema,
				c.req.param(),
				"Invalid usage correction route parameters",
			);
			const body = parseSchema(
				correctionBodySchema,
				await parsePrivateJson(c.req.raw),
				"Invalid usage correction body",
			);
			const result = await meteringService.correct(privateProject(c), {
				billingAccountId: params.billingAccountId,
				originalUsageEventId: params.usageEventId,
				originalRecordedAt: new Date(body.originalRecordedAt),
				quantity: body.quantity,
				idempotencyKey: requireIdempotencyKey(c.req.header("idempotency-key")),
				actor: requireActor(c.req.header("x-billing-actor")),
				reason: body.reason,
				occurredAt: body.occurredAt === undefined ? undefined : dateOrNull(body.occurredAt),
				metadata: body.metadata,
			});
			return c.json({ success: true, data: result });
		},
	);
}

function meteringOperation(path: string): string {
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

function requireIdempotencyKey(value: string | undefined): string {
	const key = value?.trim();
	if (key === undefined || key === "" || key.length > 200) {
		throw new InvalidRequestError(
			"Idempotency-Key header must contain between 1 and 200 characters",
		);
	}
	return key;
}

function requireActor(value: string | undefined): string {
	const actor = value?.trim();
	if (actor === undefined || actor === "" || actor.length > 200) {
		throw new InvalidRequestError(
			"X-Billing-Actor header must contain between 1 and 200 characters",
		);
	}
	return actor;
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new InvalidRequestError(message);
	}
	return parsed.data;
}

async function optionalPrivateJson(
	request: Request,
	parsePrivateJson: (request: Request) => Promise<unknown>,
): Promise<unknown> {
	return request.body === null ? {} : await parsePrivateJson(request);
}

function privateProject(c: BillingContext): ProjectContext {
	const project = c.get("project");
	if (project === undefined) {
		throw new BillingError("Billing project context is required", "BILLING_PROJECT_REQUIRED", 401);
	}
	return project;
}
