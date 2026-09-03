import { timingSafeEqual } from "node:crypto";

export type ApiProjectProjectionFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiProjectProjectionResponse {
	success: true;
}

export interface ProjectionSignatureHeadersInput {
	secret: string;
	body: string;
	now?: () => Date;
}

export interface ProjectionSignatureVerificationInput {
	secret: string;
	body: string;
	timestamp: string;
	signature: string;
	now?: () => Date;
	replayWindowMs?: number;
}

export const projectionSignatureReplayWindowMs = 5 * 60 * 1000;

export function createProjectionSignatureHeaders({
	secret,
	body,
	now = () => new Date(),
}: ProjectionSignatureHeadersInput): {
	"X-Billing-Timestamp": string;
	"X-Billing-Signature": string;
} {
	const timestamp = String(Math.floor(now().getTime() / 1000));
	return {
		"X-Billing-Timestamp": timestamp,
		"X-Billing-Signature": createProjectionSignature(secret, timestamp, body),
	};
}

export function verifyProjectionSignature({
	secret,
	body,
	timestamp,
	signature,
	now = () => new Date(),
	replayWindowMs = projectionSignatureReplayWindowMs,
}: ProjectionSignatureVerificationInput): boolean {
	const timestampSeconds = Number.parseInt(timestamp, 10);
	if (!Number.isSafeInteger(timestampSeconds) || String(timestampSeconds) !== timestamp) {
		return false;
	}

	const ageMs = Math.abs(now().getTime() - timestampSeconds * 1000);
	if (ageMs > replayWindowMs) {
		return false;
	}

	return constantTimeEquals(signature, createProjectionSignature(secret, timestamp, body));
}

function createProjectionSignature(secret: string, timestamp: string, body: string): string {
	const digest = new Bun.CryptoHasher("sha256", secret)
		.update(`${timestamp}.${body}`)
		.digest("hex");
	return `sha256=${digest}`;
}

function constantTimeEquals(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");

	if (actualBuffer.byteLength !== expectedBuffer.byteLength) {
		return false;
	}

	return timingSafeEqual(actualBuffer, expectedBuffer);
}
