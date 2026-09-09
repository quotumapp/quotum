import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { BillingRepository } from "../db/repository";
import {
	createFixedWindowRateLimiter,
	rateLimitMiddleware,
	requestIpAndPath,
} from "../http/rate-limit";
import type { StripeOAuthPort } from "../platform/connections/oauth-port";
import type { ConnectionRepository } from "../platform/connections/repository";
import { StripeAppEvents } from "../platform/connections/stripe-events";
import { buildStripeConfig, StripeBillingClient } from "../providers/stripe/client";
import { StripeBillingService } from "../providers/stripe/service";
import { defineContract, registerRoute } from "../shared/http-contract";
import { createRuntimeConnectionResolver } from "./connections";
import { PostgresProjectInstanceContextResolver } from "./project-instance-persistence";
export const stripeAppEventContract = defineContract("post", "/v1/stripe-app/webhooks/:mode", {
	operationId: "stripeAppWebhook",
	tags: ["connection-events"],
	security: [{ stripeSignature: [] }],
	params: z.object({ mode: z.enum(["test", "live"]) }),
	body: z.unknown(),
	responses: {
		200: z.object({ success: z.literal(true) }),
		400: z.object({ success: z.literal(false) }),
		413: z.object({ success: z.literal(false) }),
	},
});
export function createStripeAppEvents(repository: ConnectionRepository, oauth: StripeOAuthPort) {
	const events = new StripeAppEvents(repository.sql);
	const resolver = new PostgresProjectInstanceContextResolver();
	const connections = createRuntimeConnectionResolver(repository);
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
	const app = new Hono();
	app.use(
		"/v1/stripe-app/webhooks/:mode",
		rateLimitMiddleware({
			limiter: createFixedWindowRateLimiter({ windowMs: 60_000, limit: 120, maxBuckets: 10_000 }),
			key: (c) => requestIpAndPath(c),
		}),
	);
	registerRoute(app, stripeAppEventContract, async (c) => {
		const mode = z.enum(["test", "live"]).safeParse(c.req.param("mode"));
		if (!mode.success) return c.json({ success: false }, 400);
		const reader = c.req.raw.body?.getReader();
		let size = 0;
		const chunks: Uint8Array[] = [];
		if (reader)
			for (;;) {
				const value = await reader.read();
				if (value.done) break;
				size += value.value.byteLength;
				if (size > 256 * 1024) {
					await reader.cancel();
					return c.json({ success: false }, 413);
				}
				chunks.push(value.value);
			}
		try {
			const stripe = new Stripe("sk_test_signature_verification_only");
			const event = await stripe.webhooks.constructEventAsync(
				Buffer.concat(chunks).toString("utf8"),
				c.req.header("stripe-signature") ?? "",
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
			return c.json({ success: true });
		} catch {
			return c.json({ success: false }, 400);
		}
	});
	return { app, runOnce };
}
