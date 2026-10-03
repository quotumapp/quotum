import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BillingError } from "../../billing/errors";
import type { PaddleClient } from "./client";
import type { PaddleConfig } from "./config";
import { paddleId } from "./schemas";

export const paddleRequiredEvents = [
	"transaction.completed",
	"transaction.canceled",
	"subscription.created",
	"subscription.updated",
	"subscription.activated",
	"subscription.trialing",
	"subscription.past_due",
	"subscription.paused",
	"subscription.resumed",
	"subscription.canceled",
	"adjustment.created",
	"adjustment.updated",
] as const;

const notificationSettingSchema = z.object({
	id: paddleId("ntfset"),
	type: z.literal("url"),
	destination: z.url(),
	active: z.literal(true),
	api_version: z.literal(1),
	endpoint_secret_key: z.string().min(1),
	traffic_source: z.enum(["platform", "all"]),
	subscribed_events: z.array(z.object({ name: z.string() })),
});

/** This proves access to one immutable resource in the seller account, not commercial eligibility. */
export async function validatePaddleConnection(input: {
	client: Pick<PaddleClient, "get">;
	config: PaddleConfig;
	webhookUrl: string;
}): Promise<{ accountAnchor: string; notificationSettingId: string }> {
	const response = await input.client.get(
		`/notification-settings/${input.config.notificationSettingId}`,
	);
	const parsed = notificationSettingSchema.safeParse(response.data);
	if (!parsed.success) throw invalid();
	const setting = parsed.data;
	const provided = Buffer.from(input.config.webhookSecret);
	const remote = Buffer.from(setting.endpoint_secret_key);
	if (
		setting.id !== input.config.notificationSettingId ||
		setting.destination !== input.webhookUrl ||
		provided.length !== remote.length ||
		!timingSafeEqual(provided, remote) ||
		paddleRequiredEvents.some(
			(name) => !setting.subscribed_events.some((event) => event.name === name),
		)
	)
		throw invalid();
	return { accountAnchor: `paddle:sandbox:${setting.id}`, notificationSettingId: setting.id };
}

function invalid(): BillingError {
	return new BillingError(
		"Paddle notification setting does not match this connection",
		"PADDLE_CONNECTION_INVALID",
		409,
	);
}
