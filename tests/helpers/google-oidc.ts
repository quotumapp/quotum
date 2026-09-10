import { generateKeyPairSync, sign } from "node:crypto";
import { createGoogleOidcVerifier } from "../../src/providers/google/pubsub";

export function createGoogleOidcTestKeys() {
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = "quotum-test-google-oidc";
	const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
	return { keys, kid, pem };
}

export function signGoogleOidcToken(
	privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
	claims: Record<string, unknown>,
	kid: string,
): string {
	const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString(
		"base64url",
	);
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const unsigned = `${header}.${payload}`;
	const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey as never).toString(
		"base64url",
	);
	return `${unsigned}.${signature}`;
}

export function googleOidcCertFetch(kid: string, pem: string): typeof fetch {
	return Object.assign(
		async (input: URL | RequestInfo) => {
			const url = String(input);
			if (url === "https://www.googleapis.com/oauth2/v1/certs") {
				return new Response(JSON.stringify({ [kid]: pem }), {
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		},
		{ preconnect: fetch.preconnect },
	);
}

export function createTestGoogleOidcVerifier(kid: string, pem: string) {
	return createGoogleOidcVerifier(googleOidcCertFetch(kid, pem));
}
