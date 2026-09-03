import { OAuth2Client } from "google-auth-library";
import { BillingError } from "../../billing/errors";
import type { GooglePlayConfig } from "./config";
import type {
	GoogleDeveloperNotification,
	GooglePubSubPushEnvelope,
	VerifiedGoogleRtdn,
} from "./types";

export interface GoogleOidcClaims {
	aud?: unknown;
	email?: unknown;
	email_verified?: unknown;
	iss?: unknown;
	azp?: unknown;
	exp?: unknown;
}

export type GoogleOidcVerifier = (idToken: string, audience: string) => Promise<GoogleOidcClaims>;

const envelopeKeys = [
	"subscriptionNotification",
	"oneTimeProductNotification",
	"voidedPurchaseNotification",
	"testNotification",
] as const;

export async function verifyGooglePubSubPush(
	input: {
		authorizationHeader: string | null;
		body: unknown;
	},
	config: GooglePlayConfig,
	verifyOidcToken: GoogleOidcVerifier = verifyGoogleOidcToken,
): Promise<VerifiedGoogleRtdn> {
	await verifyGooglePubSubAuthorization(
		{ authorizationHeader: input.authorizationHeader },
		config,
		verifyOidcToken,
	);

	const envelope = parseEnvelope(input.body);
	const notification = parseNotification(envelope.message.data);

	if (notification.packageName !== config.packageName) {
		throw new BillingError(
			"Google Play RTDN package mismatch",
			"GOOGLE_PLAY_RTDN_INVALID_MESSAGE",
			400,
		);
	}

	return {
		messageId: envelope.message.messageId,
		externalEventId: `google:${envelope.message.messageId}`,
		notification,
	};
}

export async function verifyGooglePubSubAuthorization(
	input: { authorizationHeader: string | null },
	config: GooglePlayConfig,
	verifyOidcToken: GoogleOidcVerifier = verifyGoogleOidcToken,
): Promise<void> {
	const audience = requireRtdnConfig(config.rtdnAudience, "googlePlay.rtdnAudience");
	const serviceAccountEmail = requireRtdnConfig(
		config.rtdnServiceAccountEmail,
		"googlePlay.rtdnServiceAccountEmail",
	);
	const authorizedParty = requireRtdnConfig(
		config.rtdnAuthorizedParty,
		"googlePlay.rtdnAuthorizedParty",
	);
	const idToken = parseBearerToken(input.authorizationHeader);
	const claims = await verifyOidc(idToken, audience, verifyOidcToken);

	if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
		throw new BillingError(
			"Google Pub/Sub push token issuer mismatch",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}

	if (!matchesAudience(claims.aud, audience)) {
		throw new BillingError(
			"Google Pub/Sub push token audience mismatch",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}

	if (claims.email !== serviceAccountEmail || claims.email_verified !== true) {
		throw new BillingError(
			"Google Pub/Sub push token email mismatch",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}

	if (claims.azp !== authorizedParty) {
		throw new BillingError(
			"Google Pub/Sub push token authorized party mismatch",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}

	if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
		throw new BillingError(
			"Google Pub/Sub push token expired",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}
}

function matchesAudience(claimAudience: unknown, audience: string): boolean {
	if (claimAudience === audience) {
		return true;
	}

	return Array.isArray(claimAudience) && claimAudience.includes(audience);
}

async function verifyOidc(
	idToken: string,
	audience: string,
	verifyOidcToken: GoogleOidcVerifier,
): Promise<GoogleOidcClaims> {
	try {
		return await verifyOidcToken(idToken, audience);
	} catch {
		throw new BillingError(
			"Google Pub/Sub push token is invalid",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}
}

async function verifyGoogleOidcToken(idToken: string, audience: string): Promise<GoogleOidcClaims> {
	const client = new OAuth2Client();
	const ticket = await client.verifyIdToken({ idToken, audience });
	return ticket.getPayload() ?? {};
}

function requireRtdnConfig(value: string | null, name: string): string {
	if (value === null) {
		throw new BillingError(`${name} is required for Google Play RTDN`, "INVALID_REQUEST", 500);
	}

	return value;
}

function parseBearerToken(authorizationHeader: string | null): string {
	if (authorizationHeader === null) {
		throw new BillingError(
			"Google Pub/Sub push token is required",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}

	const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1]) {
		throw new BillingError(
			"Google Pub/Sub push token is required",
			"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
			401,
		);
	}

	return match[1].trim();
}

function parseEnvelope(value: unknown): GooglePubSubPushEnvelope {
	if (typeof value !== "object" || value === null) {
		throw invalidMessage("Google Pub/Sub push body must be an object");
	}

	const envelope = value as GooglePubSubPushEnvelope;
	if (
		typeof envelope.subscription !== "string" ||
		typeof envelope.message !== "object" ||
		envelope.message === null ||
		typeof envelope.message.data !== "string" ||
		typeof envelope.message.messageId !== "string" ||
		envelope.message.messageId.trim() === ""
	) {
		throw invalidMessage("Google Pub/Sub push body is missing message data");
	}

	return envelope;
}

function parseNotification(data: string): GoogleDeveloperNotification {
	const decoded = decodeBase64Json(data);

	if (typeof decoded !== "object" || decoded === null) {
		throw invalidMessage("Google Play RTDN payload must be an object");
	}

	const notification = decoded as GoogleDeveloperNotification;
	const populatedEnvelopeKeys = envelopeKeys.filter((key) => notification[key] !== undefined);

	if (
		typeof notification.version !== "string" ||
		typeof notification.packageName !== "string" ||
		typeof notification.eventTimeMillis !== "string" ||
		populatedEnvelopeKeys.length !== 1
	) {
		throw invalidMessage("Google Play RTDN payload is invalid");
	}

	return notification;
}

function decodeBase64Json(data: string): unknown {
	if (!isBase64(data)) {
		throw invalidMessage("Google Pub/Sub message data is not valid base64");
	}

	try {
		return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
	} catch {
		throw invalidMessage("Google Pub/Sub message data is not valid JSON");
	}
}

function isBase64(value: string): boolean {
	return value.length > 0 && value.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function invalidMessage(message: string): BillingError {
	return new BillingError(message, "GOOGLE_PLAY_RTDN_INVALID_MESSAGE", 400);
}
