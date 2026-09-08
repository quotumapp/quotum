import type { Context, Hono } from "hono";
import { z } from "zod";
import { BillingError, isBillingError } from "../billing/errors";
import { type RateLimitResult, rateLimitMiddleware } from "../http/rate-limit";
import { type BillingLogger, safelyLogError } from "../observability/logger";
import { type BillingMetrics, safelyIncrementBillingMetric } from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import { defineContract, registerRoute } from "../shared/http-contract";
import {
	AppleWebhookResultSchema,
	EntitlementSnapshotSchema,
	GoogleWebhookResultSchema,
} from "./contracts/provider-responses";
import {
	requireAppleStoreKitService,
	requireGooglePlayBillingService,
	requireStripeBillingService,
} from "./provider-services";
import type { BillingContext, BillingHonoEnv, ProjectProviderServiceResolver } from "./types";

type RateLimiter = { check(key: string): RateLimitResult };

export interface WebhookRoutesDependencies {
	app: Hono<BillingHonoEnv>;
	contextResolver: ProjectInstanceContextResolver;
	webhookLimiter: RateLimiter;
	rateLimitKey: (c: Context) => string;
	providerServices: ProjectProviderServiceResolver;
	billingMetrics: BillingMetrics;
	billingLogger: BillingLogger;
	parseJson(request: Request, maxBytes?: number): Promise<unknown>;
	readRequestText(request: Request, maxBytes?: number): Promise<string>;
}

const publicWebhookMaxBodyBytes = 256 * 1024;

const appleWebhookSchema = z.object({
	signedPayload: z.string().trim().min(1),
});

const googleWebhookSchema = z
	.object({
		message: z.object({
			data: z.string().min(1),
			messageId: z.string().trim().min(1),
			attributes: z.record(z.string(), z.string()).optional(),
		}),
		subscription: z.string().trim().min(1),
	})
	.loose();

export function registerWebhookRoutes({
	app,
	contextResolver,
	webhookLimiter,
	rateLimitKey,
	providerServices,
	billingMetrics,
	billingLogger,
	parseJson,
	readRequestText,
}: WebhookRoutesDependencies): void {
	const webhookProject = async (projectKey: string): Promise<ProjectInstanceContext> => {
		const resolution = await contextResolver.resolveInstanceKey(projectKey);
		if (resolution.kind === "unavailable") {
			throw new BillingError(
				"Billing project context is unavailable",
				"BILLING_PROJECT_CONTEXT_UNAVAILABLE",
				503,
			);
		}
		if (resolution.kind !== "resolved") {
			throw new BillingError(
				"Billing project is not configured",
				"BILLING_PROJECT_NOT_CONFIGURED",
				404,
			);
		}

		return resolution.context;
	};
	const withWebhookFailureRecording = async <T>(
		provider: "apple" | "google" | "stripe",
		message: string,
		project: ProjectInstanceContext,
		run: () => Promise<T>,
	): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			recordWebhookFailure(
				billingMetrics,
				billingLogger,
				provider,
				error,
				message,
				project.projectInstanceKey,
			);
			throw error;
		}
	};
	const handleAppleWebhook = async (c: BillingContext, project: ProjectInstanceContext) =>
		withWebhookFailureRecording("apple", "Apple webhook failed", project, async () => {
			const body = await parseJson(c.req.raw, publicWebhookMaxBodyBytes);
			const parsed = appleWebhookSchema.safeParse(body);
			if (!parsed.success) {
				throw new BillingError("Invalid Apple webhook body", "INVALID_REQUEST", 400);
			}

			const result = await requireAppleStoreKitService(
				providerServices.appleStoreKitService(project),
			).handleNotification(parsed.data);
			return c.json({ success: true, data: result });
		});
	const handleGoogleWebhook = async (c: BillingContext, project: ProjectInstanceContext) =>
		withWebhookFailureRecording("google", "Google webhook failed", project, async () => {
			const authorizationHeader = c.req.header("authorization") ?? null;
			if (!hasBearerToken(authorizationHeader)) {
				throw new BillingError(
					"Google Pub/Sub push token is required",
					"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
					401,
				);
			}

			const service = requireGooglePlayBillingService(
				providerServices.googlePlayBillingService(project),
			);
			await service.verifyRtdnAuthorization?.(authorizationHeader);

			const body = await parseJson(c.req.raw, publicWebhookMaxBodyBytes);
			const parsed = googleWebhookSchema.safeParse(body);
			if (!parsed.success) {
				throw new BillingError("Invalid Google webhook body", "INVALID_REQUEST", 400);
			}

			const result = await service.handleRtdn({
				authorizationHeader,
				body: parsed.data,
			});
			return c.json({ success: true, data: result });
		});
	const handleStripeWebhook = async (c: BillingContext, project: ProjectInstanceContext) =>
		withWebhookFailureRecording("stripe", "Stripe webhook failed", project, async () => {
			const rawBody = await readRequestText(c.req.raw, publicWebhookMaxBodyBytes);
			const result = await requireStripeBillingService(
				providerServices.stripeBillingService(project),
			).handleWebhook({
				rawBody,
				signatureHeader: c.req.header("stripe-signature") ?? null,
			});
			return c.json({ success: true, data: result });
		});

	app.use(
		"/v1/projects/:projectKey/webhooks/stripe",
		rateLimitMiddleware({ limiter: webhookLimiter, key: rateLimitKey }),
	);
	app.use(
		"/v1/projects/:projectKey/webhooks/apple",
		rateLimitMiddleware({ limiter: webhookLimiter, key: rateLimitKey }),
	);
	app.use(
		"/v1/projects/:projectKey/webhooks/google",
		rateLimitMiddleware({ limiter: webhookLimiter, key: rateLimitKey }),
	);

	registerRoute(app, webhookContracts.postV1ProjectsByProjectKeyWebhooksApple, async (c) =>
		handleAppleWebhook(c, await webhookProject(c.req.param("projectKey"))),
	);

	registerRoute(app, webhookContracts.postV1ProjectsByProjectKeyWebhooksGoogle, async (c) =>
		handleGoogleWebhook(c, await webhookProject(c.req.param("projectKey"))),
	);

	registerRoute(app, webhookContracts.postV1ProjectsByProjectKeyWebhooksStripe, async (c) =>
		handleStripeWebhook(c, await webhookProject(c.req.param("projectKey"))),
	);
}

function recordWebhookFailure(
	metrics: BillingMetrics,
	logger: BillingLogger,
	provider: "apple" | "google" | "stripe",
	error: unknown,
	message: string,
	projectKey: string,
): void {
	const code = billingErrorCode(error);
	safelyIncrementBillingMetric(metrics, "billing_webhook_failures_total", { provider, code });
	safelyIncrementBillingMetric(metrics, "billing_provider_operations_total", {
		provider,
		operation: "webhook",
		result: "failed",
		code,
	});
	safelyLogError(logger, message, error, { provider, code, projectKey });
}

function billingErrorCode(error: unknown): string {
	return isBillingError(error) ? error.code : "INTERNAL_ERROR";
}

function hasBearerToken(authorizationHeader: string | null): boolean {
	return /^Bearer\s+\S+$/i.test(authorizationHeader ?? "");
}

export const webhookContracts = {
	postV1ProjectsByProjectKeyWebhooksApple: defineContract(
		"post",
		"/v1/projects/:projectKey/webhooks/apple",
		{
			operationId: "postV1ProjectsByProjectKeyWebhooksApple",
			body: appleWebhookSchema,
			security: [],
			tags: ["webhook"],
			params: z.object({ projectKey: z.string().min(1) }),
			responses: {
				200: z.object({
					success: z.literal(true),
					data: AppleWebhookResultSchema,
				}),
			},
		},
	),
	postV1ProjectsByProjectKeyWebhooksGoogle: defineContract(
		"post",
		"/v1/projects/:projectKey/webhooks/google",
		{
			operationId: "postV1ProjectsByProjectKeyWebhooksGoogle",
			body: googleWebhookSchema,
			security: [{ googleOidc: [] }],
			tags: ["webhook"],
			params: z.object({ projectKey: z.string().min(1) }),
			responses: {
				200: z.object({
					success: z.literal(true),
					data: GoogleWebhookResultSchema,
				}),
			},
		},
	),
	postV1ProjectsByProjectKeyWebhooksStripe: defineContract(
		"post",
		"/v1/projects/:projectKey/webhooks/stripe",
		{
			operationId: "postV1ProjectsByProjectKeyWebhooksStripe",
			body: z
				.object({
					id: z.string(),
					type: z.string(),
					data: z.object({ object: z.record(z.string(), z.unknown()) }).loose(),
				})
				.loose(),
			requestContentType: "application/json",
			description:
				"Raw JSON bytes are verified with Stripe-Signature before parsing; send the original provider payload.",
			security: [{ stripeSignature: [] }],
			tags: ["webhook"],
			params: z.object({ projectKey: z.string().min(1) }),
			responses: {
				200: z.object({
					success: z.literal(true),
					data: z.object({
						status: z.enum(["processed", "skipped", "ignored"]),
						eventType: z.string(),
						entitlements: z.union([EntitlementSnapshotSchema, z.null()]),
					}),
				}),
			},
		},
	),
} as const;
