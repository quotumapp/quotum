import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEquals } from "../shared/constant-time-equals";

/**
 * Webhook signatures follow the Standard Webhooks specification (https://www.standardwebhooks.com):
 * the signed content is `${webhookId}.${timestamp}.${body}`, the key is the base64 part of a
 * `whsec_` secret, and `webhook-signature` lists one `v1,<base64 HMAC-SHA256>` per signing secret,
 * separated by spaces. Receivers can verify with any Standard Webhooks library.
 */
export const webhookSecretPrefix = "whsec_";

/** How far a receiver should let `webhook-timestamp` drift before refusing a delivery. */
export const webhookTimestampToleranceSeconds = 5 * 60;

const secretPattern = /^whsec_[A-Za-z0-9+/]{43}=$/;

/** A new signing secret: 32 random bytes. */
export function generateWebhookSecret(): string {
	return `${webhookSecretPrefix}${randomBytes(32).toString("base64")}`;
}

export function isWebhookSecret(value: string): boolean {
	return secretPattern.test(value);
}

function secretKey(secret: string): Buffer {
	if (!secret.startsWith(webhookSecretPrefix))
		throw new Error("A webhook secret starts with whsec_");
	const key = Buffer.from(secret.slice(webhookSecretPrefix.length), "base64");
	if (key.length === 0) throw new Error("A webhook secret has no key");
	return key;
}

function signature(secret: string, webhookId: string, timestamp: string, body: string): string {
	const digest = createHmac("sha256", secretKey(secret))
		.update(`${webhookId}.${timestamp}.${body}`)
		.digest("base64");
	return `v1,${digest}`;
}

export interface WebhookSignatureInput {
	webhookId: string;
	body: string;
	/** The current secret first; a secret a rotation replaced follows until it expires. */
	secrets: readonly string[];
	now?: () => Date;
}

/** The three Standard Webhooks headers for one delivery attempt. */
export function createWebhookHeaders({
	webhookId,
	body,
	secrets,
	now = () => new Date(),
}: WebhookSignatureInput): Record<
	"webhook-id" | "webhook-timestamp" | "webhook-signature",
	string
> {
	if (secrets.length === 0) throw new Error("A webhook delivery needs a signing secret");
	const timestamp = String(Math.floor(now().getTime() / 1000));
	return {
		"webhook-id": webhookId,
		"webhook-timestamp": timestamp,
		"webhook-signature": secrets
			.map((secret) => signature(secret, webhookId, timestamp, body))
			.join(" "),
	};
}

export interface WebhookVerificationInput {
	secret: string;
	body: string;
	webhookId: string;
	timestamp: string;
	/** The `webhook-signature` header: one or more space-separated `v1,<base64>` signatures. */
	signature: string;
	now?: () => Date;
	toleranceSeconds?: number;
}

/**
 * Whether a delivery was signed with `secret` within the tolerance window. A receiver verifies the
 * raw request body, before parsing it.
 */
export function verifyWebhookSignature({
	secret,
	body,
	webhookId,
	timestamp,
	signature: header,
	now = () => new Date(),
	toleranceSeconds = webhookTimestampToleranceSeconds,
}: WebhookVerificationInput): boolean {
	const seconds = Number.parseInt(timestamp, 10);
	if (!Number.isSafeInteger(seconds) || String(seconds) !== timestamp) return false;
	if (Math.abs(now().getTime() / 1000 - seconds) > toleranceSeconds) return false;
	let expected: string;
	try {
		expected = signature(secret, webhookId, timestamp, body);
	} catch {
		return false;
	}
	return header
		.split(" ")
		.filter((candidate) => candidate.startsWith("v1,"))
		.some((candidate) => constantTimeEquals(candidate, expected));
}
