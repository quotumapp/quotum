import type {
	SealedWebhookSecret,
	WebhookSecretScope,
	WebhookSecretSealer,
} from "../events/secret-sealer";
import { type ConnectionCipher, loadConnectionCipher } from "../platform/connections/cipher";

/** Distinct from connection secrets, so an envelope cannot be moved between the two tables. */
const webhookSecretLabel = "quotum-webhook-endpoint-v1";

/** Seals webhook signing secrets with the same deployment keys as connection secrets. */
export function createWebhookSecretSealer(cipher: ConnectionCipher): WebhookSecretSealer {
	const scopeOf = (scope: WebhookSecretScope) => ({
		label: webhookSecretLabel,
		instanceId: scope.projectId,
		connectionId: scope.endpointId,
		versionId: String(scope.generation),
		purpose: "signing",
	});
	return {
		activeKeyId: cipher.activeKeyId,
		seal: (secret, scope): SealedWebhookSecret => cipher.encrypt(secret, scopeOf(scope)),
		open: (envelope, scope) => {
			try {
				return cipher.decrypt(envelope, scopeOf(scope));
			} catch {
				throw new Error("Webhook endpoint secret is unavailable");
			}
		},
	};
}

/**
 * Loads the deployment keys on first use, so a process or test that never touches a webhook
 * endpoint needs no secrets key.
 */
export function lazyWebhookSecretSealer(
	load: () => ConnectionCipher = () => loadConnectionCipher(),
): () => WebhookSecretSealer {
	let sealer: WebhookSecretSealer | undefined;
	return () => {
		sealer ??= createWebhookSecretSealer(load());
		return sealer;
	};
}
