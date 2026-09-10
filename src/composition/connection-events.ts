import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import {
	createFixedWindowRateLimiter,
	rateLimitMiddleware,
	requestIpAndPath,
} from "../http/rate-limit";
import type { ConnectionRepository } from "../platform/connections/repository";
import { appleProjectConfigSchema, googlePlayProjectConfigSchema } from "../projects/config";
import { AppleStoreKitClient, buildAppleStoreKitConfig } from "../providers/apple/client";
import { buildGooglePlayConfig } from "../providers/google/config";
import { type GoogleOidcVerifier, verifyGooglePubSubPush } from "../providers/google/pubsub";
import { defineContract, registerRoute } from "../shared/http-contract";
import { PostgresProjectInstanceContextResolver } from "./project-instance-persistence";

export const connectionEventContract = defineContract(
	"post",
	"/v1/projects/:projectKey/connections/:versionId/webhooks/:provider",
	{
		operationId: "verifyConnectionEvent",
		tags: ["connection-events"],
		security: [{ stripeSignature: [] }, { googleOidc: [] }],
		params: z.object({
			projectKey: z.string(),
			versionId: z.uuid(),
			provider: z.enum(["stripe", "apple", "google"]),
		}),
		body: z.unknown(),
		responses: {
			200: z.object({ success: z.literal(true) }),
			400: z.object({ success: z.literal(false) }),
			404: z.object({ success: z.literal(false) }),
			413: z.object({ success: z.literal(false) }),
		},
	},
);
/** Setup-only ingress: verifies a single saved version, never executes billing or activates an instance. */
export function createConnectionEventApp(
	repository: ConnectionRepository,
	options: {
		stripeHttpClient?: NonNullable<Stripe.StripeConfig["httpClient"]>;
		googleOidcVerifier?: GoogleOidcVerifier;
	} = {},
) {
	const app = new Hono();
	app.use(
		"/v1/projects/:projectKey/connections/:versionId/webhooks/:provider",
		rateLimitMiddleware({
			limiter: createFixedWindowRateLimiter({ windowMs: 60_000, limit: 120, maxBuckets: 10_000 }),
			key: (c) => requestIpAndPath(c),
		}),
	);
	registerRoute(app, connectionEventContract, async (c) => {
		c.header("cache-control", "no-store");
		const provider = z.enum(["stripe", "apple", "google"]).safeParse(c.req.param("provider"));
		const versionId = z.uuid().safeParse(c.req.param("versionId"));
		if (!provider.success || !versionId.success) return c.json({ success: false }, 404);
		const reader = c.req.raw.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader)
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > 256 * 1024) {
					await reader.cancel();
					return c.json({ success: false }, 413);
				}
				chunks.push(next.value);
			}
		const body = Buffer.concat(chunks).toString("utf8");
		try {
			const lookup = await new PostgresProjectInstanceContextResolver().resolveInstanceKey(
				c.req.param("projectKey"),
			);
			if (
				lookup.kind !== "resolved" ||
				lookup.context.internalProject ||
				!["inactive", "active"].includes(lookup.context.lifecycleStatus)
			)
				return c.json({ success: false }, 404);
			const version = await repository.version(lookup.context.projectInstanceId, versionId.data);
			const connection = await repository.matchesKind(version.connection_id, provider.data);
			if (
				!connection ||
				!["draft", "validated", "active"].includes(version.status) ||
				(version.status !== "active" && version.expires_at <= new Date())
			)
				return c.json({ success: false }, 404);
			const secrets = await repository.secrets(version);
			let identity: string, occurred: number;
			if (provider.data === "stripe") {
				const stripe = new Stripe(
					secrets.secretKey ?? "",
					options.stripeHttpClient ? { httpClient: options.stripeHttpClient } : undefined,
				);
				const event = await stripe.webhooks.constructEventAsync(
					body,
					c.req.header("stripe-signature") ?? "",
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
				const result = options.googleOidcVerifier
					? await verifyGooglePubSubPush(
							{
								authorizationHeader: c.req.header("authorization") ?? null,
								body: JSON.parse(body),
							},
							config,
							options.googleOidcVerifier,
						)
					: await verifyGooglePubSubPush(
							{
								authorizationHeader: c.req.header("authorization") ?? null,
								body: JSON.parse(body),
							},
							config,
						);
				identity = config.packageName;
				occurred = Number(result.notification.eventTimeMillis);
			}
			if (!Number.isFinite(occurred) || Math.abs(Date.now() - occurred) > 300_000)
				throw new Error("Stale event");
			if (!(await repository.recordEvent(version, identity, new Date(occurred))))
				throw new Error("Connection changed");
			return c.json({ success: true });
		} catch {
			return c.json({ success: false }, 400);
		}
	});
	return app;
}
