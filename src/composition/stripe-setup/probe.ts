import { z } from "zod";
import type { ConnectionRepository } from "../../platform/connections/repository";
import type { StripeSetupStore } from "../../platform/connections/stripe-setup-store";
import type { ProjectInstanceContext } from "../../projects/context";
import { canonicalJson } from "../../shared/canonical-json";
import { setupStripeClient } from "./provider";

const probeSchema = z.object({
	id: z.string(),
	type: z.literal("product.updated"),
	created: z.number(),
	livemode: z.boolean(),
	data: z.object({
		object: z.object({
			id: z.string(),
			metadata: z.object({ quotum_setup_id: z.uuid(), quotum_setup_probe: z.uuid() }),
		}),
	}),
});

/** Called only by the regular HTTP handler, after Stripe signature verification, never replay. */
export function stripeSetupProbeObserver(
	store: StripeSetupStore,
	connections: ConnectionRepository,
	client = setupStripeClient,
) {
	return async (project: ProjectInstanceContext, value: unknown): Promise<void> => {
		const parsed = probeSchema.safeParse(value);
		if (!parsed.success) return;
		const event = parsed.data;
		const { quotum_setup_id: id, quotum_setup_probe: nonce } = event.data.object.metadata;
		const run = await store.find(id);
		if (
			!run ||
			run.project_instance_id !== project.projectInstanceId ||
			run.state.deliveryNonce !== nonce ||
			run.state.probeProductId !== event.data.object.id ||
			run.state.status === "complete"
		)
			return;
		const active = await connections.active(project.projectInstanceId, "stripe");
		if (
			!active ||
			active.version.id !== run.state.draftId ||
			event.livemode !== (project.environment === "production") ||
			Math.abs(Date.now() - event.created * 1000) > 300_000
		)
			return;
		const stripe = client(active.secrets.secretKey ?? "");
		const [account, canonical] = await Promise.all([
			stripe.accounts.retrieve(null),
			stripe.events.retrieve(event.id),
		]);
		const verified = probeSchema.safeParse(canonical);
		if (
			account.id !== active.version.external_identity ||
			!verified.success ||
			canonicalJson(verified.data) !== canonicalJson(event)
		)
			return;
		await store.observe(
			id,
			project.projectInstanceId,
			active.version.id,
			nonce,
			event.id,
			new Date(event.created * 1000),
		);
	};
}
