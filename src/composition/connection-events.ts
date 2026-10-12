import { Elysia } from "elysia";
import Stripe from "stripe";
import { z } from "zod";
import { createFixedWindowRateLimiter } from "../http/rate-limit";
import {
	type BillingLogger,
	createNoopBillingLogger,
	safelyLogWarn,
} from "../observability/logger";
import type { ConnectionRepository } from "../platform/connections/repository";
import { appleProjectConfigSchema, googlePlayProjectConfigSchema } from "../projects/config";
import { AppleStoreKitClient, buildAppleStoreKitConfig } from "../providers/apple/client";
import { buildGooglePlayConfig } from "../providers/google/config";
import { type GoogleOidcVerifier, verifyGooglePubSubPush } from "../providers/google/pubsub";
import { HTTP_APP_CONFIG, operationDetail } from "../shared/http";
import { ipRateLimitGate, rawJsonResponse, readCappedRawBody } from "./ingress-http";
import { PostgresProjectInstanceContextResolver } from "./project-instance-persistence";
import { stripeErrorStatus } from "./stripe-connection-validation";

const CONNECTION_EVENT_PATH = "/v1/projects/:projectKey/connections/:versionId/webhooks/:provider";

const connectionEventParamsSchema = z.object({
	projectKey: z.string(),
	versionId: z.uuid(),
	provider: z.enum(["stripe", "apple", "google"]),
});

/**
 * Why a signed event was refused, for the operator who sent it. A reason is returned only for a
 * failure after the project, version and provider matched, so an unknown or expired version stays
 * an indistinguishable 404 and nothing here names a secret or a provider message.
 */
const refusalReasons = [
	"signature_invalid",
	"verification_failed",
	"mode_mismatch",
	"account_mismatch",
	"event_not_found",
	"event_mismatch",
	"stale_event",
	"missing_permission",
	"authentication_failed",
	"provider_unavailable",
	"connection_changed",
] as const;
type RefusalReason = (typeof refusalReasons)[number];

/** The Stripe permission whose absence a 403 on the verifying calls names. */
const refusalPermissions = ["event_read", "connected_account_read"] as const;
type RefusalPermission = (typeof refusalPermissions)[number];

const connectionEventResponses = {
	200: z.object({ success: z.literal(true) }),
	400: z.object({
		success: z.literal(false),
		reason: z.enum(refusalReasons).optional(),
		missingPermission: z.enum(refusalPermissions).optional(),
	}),
	404: z.object({ success: z.literal(false) }),
	413: z.object({ success: z.literal(false) }),
};

class EventRefusal extends Error {
	constructor(
		readonly reason: RefusalReason,
		readonly detail: {
			missingPermission?: RefusalPermission;
			httpStatus?: number;
			requestId?: string;
		} = {},
	) {
		super(reason);
	}
}

/**
 * Runs one Stripe call made with the connection's key and turns its failure into a refusal. `step`
 * says which call, and so which permission a 403 means and whether a 404 is a missing event.
 */
async function stripeCall<T>(step: "account" | "event", call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		const httpStatus = stripeErrorStatus(error);
		const requestId = (error as { requestId?: unknown } | null)?.requestId;
		const detail = { httpStatus, requestId: typeof requestId === "string" ? requestId : undefined };
		if (httpStatus === 403)
			throw new EventRefusal("missing_permission", {
				...detail,
				missingPermission: step === "event" ? "event_read" : "connected_account_read",
			});
		if (httpStatus === 404 && step === "event") throw new EventRefusal("event_not_found", detail);
		if (httpStatus === 401) throw new EventRefusal("authentication_failed", detail);
		throw new EventRefusal("provider_unavailable", detail);
	}
}

/** OpenAPI metadata for the setup-only connection event ingress. */
export function connectionEventDetail(): Record<string, unknown> {
	return operationDetail({
		operationId: "verifyConnectionEvent",
		tags: ["connection-events"],
		path: CONNECTION_EVENT_PATH,
		security: [{ stripeSignature: [] }, { googleOidc: [] }],
		responses: connectionEventResponses,
		request: { params: connectionEventParamsSchema, body: z.unknown() },
	});
}

/** Setup-only ingress: verifies a single saved version, never executes billing or activates an instance. */
export function createConnectionEventApp(
	repository: ConnectionRepository,
	options: {
		stripeHttpClient?: NonNullable<Stripe.StripeConfig["httpClient"]>;
		googleOidcVerifier?: GoogleOidcVerifier;
		trustProxyHeaders?: boolean;
		/** Receives one warning per refused event, with the reason and no provider message. */
		logger?: BillingLogger;
	} = {},
) {
	const logger = options.logger ?? createNoopBillingLogger();
	const limiter = createFixedWindowRateLimiter({
		windowMs: 60_000,
		limit: 120,
		maxBuckets: 10_000,
	});
	const app = new Elysia(HTTP_APP_CONFIG);
	app.post(
		CONNECTION_EVENT_PATH,
		async ({ params, request, set }) => {
			set.headers["cache-control"] = "no-store";
			const provider = z.enum(["stripe", "apple", "google"]).safeParse(params.provider);
			const versionId = z.uuid().safeParse(params.versionId);
			if (!provider.success || !versionId.success) return rawJsonResponse(404, { success: false });
			const read = await readCappedRawBody(request, 256 * 1024);
			if ("tooLarge" in read) return rawJsonResponse(413, { success: false });
			const body = read.body;
			try {
				const lookup = await new PostgresProjectInstanceContextResolver().resolveInstanceKey(
					params.projectKey,
				);
				if (
					lookup.kind !== "resolved" ||
					lookup.context.internalProject ||
					!["inactive", "active"].includes(lookup.context.lifecycleStatus)
				)
					return rawJsonResponse(404, { success: false });
				const version = await repository.version(lookup.context.projectInstanceId, versionId.data);
				const connection = await repository.matchesKind(version.connection_id, provider.data);
				if (
					!connection ||
					!["draft", "validated", "active"].includes(version.status) ||
					(version.status !== "active" && version.expires_at <= new Date())
				)
					return rawJsonResponse(404, { success: false });
				const secrets = await repository.secrets(version);
				let identity: string, occurred: number;
				if (provider.data === "stripe") {
					const stripe = new Stripe(
						secrets.secretKey ?? "",
						options.stripeHttpClient ? { httpClient: options.stripeHttpClient } : undefined,
					);
					let event: Stripe.Event;
					try {
						event = await stripe.webhooks.constructEventAsync(
							body,
							request.headers.get("stripe-signature") ?? "",
							secrets.webhookSecret ?? "",
						);
					} catch {
						throw new EventRefusal("signature_invalid");
					}
					if (event.livemode !== (lookup.context.environment === "production"))
						throw new EventRefusal("mode_mismatch");
					const account = await stripeCall("account", () => stripe.accounts.retrieve(null));
					if (event.account && event.account !== account.id)
						throw new EventRefusal("account_mismatch");
					// Retrieving the signed event with this account's key proves that a foreign endpoint secret was not supplied.
					const canonical = await stripeCall("event", () => stripe.events.retrieve(event.id));
					if (canonical.id !== event.id || canonical.livemode !== event.livemode)
						throw new EventRefusal("event_mismatch");
					identity = account.id;
					occurred = event.created * 1000;
				} else if (provider.data === "apple") {
					const config = appleProjectConfigSchema.parse({ ...version.settings, ...secrets });
					let result: Awaited<ReturnType<AppleStoreKitClient["verifyNotification"]>>;
					try {
						result = await new AppleStoreKitClient(
							buildAppleStoreKitConfig(config),
						).verifyNotification(
							z.object({ signedPayload: z.string() }).parse(JSON.parse(body)).signedPayload,
						);
					} catch {
						throw new EventRefusal("verification_failed");
					}
					if (result.environment !== lookup.context.environment)
						throw new EventRefusal("mode_mismatch");
					identity = config.bundleId;
					occurred = Number(result.notification.signedDate);
				} else {
					const config = buildGooglePlayConfig(
						googlePlayProjectConfigSchema.parse({ ...version.settings, ...secrets }),
					);
					let result: Awaited<ReturnType<typeof verifyGooglePubSubPush>>;
					try {
						result = await verifyGooglePubSubPush(
							{
								authorizationHeader: request.headers.get("authorization") ?? null,
								body: JSON.parse(body),
							},
							config,
							options.googleOidcVerifier,
						);
					} catch {
						throw new EventRefusal("verification_failed");
					}
					identity = config.packageName;
					occurred = Number(result.notification.eventTimeMillis);
				}
				if (!Number.isFinite(occurred) || Math.abs(Date.now() - occurred) > 300_000)
					throw new EventRefusal("stale_event");
				if (!(await repository.recordEvent(version, identity, new Date(occurred))))
					throw new EventRefusal("connection_changed");
				return rawJsonResponse(200, { success: true });
			} catch (error) {
				if (error instanceof EventRefusal) {
					const { missingPermission, httpStatus, requestId } = error.detail;
					safelyLogWarn(logger, "Connection event refused", {
						provider: provider.data,
						versionId: versionId.data,
						reason: error.reason,
						...(missingPermission ? { missingPermission } : {}),
						...(httpStatus === undefined ? {} : { httpStatus }),
						...(requestId ? { stripeRequestId: requestId } : {}),
					});
					return rawJsonResponse(400, {
						success: false,
						reason: error.reason,
						...(missingPermission ? { missingPermission } : {}),
					});
				}
				// A lookup, expiry or stored-configuration failure: the caller learns nothing more.
				safelyLogWarn(logger, "Connection event could not be verified", {
					provider: provider.data,
					versionId: versionId.data,
					errorName: error instanceof Error ? error.name : "unknown",
				});
				return rawJsonResponse(400, { success: false });
			}
		},
		{
			parse: "none",
			beforeHandle: ipRateLimitGate(limiter, {
				trustProxyHeaders: options.trustProxyHeaders,
				boundedParams: { provider: ["stripe", "apple", "google"] },
			}),
			detail: connectionEventDetail(),
		},
	);
	return app;
}
