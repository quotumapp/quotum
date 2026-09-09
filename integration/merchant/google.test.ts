import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { FakeMerchantGoogle } from "../../src/testing/merchant-fakes";
import { MerchantBrowser, merchantFixture, testConfig } from "./fixture";

const google = new FakeMerchantGoogle();
const f = merchantFixture({
	google: { clientId: google.clientId, clientSecret: google.clientSecret },
});
const restore = google.install();
beforeEach(async () => {
	await f.reset();
	google.reset();
	google.profile = {
		subject: "synthetic-google-subject",
		email: "google@example.com",
		name: "Google Merchant",
		verified: true,
	};
});
afterAll(async () => {
	restore();
	await f.sql.close();
});
async function oauth(browser: MerchantBrowser, signup = true, cancelled = false) {
	await browser.json("/api/platform/config");
	if (signup)
		await browser.json("/api/platform/signup-intent", {
			accepted: true,
			termsVersion: testConfig.termsVersion,
			privacyVersion: testConfig.privacyVersion,
		});
	const response = await browser.json<{ url: string }>("/api/auth/sign-in/social", {
		provider: "google",
		requestSignUp: signup,
		callbackURL: `${testConfig.origin}/auth/callback`,
		errorCallbackURL: `${testConfig.origin}/auth/error`,
	});
	const callback = google.authorize(response.url, cancelled);
	const result = await browser.request(`${callback.pathname}${callback.search}`);
	return { result, callback };
}
describe("Google OAuth using signed local provider tokens", () => {
	it("requires state, PKCE and verified nonce-bound Google identity, without email OTP", async () => {
		const browser = new MerchantBrowser(f);
		const { result, callback } = await oauth(browser);
		expect(result.status).toBe(302);
		expect(result.headers.get("location")).toBe(`${testConfig.origin}/auth/callback`);
		await browser.json("/api/platform/session/exchange", {});
		expect((await browser.json("/api/platform/session")).authMethod).toBe("google");
		expect((await f.sql`SELECT issuer FROM platform_external_identities`)[0].issuer).toBe(
			"https://accounts.google.com",
		);
		expect(f.mailer.messages.filter((message) => message.kind === "otp")).toHaveLength(0);
		const [account] =
			await f.sql`SELECT provider_id,account_id,access_token,id_token FROM platform_auth_accounts`;
		expect(account.provider_id).toBe("google");
		expect(account.account_id).toBe("synthetic-google-subject");
		expect(account.access_token).toBeNull();
		expect(account.id_token).toBeNull();
		const replay = await browser.request(`${callback.pathname}${callback.search}`);
		expect(replay.headers.get("location")).toContain("error=");
		expect(google.externalRequests.every((url) => url.includes("googleapis.com"))).toBe(true);
	});
	it("does not create an account on an implicit sign-in", async () => {
		const browser = new MerchantBrowser(f);
		const { result } = await oauth(browser, false);
		expect(result.headers.get("location")).toContain("error=");
		expect(await f.sql`SELECT id FROM platform_auth_users`).toHaveLength(0);
	});
	it("applies the shared daily signup email limit to verified Google callbacks", async () => {
		for (let attempt = 0; attempt < 3; attempt++)
			await f.store.rateLimit("signup:email:google@example.com", 3, 24 * 60 * 60_000);
		const { result } = await oauth(new MerchantBrowser(f));
		expect(result.headers.get("location")).toContain("error=");
		expect(await f.sql`SELECT id FROM platform_auth_users`).toHaveLength(0);
		expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);
	});
	it("does not add a password identity through Google account recovery", async () => {
		const browser = new MerchantBrowser(f);
		await oauth(browser);
		await browser.json("/api/platform/session/exchange", {});
		await browser.json("/api/auth/request-password-reset", { email: "google@example.com" });
		expect(f.mailer.messages.filter((message) => message.kind === "reset")).toHaveLength(0);
		expect(await f.sql`SELECT token_hash FROM platform_auth_links WHERE kind='reset'`).toHaveLength(
			0,
		);
		expect(
			await f.sql`SELECT id FROM platform_auth_accounts WHERE provider_id='credential'`,
		).toHaveLength(0);
	});
	it("does not link a Google subject to an existing password account by email", async () => {
		const existing = new MerchantBrowser(f);
		await existing.signup("google@example.com");
		const browser = new MerchantBrowser(f);
		const { result } = await oauth(browser);
		expect(result.headers.get("location")).toContain("account_not_linked");
		expect(
			await f.sql`SELECT id FROM platform_auth_accounts WHERE provider_id='google'`,
		).toHaveLength(0);
	});
	it.each([
		["unverified email", { verified: false }],
		["wrong issuer", { issuer: "https://attacker.example" }],
		["wrong nonce", { nonce: "wrong" }],
		["expired token", { expiresIn: -60 }],
	] as const)("rejects %s", async (_name, changes) => {
		google.profile = { ...google.profile, ...changes };
		const browser = new MerchantBrowser(f);
		const { result } = await oauth(browser);
		expect(result.headers.get("location")).toContain("error=");
		expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
	});
	it("returns cancellation without creating a session", async () => {
		const browser = new MerchantBrowser(f);
		const { result } = await oauth(browser, true, true);
		expect(result.headers.get("location")).toContain("access_denied");
		expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);
	});
});
