import { describe, expect, it } from "bun:test";
import { BillingError } from "../../../src/billing/errors";
import type { GooglePlayConfig } from "../../../src/providers/google/config";
import { verifyGooglePubSubPush } from "../../../src/providers/google/pubsub";
import type { GoogleDeveloperNotification } from "../../../src/providers/google/types";

const config: GooglePlayConfig = {
	packageName: "com.voysee.app",
	serviceAccountCredentials: {
		client_email: "play-publisher@example.iam.gserviceaccount.com",
		private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
	},
	obfuscatedAccountIdSecret: "account-link-secret",
	previousObfuscatedAccountIdSecrets: [],
	rtdnAudience: "https://billing.example.com/v1/webhooks/google",
	rtdnServiceAccountEmail: "pubsub-push@example.iam.gserviceaccount.com",
	rtdnAuthorizedParty: "pubsub-push-client-id",
	enablePublisherMutations: true,
};

const notification: GoogleDeveloperNotification = {
	version: "1.0",
	packageName: "com.voysee.app",
	eventTimeMillis: "1780185600000",
	subscriptionNotification: {
		version: "1.0",
		notificationType: 4,
		purchaseToken: "purchase_token_1",
	},
};

const envelope = (data: string) => ({
	message: {
		data,
		messageId: "message_1",
	},
	subscription: "projects/test/subscriptions/google-rtdn",
});

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const validExp = 4_000_000_000;
const expiredExp = 1;
const validClaims = (overrides: Record<string, unknown> = {}) => ({
	aud: "https://billing.example.com/v1/webhooks/google",
	email: "pubsub-push@example.iam.gserviceaccount.com",
	email_verified: true,
	iss: "https://accounts.google.com",
	azp: "pubsub-push-client-id",
	exp: validExp,
	...overrides,
});

describe("Google Pub/Sub RTDN push verification", () => {
	it("rejects missing bearer tokens", async () => {
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: null, body: envelope(encode(notification)) },
				config,
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_UNAUTHORIZED" });
	});

	it("fails before decoding when OIDC token verification fails", async () => {
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer invalid", body: envelope("not-base64") },
				config,
				async () => {
					throw new Error("bad token");
				},
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_UNAUTHORIZED" });
	});

	it("rejects wrong token audience or service account email", async () => {
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
				config,
				async () => ({
					...validClaims(),
					aud: "wrong-audience",
				}),
			),
		).rejects.toThrow("Google Pub/Sub push token audience mismatch");

		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
				config,
				async () => ({
					...validClaims(),
					email: "wrong@example.iam.gserviceaccount.com",
				}),
			),
		).rejects.toThrow("Google Pub/Sub push token email mismatch");
	});

	it("rejects wrong token issuer, authorized party, or expiry", async () => {
		for (const [claims, message] of [
			[validClaims({ iss: "https://example.invalid" }), "issuer mismatch"],
			[validClaims({ azp: "wrong-client-id" }), "authorized party mismatch"],
			[validClaims({ exp: expiredExp }), "expired"],
		] as const) {
			await expect(
				verifyGooglePubSubPush(
					{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
					config,
					async () => claims,
				),
			).rejects.toThrow(`Google Pub/Sub push token ${message}`);
		}
	});

	it("decodes valid RTDN message data", async () => {
		const result = await verifyGooglePubSubPush(
			{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
			config,
			async () => validClaims(),
		);

		expect(result).toEqual({
			messageId: "message_1",
			externalEventId: "google:message_1",
			notification,
		});
	});

	it("accepts OIDC audience arrays containing the configured audience", async () => {
		const result = await verifyGooglePubSubPush(
			{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
			config,
			async () => ({
				...validClaims(),
				aud: ["https://other.example.com", "https://billing.example.com/v1/webhooks/google"],
			}),
		);

		expect(result.externalEventId).toBe("google:message_1");
	});

	it("rejects invalid base64 message data", async () => {
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope("not-base64") },
				config,
				async () => validClaims(),
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_INVALID_MESSAGE" });
	});

	it("rejects notifications for unexpected packages", async () => {
		const wrongPackage = { ...notification, packageName: "com.other.app" };

		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode(wrongPackage)) },
				config,
				async () => validClaims(),
			),
		).rejects.toThrow("Google Play RTDN package mismatch");
	});

	it("uses Pub/Sub message id as the idempotent external event id", async () => {
		const result = await verifyGooglePubSubPush(
			{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
			config,
			async () => validClaims(),
		);

		expect(result.externalEventId).toBe("google:message_1");
		expect(result.externalEventId).toBe(
			(
				await verifyGooglePubSubPush(
					{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
					config,
					async () => validClaims(),
				)
			).externalEventId,
		);
	});

	it("uses billing errors for invalid messages", async () => {
		await expect(
			verifyGooglePubSubPush({ authorizationHeader: "Bearer token", body: {} }, config, async () =>
				validClaims(),
			),
		).rejects.toBeInstanceOf(BillingError);
	});

	it("rejects unverified email, missing exp, and unconfigured RTDN audience", async () => {
		let verifierCalls = 0;
		const countingVerifier = async () => {
			verifierCalls += 1;
			return validClaims({ email_verified: false });
		};
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
				config,
				countingVerifier,
			),
		).rejects.toThrow("Google Pub/Sub push token email mismatch");
		expect(verifierCalls).toBe(1);

		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
				config,
				async () => validClaims({ exp: "later" }),
			),
		).rejects.toThrow("Google Pub/Sub push token expired");
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
				{ ...config, rtdnAudience: null },
				async () => {
					throw new Error("verifier should not run");
				},
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 500 });
	});

	it("accepts lowercase bearer and rejects other schemes", async () => {
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "bearer token", body: envelope(encode(notification)) },
				config,
				async () => validClaims(),
			),
		).resolves.toMatchObject({ messageId: "message_1" });
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Basic token", body: envelope(encode(notification)) },
				config,
				async () => validClaims(),
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_UNAUTHORIZED" });
	});

	it("rejects envelopes with the wrong number of notification keys or a blank message id", async () => {
		await expect(
			verifyGooglePubSubPush(
				{
					authorizationHeader: "Bearer token",
					body: envelope(encode({ ...notification, testNotification: { version: "1.0" } })),
				},
				config,
				async () => validClaims(),
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_INVALID_MESSAGE" });
		await expect(
			verifyGooglePubSubPush(
				{
					authorizationHeader: "Bearer token",
					body: envelope(
						encode({
							version: "1.0",
							packageName: "com.voysee.app",
							eventTimeMillis: "1",
						}),
					),
				},
				config,
				async () => validClaims(),
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_INVALID_MESSAGE" });
		await expect(
			verifyGooglePubSubPush(
				{
					authorizationHeader: "Bearer token",
					body: {
						message: { data: encode(notification), messageId: "   " },
						subscription: "projects/test/subscriptions/google-rtdn",
					},
				},
				config,
				async () => validClaims(),
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_INVALID_MESSAGE" });
	});

	it("accepts the short issuer form and rejects non-object notification data", async () => {
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode(notification)) },
				config,
				async () => validClaims({ iss: "accounts.google.com" }),
			),
		).resolves.toMatchObject({ messageId: "message_1" });
		await expect(
			verifyGooglePubSubPush(
				{ authorizationHeader: "Bearer token", body: envelope(encode([])) },
				config,
				async () => validClaims(),
			),
		).rejects.toMatchObject({ code: "GOOGLE_PLAY_RTDN_INVALID_MESSAGE" });
	});
});
