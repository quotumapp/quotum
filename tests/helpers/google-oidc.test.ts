import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
	createGoogleOidcTestKeys,
	createTestGoogleOidcVerifier,
	signGoogleOidcToken,
} from "./google-oidc";

const audience = "https://billing.example.com/v1/webhooks/google";
const now = Math.floor(Date.now() / 1000);

describe("Google OIDC helper", () => {
	it("accepts a valid signed token and rejects unknown, tampered, and claim errors", async () => {
		const { keys, kid, pem } = createGoogleOidcTestKeys();
		const verifier = createTestGoogleOidcVerifier(kid, pem);
		const claims = {
			iss: "https://accounts.google.com",
			aud: audience,
			iat: now - 10,
			exp: now + 300,
			email: "pubsub@example.com",
			email_verified: true,
		};
		const token = signGoogleOidcToken(keys.privateKey, claims, kid);
		await expect(verifier(token, audience)).resolves.toMatchObject({ aud: audience });

		const unknownKid = signGoogleOidcToken(keys.privateKey, claims, "other-kid");
		await expect(verifier(unknownKid, audience)).rejects.toThrow();

		const tampered = `${token.slice(0, -2)}aa`;
		await expect(verifier(tampered, audience)).rejects.toThrow();

		const futureIat = signGoogleOidcToken(keys.privateKey, { ...claims, iat: now + 3600 }, kid);
		await expect(verifier(futureIat, audience)).rejects.toThrow();

		const expired = signGoogleOidcToken(keys.privateKey, { ...claims, exp: now - 3600 }, kid);
		await expect(verifier(expired, audience)).rejects.toThrow();

		const wrongAud = signGoogleOidcToken(keys.privateKey, { ...claims, aud: "other" }, kid);
		await expect(verifier(wrongAud, audience)).rejects.toThrow();

		const wrongIss = signGoogleOidcToken(
			keys.privateKey,
			{ ...claims, iss: "https://example.invalid" },
			kid,
		);
		await expect(verifier(wrongIss, audience)).rejects.toThrow();

		const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const foreignToken = signGoogleOidcToken(foreign.privateKey, claims, kid);
		await expect(verifier(foreignToken, audience)).rejects.toThrow();
	});
});
