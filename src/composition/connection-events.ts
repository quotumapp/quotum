import { Elysia } from "elysia";
import Stripe from "stripe";
import { z } from "zod";
import { createFixedWindowRateLimiter } from "../http/rate-limit";
import type { ConnectionRepository } from "../platform/connections/repository";
import { appleProjectConfigSchema, googlePlayProjectConfigSchema } from "../projects/config";
import { AppleStoreKitClient, buildAppleStoreKitConfig } from "../providers/apple/client";
import { buildGooglePlayConfig } from "../providers/google/config";
import { type GoogleOidcVerifier, verifyGooglePubSubPush } from "../providers/google/pubsub";
import { HTTP_APP_CONFIG, operationDetail } from "../shared/http";
import { ipRateLimitGate, rawJsonResponse, readCappedRawBody } from "./ingress-http";
import { PostgresProjectInstanceContextResolver } from "./project-instance-persistence";

const CONNECTION_EVENT_PATH = "/v1/projects/:projectKey/connections/:versionId/webhooks/:provider";

const connectionEventParamsSchema = z.object({
	projectKey: z.string(),
	versionId: z.uuid(),
	provider: z.enum(["stripe", "apple", "google"]),
});

const connectionEventResponses = {
	200: z.object({ success: z.literal(true) }),
	400: z.object({ success: z.literal(false) }),
	404: z.object({ success: z.literal(false) }),
	413: z.object({ success: z.literal(false) }),
};

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
	} = {},
) {
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
					const event = await stripe.webhooks.constructEventAsync(
						body,
						request.headers.get("stripe-signature") ?? "",
						secrets.webhookSecret ?? "",
					);
					if (event.livemode !== (lookup.context.environment === "production"))
						throw new Error("Mode mismatch");
					const account = await stripe.accounts.retrieve(null);
					if (event.account && event.account !== account.id) throw new Error("Account mismatch");
					// Retrieving the signed event with this account's key proves that a foreign endpoint secret was not supplied.
					const canonical = await stripe.events.retrieve(event.id);
					if (canonical.id !== event.id || canonical.livemode !== event.livemode)
						throw new Error("Event mismatch");
					identity = account.id;
					occurred = event.created * 1000;
				} else if (provider.data === "apple") {
					const config = appleProjectConfigSchema.parse({ ...version.settings, ...secrets });
					const result = await new AppleStoreKitClient(
						buildAppleStoreKitConfig(config),
					).verifyNotification(
						z.object({ signedPayload: z.string() }).parse(JSON.parse(body)).signedPayload,
					);
					if (result.environment !== lookup.context.environment) throw new Error("Mode mismatch");
					identity = config.bundleId;
					occurred = Number(result.notification.signedDate);
				} else {
					const config = buildGooglePlayConfig(
						googlePlayProjectConfigSchema.parse({ ...version.settings, ...secrets }),
					);
					const result = await verifyGooglePubSubPush(
						{
							authorizationHeader: request.headers.get("authorization") ?? null,
							body: JSON.parse(body),
						},
						config,
						options.googleOidcVerifier,
					);
					identity = config.packageName;
					occurred = Number(result.notification.eventTimeMillis);
				}
				if (!Number.isFinite(occurred) || Math.abs(Date.now() - occurred) > 300_000)
					throw new Error("Stale event");
				if (!(await repository.recordEvent(version, identity, new Date(occurred))))
					throw new Error("Connection changed");
				return rawJsonResponse(200, { success: true });
			} catch {
				return rawJsonResponse(400, { success: false });
			}
		},
		{
			parse: "none",
			beforeHandle: ipRateLimitGate(limiter),
			detail: connectionEventDetail(),
		},
	);
	return app;
}
