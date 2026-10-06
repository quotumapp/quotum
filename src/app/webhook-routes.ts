import { z } from "zod";
import { BillingError, isBillingError } from "../billing/errors";
import type { BillingProvider } from "../billing/types";
import {
	type RateLimiter,
	rateLimitHeaders,
	rateLimitResponse,
	requestIp,
	requestProjectIpAndPath,
} from "../http/rate-limit";
import { type BillingLogger, safelyLogError } from "../observability/logger";
import { type BillingMetrics, safelyIncrementBillingMetric } from "../observability/metrics";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import { appleSignedDataInvalid } from "../providers/apple/signed-data-errors";
import { parseCappedJson, readCappedText } from "../shared/body-limit";
import { operationDetail } from "../shared/http";
import {
	AppleWebhookResultSchema,
	EntitlementSnapshotSchema,
	GoogleWebhookResultSchema,
} from "./contracts/provider-responses";
import {
	appleStoreKitNotConfigured,
	googlePlayNotConfigured,
	paddleNotConfigured,
	stripeNotConfigured,
} from "./provider-services";
import type {
	BillingElysia,
	PreAuthGate,
	PreAuthGateInput,
	ProjectProviderServiceResolver,
} from "./types";

const publicWebhookMaxBodyBytes = 256 * 1024;

const WEBHOOK_PATH_PATTERN = /^\/v1\/projects\/([^/]+)\/webhooks\/(apple|google|stripe|paddle)$/;

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

/**
 * Pre-authentication limiters for provider webhooks. The per-IP limiter runs first: the project key
 * in the URL is unauthenticated, so it bounds how many project buckets one client can create per
 * window, and it rejects before any project lookup. The project limiter keeps each project's budget
 * per client IP and provider, since one provider address delivers for every project.
 */
export function webhookRateLimitPreAuthGate(
	limiters: { perIp: RateLimiter; perProject: RateLimiter },
	rateLimitKeyOptions: { trustProxyHeaders?: boolean },
): PreAuthGate {
	return {
		matches: (path) => WEBHOOK_PATH_PATTERN.test(path),
		gate({ request, path, server, set }: PreAuthGateInput) {
			const keyOptions = { trustProxyHeaders: rateLimitKeyOptions.trustProxyHeaders };
			const ipResult = limiters.perIp.check(requestIp({ request, server }, keyOptions));
			if (!ipResult.allowed) {
				return rateLimitResponse(ipResult);
			}
			const projectKey = WEBHOOK_PATH_PATTERN.exec(path)?.[1] ?? null;
			const result = limiters.perProject.check(
				requestProjectIpAndPath({ request, path, server, projectKey }, keyOptions),
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
	webhookIpLimiter: RateLimiter;
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
		webhookIpLimiter,
		providerServices,
		billingMetrics,
		billingLogger,
	} = input;

	registerPreAuthGate(
		webhookRateLimitPreAuthGate(
			{ perIp: webhookIpLimiter, perProject: webhookLimiter },
			rateLimitKeyOptions,
		),
	);

	/**
	 * A webhook path is public and its project key unauthenticated. An unknown key answers null, and
	 * each handler then tells the sender exactly what a sender that fails that provider's own
	 * verification is told, after the same body and header checks, so the answer never says whether
	 * a project key exists.
	 */
	const webhookProject = async (projectKey: string): Promise<ProjectInstanceContext | null> => {
		const resolution = await contextResolver.resolveInstanceKey(projectKey);
		if (resolution.kind === "unavailable") {
			throw new BillingError(
				"Billing project context is unavailable",
				"BILLING_PROJECT_CONTEXT_UNAVAILABLE",
				503,
			);
		}
		if (resolution.kind !== "resolved") return null;

		if (resolution.context.lifecycleStatus === "inactive")
			throw new BillingError(
				"This environment does not accept billing events",
				"ENVIRONMENT_INACTIVE",
				403,
			);
		return resolution.context;
	};
	const withWebhookFailureRecording = async <T>(
		provider: BillingProvider,
		message: string,
		project: ProjectInstanceContext,
		run: () => Promise<T>,
	): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			// A concealed failure is logged with its real reason and answered as a failed verification.
			const reason = error instanceof ConcealedWebhookFailure ? error.reason : error;
			recordWebhookFailure(
				billingMetrics,
				billingLogger,
				provider,
				reason,
				message,
				project.projectInstanceKey,
			);
			throw error instanceof ConcealedWebhookFailure ? error.answer : error;
		}
	};
	/** A project without this provider's connection answers like an unknown project key. */
	const connected = <T>(service: T | null, reason: () => BillingError, answer: BillingError): T => {
		if (service === null) throw new ConcealedWebhookFailure(reason(), answer);
		return service;
	};
	const readAppleNotification = async (request: Request) => {
		const body = await parseCappedJson(request, publicWebhookMaxBodyBytes, tooLargeError);
		const parsed = appleWebhookSchema.safeParse(body);
		if (!parsed.success) {
			throw new BillingError("Invalid Apple webhook body", "INVALID_REQUEST", 400);
		}
		return parsed.data;
	};
	const requireGoogleBearer = (request: Request): string => {
		const authorizationHeader = request.headers.get("authorization") ?? null;
		if (authorizationHeader === null || !hasBearerToken(authorizationHeader)) {
			throw new BillingError(
				"Google Pub/Sub push token is required",
				"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
				401,
			);
		}
		return authorizationHeader;
	};
	const handleAppleWebhook = async (request: Request, projectKey: string) => {
		const project = await webhookProject(projectKey);
		if (project === null) {
			await readAppleNotification(request);
			throw appleUnverified();
		}
		return withWebhookFailureRecording("apple", "Apple webhook failed", project, async () => {
			const notification = await readAppleNotification(request);
			const service = connected(
				await providerServices.appleStoreKitService(project, "recovery"),
				appleStoreKitNotConfigured,
				appleUnverified(),
			);
			const result = await service.handleNotification(notification);
			return { success: true as const, data: result };
		});
	};
	const handleGoogleWebhook = async (request: Request, projectKey: string) => {
		const project = await webhookProject(projectKey);
		if (project === null) {
			requireGoogleBearer(request);
			throw googleUnverified();
		}
		return withWebhookFailureRecording("google", "Google webhook failed", project, async () => {
			const authorizationHeader = requireGoogleBearer(request);
			const service = connected(
				await providerServices.googlePlayBillingService(project, "recovery"),
				googlePlayNotConfigured,
				googleUnverified(),
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
	};
	const handleStripeWebhook = async (request: Request, projectKey: string) => {
		const project = await webhookProject(projectKey);
		const signatureHeader = request.headers.get("stripe-signature") ?? null;
		if (project === null) {
			await readCappedText(request, publicWebhookMaxBodyBytes, tooLargeError);
			throw stripeUnverified(signatureHeader);
		}
		return withWebhookFailureRecording("stripe", "Stripe webhook failed", project, async () => {
			const rawBody = await readCappedText(request, publicWebhookMaxBodyBytes, tooLargeError);
			const service = connected(
				await providerServices.stripeBillingService(project, "recovery"),
				stripeNotConfigured,
				stripeUnverified(signatureHeader),
			);
			const result = await service.handleWebhook({ rawBody, signatureHeader });
			return { success: true as const, data: result };
		});
	};

	app.post(
		"/v1/projects/:projectKey/webhooks/paddle",
		async ({ params, request }) => {
			const project = await webhookProject(params.projectKey);
			const rawBody = await readCappedText(request, publicWebhookMaxBodyBytes, tooLargeError);
			const unverified = new BillingError(
				"Paddle webhook signature is invalid",
				"PADDLE_SIGNATURE_INVALID",
				400,
			);
			if (!project) throw unverified;
			return withWebhookFailureRecording("paddle", "Paddle webhook failed", project, async () => {
				const service = connected(
					(await providerServices.paddleBillingService?.(project, "recovery")) ?? null,
					paddleNotConfigured,
					unverified,
				);
				return {
					success: true,
					data: await service.handleWebhook({
						rawBody,
						signatureHeader: request.headers.get("paddle-signature"),
					}),
				};
			});
		},
		{
			parse: "none",
			params: z.object({ projectKey: z.string().min(1) }),
			detail: operationDetail({
				operationId: "postV1ProjectsByProjectKeyWebhooksPaddle",
				tags: ["webhook"],
				path: "/v1/projects/:projectKey/webhooks/paddle",
				security: [{ paddleSignature: [] }],
				description:
					"Verifies Paddle-Signature over capped raw bytes and stores the event for asynchronous processing.",
				request: { body: z.record(z.string(), z.unknown()) },
				responses: {
					200: z.object({
						success: z.literal(true),
						data: z.object({ status: z.literal("queued"), eventType: z.string() }),
					}),
				},
			}),
		},
	);

	app.post(
		"/v1/projects/:projectKey/webhooks/apple",
		async ({ params, request }) => handleAppleWebhook(request, params.projectKey),
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
		async ({ params, request }) => handleGoogleWebhook(request, params.projectKey),
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
		async ({ params, request }) => handleStripeWebhook(request, params.projectKey),
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
	provider: BillingProvider,
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

/**
 * A webhook failure answered as a failed verification: the sender learns nothing about the project,
 * while the log keeps the real reason.
 */
class ConcealedWebhookFailure extends Error {
	constructor(
		readonly reason: BillingError,
		readonly answer: BillingError,
	) {
		super(reason.message);
		this.name = "ConcealedWebhookFailure";
	}
}

/** What Stripe's signature check answers a sender it cannot verify. */
function stripeUnverified(signatureHeader: string | null): BillingError {
	return (signatureHeader ?? "").trim() === ""
		? new BillingError("Stripe signature must not be blank", "INVALID_REQUEST", 400)
		: new BillingError(
				"Stripe webhook signature is invalid",
				"STRIPE_WEBHOOK_SIGNATURE_INVALID",
				400,
			);
}

/** What Apple's notification verification answers a payload it cannot verify. */
function appleUnverified(): BillingError {
	return appleSignedDataInvalid("Apple signed data failed verification");
}

/** What the Pub/Sub token check answers a push token it cannot verify. */
function googleUnverified(): BillingError {
	return new BillingError(
		"Google Pub/Sub push token is invalid",
		"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
		401,
	);
}

function hasBearerToken(authorizationHeader: string | null): boolean {
	return /^Bearer\s+\S+$/i.test(authorizationHeader ?? "");
}
