import { z } from "zod";
import { BillingError, isBillingError } from "../billing/errors";
import {
	type RateLimiter,
	rateLimitHeaders,
	rateLimitResponse,
	requestProjectIpAndPath,
} from "../http/rate-limit";
import { type BillingLogger, safelyLogError } from "../observability/logger";
import { type BillingMetrics, safelyIncrementBillingMetric } from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import { parseCappedJson, readCappedText } from "../shared/body-limit";
import { operationDetail } from "../shared/http";
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
import type {
	BillingElysia,
	PreAuthGate,
	PreAuthGateInput,
	ProjectProviderServiceResolver,
} from "./types";

const publicWebhookMaxBodyBytes = 256 * 1024;

const WEBHOOK_PATH_PATTERN = /^\/v1\/projects\/([^/]+)\/webhooks\/(apple|google|stripe)$/;

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

const stripeWebhookSchema = z
	.object({
		id: z.string(),
		type: z.string(),
		data: z.object({ object: z.record(z.string(), z.unknown()) }).loose(),
	})
	.loose();

const tooLargeError = (): BillingError =>
	new BillingError("Request body is too large", "REQUEST_BODY_TOO_LARGE", 413);

/** Pre-authentication limiter for provider webhooks, mirroring their historical middleware. */
export function webhookRateLimitPreAuthGate(
	limiter: RateLimiter,
	rateLimitKeyOptions: { trustProxyHeaders?: boolean },
): PreAuthGate {
	return {
		matches: (path) => WEBHOOK_PATH_PATTERN.test(path),
		gate({ request, path, server, set }: PreAuthGateInput) {
			const projectKey = WEBHOOK_PATH_PATTERN.exec(path)?.[1] ?? null;
			const result = limiter.check(
				requestProjectIpAndPath(
					{ request, path, server, projectKey },
					{ trustProxyHeaders: rateLimitKeyOptions.trustProxyHeaders },
				),
			);
			if (!result.allowed) {
				return rateLimitResponse(result);
			}
			Object.assign(set.headers, rateLimitHeaders(result));
			return undefined;
		},
	};
}

export function registerWebhookRoutes(input: {
	app: BillingElysia;
	contextResolver: ProjectInstanceContextResolver;
	registerPreAuthGate: (gate: PreAuthGate) => void;
	rateLimitKeyOptions: { trustProxyHeaders?: boolean };
	webhookLimiter: RateLimiter;
	providerServices: ProjectProviderServiceResolver;
	billingMetrics: BillingMetrics;
	billingLogger: BillingLogger;
}): void {
	const {
		app,
		contextResolver,
		registerPreAuthGate,
		rateLimitKeyOptions,
		webhookLimiter,
		providerServices,
		billingMetrics,
		billingLogger,
	} = input;

	registerPreAuthGate(webhookRateLimitPreAuthGate(webhookLimiter, rateLimitKeyOptions));

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

		if (resolution.context.lifecycleStatus === "inactive")
			throw new BillingError(
				"This environment does not accept billing events",
				"ENVIRONMENT_INACTIVE",
				403,
			);
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
	const handleAppleWebhook = async (request: Request, project: ProjectInstanceContext) =>
		withWebhookFailureRecording("apple", "Apple webhook failed", project, async () => {
			const body = await parseCappedJson(request, publicWebhookMaxBodyBytes, tooLargeError);
			const parsed = appleWebhookSchema.safeParse(body);
			if (!parsed.success) {
				throw new BillingError("Invalid Apple webhook body", "INVALID_REQUEST", 400);
			}

			const result = await requireAppleStoreKitService(
				await providerServices.appleStoreKitService(project, "recovery"),
			).handleNotification(parsed.data);
			return { success: true as const, data: result };
		});
	const handleGoogleWebhook = async (request: Request, project: ProjectInstanceContext) =>
		withWebhookFailureRecording("google", "Google webhook failed", project, async () => {
			const authorizationHeader = request.headers.get("authorization") ?? null;
			if (!hasBearerToken(authorizationHeader)) {
				throw new BillingError(
					"Google Pub/Sub push token is required",
					"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
					401,
				);
			}

			const service = requireGooglePlayBillingService(
				await providerServices.googlePlayBillingService(project, "recovery"),
			);
			await service.verifyRtdnAuthorization?.(authorizationHeader);

			const body = await parseCappedJson(request, publicWebhookMaxBodyBytes, tooLargeError);
			const parsed = googleWebhookSchema.safeParse(body);
			if (!parsed.success) {
				throw new BillingError("Invalid Google webhook body", "INVALID_REQUEST", 400);
			}

			const result = await service.handleRtdn({
				authorizationHeader,
				body: parsed.data,
			});
			return { success: true as const, data: result };
		});
	const handleStripeWebhook = async (request: Request, project: ProjectInstanceContext) =>
		withWebhookFailureRecording("stripe", "Stripe webhook failed", project, async () => {
			const rawBody = await readCappedText(request, publicWebhookMaxBodyBytes, tooLargeError);
			const result = await requireStripeBillingService(
				await providerServices.stripeBillingService(project, "recovery"),
			).handleWebhook({
				rawBody,
				signatureHeader: request.headers.get("stripe-signature") ?? null,
			});
			return { success: true as const, data: result };
		});

	app.post(
		"/v1/projects/:projectKey/webhooks/apple",
		async ({ params, request }) =>
			handleAppleWebhook(request, await webhookProject(params.projectKey)),
		{
			parse: "none",
			params: z.object({ projectKey: z.string().min(1) }),
			detail: operationDetail({
				operationId: "postV1ProjectsByProjectKeyWebhooksApple",
				tags: ["webhook"],
				path: "/v1/projects/:projectKey/webhooks/apple",
				security: [],
				responses: {
					200: z.object({ success: z.literal(true), data: AppleWebhookResultSchema }),
				},
				request: { body: appleWebhookSchema },
			}),
		},
	);

	app.post(
		"/v1/projects/:projectKey/webhooks/google",
		async ({ params, request }) =>
			handleGoogleWebhook(request, await webhookProject(params.projectKey)),
		{
			parse: "none",
			params: z.object({ projectKey: z.string().min(1) }),
			detail: operationDetail({
				operationId: "postV1ProjectsByProjectKeyWebhooksGoogle",
				tags: ["webhook"],
				path: "/v1/projects/:projectKey/webhooks/google",
				security: [{ googleOidc: [] }],
				responses: {
					200: z.object({ success: z.literal(true), data: GoogleWebhookResultSchema }),
				},
				request: { body: googleWebhookSchema },
			}),
		},
	);

	app.post(
		"/v1/projects/:projectKey/webhooks/stripe",
		async ({ params, request }) =>
			handleStripeWebhook(request, await webhookProject(params.projectKey)),
		{
			parse: "none",
			params: z.object({ projectKey: z.string().min(1) }),
			detail: operationDetail({
				operationId: "postV1ProjectsByProjectKeyWebhooksStripe",
				tags: ["webhook"],
				path: "/v1/projects/:projectKey/webhooks/stripe",
				description:
					"Raw JSON bytes are verified with Stripe-Signature before parsing; send the original provider payload.",
				security: [{ stripeSignature: [] }],
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
				request: { body: stripeWebhookSchema },
			}),
		},
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
