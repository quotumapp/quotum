import { Elysia } from "elysia";
import Stripe from "stripe";
import { z } from "zod";
import { BillingRepository } from "../db/repository";
import { createFixedWindowRateLimiter } from "../http/rate-limit";
import type { StripeOAuthPort } from "../platform/connections/oauth-port";
import type { ConnectionRepository } from "../platform/connections/repository";
import { StripeAppEvents } from "../platform/connections/stripe-events";
import type { MerchantSql } from "../platform/database";
import { buildStripeConfig, StripeBillingClient } from "../providers/stripe/client";
import { StripeBillingService } from "../providers/stripe/service";
import { HTTP_APP_CONFIG, operationDetail } from "../shared/http";
import { createRuntimeConnectionResolver } from "./connections";
import { ipRateLimitGate, rawJsonResponse, readCappedRawBody } from "./ingress-http";
import { PostgresProjectInstanceContextResolver } from "./project-instance-persistence";

const STRIPE_APP_EVENT_PATH = "/v1/stripe-app/webhooks/:mode";

/** OpenAPI metadata for the Stripe app webhook durable inbox. */
export function stripeAppEventDetail(): Record<string, unknown> {
	return operationDetail({
		operationId: "stripeAppWebhook",
		tags: ["connection-events"],
		path: STRIPE_APP_EVENT_PATH,
		security: [{ stripeSignature: [] }],
		responses: {
			200: z.object({ success: z.literal(true) }),
			400: z.object({ success: z.literal(false) }),
			413: z.object({ success: z.literal(false) }),
		},
		request: {
			params: z.object({ mode: z.enum(["test", "live"]) }),
			body: z.unknown(),
		},
	});
}

export function createStripeAppEvents(
	repository: ConnectionRepository,
	oauth: StripeOAuthPort,
	persistence: MerchantSql,
	options: { trustProxyHeaders?: boolean } = {},
) {
	const events = new StripeAppEvents(persistence);
	const resolver = new PostgresProjectInstanceContextResolver();
	const connections = createRuntimeConnectionResolver(repository, persistence);
	const billing = new BillingRepository();
	const runOnce = async () => {
		for (const event of await events.pending()) {
			const mapping = await events.mapping(event.account_id, event.livemode);
			if (!mapping) continue; // Quarantined until a unique account/mode connection exists.
			try {
				const lookup = await resolver.resolveInstanceId(mapping.project_instance_id);
				if (lookup.kind !== "resolved" || lookup.context.internalProject) continue;
				if (
					event.payload.type !== "account.application.deauthorized" &&
					typeof event.payload.created === "number" &&
					Number.isFinite(event.payload.created)
				)
					await events.verified(
						mapping.id,
						mapping.active_version_id,
						new Date(event.payload.created * 1000),
					);
				if (event.payload.type === "account.application.deauthorized")
					await events.deauthorize(mapping.id);
				else if (lookup.context.lifecycleStatus !== "inactive") {
					const config = await connections.resolve(lookup.context, "stripe", "recovery");
					if (!config || config.connectedAccountId !== event.account_id) continue;
					const service = new StripeBillingService({
						config: {
							...config,
							projectKey: lookup.context.projectInstanceKey,
							projectionContract: "billing_state_v1",
						},
						client: new StripeBillingClient(buildStripeConfig(config)),
						repository: billing.forProject(lookup.context),
					});
					await service.handleVerifiedAppEvent(event.payload);
				}
				await events.processed(event.event_id);
			} catch {
				await events.defer(event.event_id);
			}
		}
	};
	const limiter = createFixedWindowRateLimiter({
		windowMs: 60_000,
		limit: 120,
		maxBuckets: 10_000,
	});
	const app = new Elysia(HTTP_APP_CONFIG);
	app.post(
		STRIPE_APP_EVENT_PATH,
		async ({ params, request }) => {
			const mode = z.enum(["test", "live"]).safeParse(params.mode);
			if (!mode.success) return rawJsonResponse(400, { success: false });
			const read = await readCappedRawBody(request, 256 * 1024);
			if ("tooLarge" in read) return rawJsonResponse(413, { success: false });
			try {
				const stripe = new Stripe("sk_test_signature_verification_only");
				const event = await stripe.webhooks.constructEventAsync(
					read.body,
					request.headers.get("stripe-signature") ?? "",
					oauth.webhookSecret(mode.data === "live" ? "production" : "sandbox"),
				);
				if (!event.account || event.livemode !== (mode.data === "live"))
					throw new Error("Account required");
				await events.accept({
					event_id: event.id,
					account_id: event.account,
					livemode: event.livemode,
					payload: JSON.parse(JSON.stringify(event)),
				});
				// Durable inbox polling performs provider work outside the webhook request.
				return rawJsonResponse(200, { success: true });
			} catch {
				return rawJsonResponse(400, { success: false });
			}
		},
		{
			parse: "none",
			beforeHandle: ipRateLimitGate(limiter, {
				trustProxyHeaders: options.trustProxyHeaders,
				boundedParams: { mode: ["test", "live"] },
			}),
			detail: stripeAppEventDetail(),
		},
	);
	return { app, runOnce };
}
