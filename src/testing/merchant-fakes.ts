import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { MerchantEmail, MerchantMailer } from "../platform/email";

export class MerchantCaptureMailer implements MerchantMailer {
	readonly messages: MerchantEmail[] = [];
	failNext = false;
	async send(message: MerchantEmail): Promise<void> {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("Synthetic email delivery failure");
		}
		this.messages.push(message);
	}
	reset() {
		this.messages.length = 0;
		this.failNext = false;
	}
}
export interface FakeGoogleProfile {
	subject: string;
	email: string;
	name: string;
	verified: boolean;
	issuer?: string;
	nonce?: string;
	expiresIn?: number;
}
/** Process-local fake transport. Only the guarded test entrypoint and integration tests install it. */
export class FakeMerchantGoogle {
	private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	private readonly codes = new Map<
		string,
		{ challenge: string; redirect: string; nonce: string; profile: FakeGoogleProfile }
	>();
	readonly externalRequests: string[] = [];
	profile: FakeGoogleProfile = {
		subject: "synthetic-google-subject",
		email: "google@example.com",
		name: "Google Merchant",
		verified: true,
	};
	constructor(
		readonly clientId = "merchant-test-google-client",
		readonly clientSecret = "merchant-test-google-secret",
	) {}
	authorize(raw: string, cancelled = false): URL {
		const url = new URL(raw);
		const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
		callback.searchParams.set("state", url.searchParams.get("state") ?? "");
		if (cancelled) {
			callback.searchParams.set("error", "access_denied");
			return callback;
		}
		const code = randomBytes(32).toString("base64url");
		this.codes.set(code, {
			challenge: url.searchParams.get("code_challenge") ?? "",
			redirect: callback.origin + callback.pathname,
			nonce: url.searchParams.get("nonce") ?? "",
			profile: { ...this.profile },
		});
		callback.searchParams.set("code", code);
		return callback;
	}
	async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const request = new Request(input, init);
		const url = new URL(request.url);
		this.externalRequests.push(`${request.method} ${url.origin}${url.pathname}`);
		if (url.href === "https://www.googleapis.com/oauth2/v3/certs")
			return Response.json({
				keys: [
					{
						...this.keys.publicKey.export({ format: "jwk" }),
						kid: "merchant-test-key",
						alg: "RS256",
						use: "sig",
					},
				],
			});
		if (url.href !== "https://oauth2.googleapis.com/token")
			throw new Error(`Blocked external request to ${url.hostname}`);
		const body = new URLSearchParams(await request.text());
		const code = body.get("code") ?? "";
		const pending = this.codes.get(code);
		this.codes.delete(code);
		const basic = request.headers.get("authorization");
		const validClient =
			(body.get("client_id") === this.clientId &&
				body.get("client_secret") === this.clientSecret) ||
			basic === `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
		if (
			!pending ||
			!validClient ||
			body.get("redirect_uri") !== pending.redirect ||
			createHash("sha256")
				.update(body.get("code_verifier") ?? "")
				.digest("base64url") !== pending.challenge
		)
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		const now = Math.floor(Date.now() / 1000);
		const profile = pending.profile;
		const header = Buffer.from(
			JSON.stringify({ alg: "RS256", kid: "merchant-test-key", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				iss: profile.issuer ?? "https://accounts.google.com",
				aud: this.clientId,
				sub: profile.subject,
				email: profile.email,
				email_verified: profile.verified,
				name: profile.name,
				picture: "",
				iat: now,
				exp: now + (profile.expiresIn ?? 3600),
				nonce: profile.nonce ?? pending.nonce,
			}),
		).toString("base64url");
		const unsigned = `${header}.${payload}`;
		const signature = sign("RSA-SHA256", Buffer.from(unsigned), this.keys.privateKey).toString(
			"base64url",
		);
		return Response.json({
			access_token: "synthetic-google-access-token",
			token_type: "Bearer",
			expires_in: 3600,
			id_token: `${unsigned}.${signature}`,
			scope: "openid email profile",
		});
	}
	install(allowLoopback = false): () => void {
		const original = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (allowLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
					return original(input, init);
				return this.fetch(input, init);
			},
			{ preconnect: original.preconnect },
		);
		return () => {
			globalThis.fetch = original;
		};
	}
	reset() {
		this.codes.clear();
		this.externalRequests.length = 0;
	}
}
