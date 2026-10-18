/**
 * Seals webhook signing secrets at rest with the deployment's secrets key. Composition implements
 * it over the connection cipher; the sealing context names the project, the endpoint and the
 * secret's generation, so an envelope cannot be moved to another endpoint or generation.
 */
export interface SealedWebhookSecret {
	keyId: string;
	nonce: string;
	tag: string;
	ciphertext: string;
}

export interface WebhookSecretScope {
	projectId: string;
	endpointId: string;
	generation: number;
}

export interface WebhookSecretSealer {
	/** The key new envelopes are sealed with; a rotation re-seals envelopes with another one. */
	readonly activeKeyId: string;
	seal(secret: string, scope: WebhookSecretScope): SealedWebhookSecret;
	open(envelope: SealedWebhookSecret, scope: WebhookSecretScope): string;
}

export function isSealedWebhookSecret(value: unknown): value is SealedWebhookSecret {
	if (typeof value !== "object" || value === null) return false;
	const envelope = value as Record<string, unknown>;
	return ["keyId", "nonce", "tag", "ciphertext"].every(
		(field) => typeof envelope[field] === "string",
	);
}
