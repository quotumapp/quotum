import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { ABSOLUTE_MS, IDLE_MS, SESSION_COOKIE } from "../../src/platform/security";
import { MerchantBrowser, merchantFixture, password, testConfig } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());
describe("real Better Auth merchant authentication", () => {
	it("requires verification, password, and OTP before custom session exchange", async () => {
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		await browser.json("/api/platform/signup-intent", {
			accepted: true,
			termsVersion: testConfig.termsVersion,
			privacyVersion: testConfig.privacyVersion,
		});
		expect(browser.cookies.has("__Host-quotum_signup")).toBe(true);
		const links =
			await f.sql`SELECT kind,token_hash=${f.store.hash(browser.cookies.get("__Host-quotum_signup") ?? "")} AS matches,expires_at>${f.store.now()} AS valid,consumed_at IS NULL AS unconsumed,jsonb_typeof(payload) AS payload_type FROM platform_auth_links`;
		expect([...links]).toEqual([
			{ kind: "signup", matches: true, valid: true, unconsumed: true, payload_type: "object" },
		]);
		expect(
			await f.store.readLink(browser.cookies.get("__Host-quotum_signup") ?? "", "signup"),
		).toMatchObject({ termsVersion: testConfig.termsVersion });
		await browser.json("/api/auth/sign-up/email", {
			name: "Merchant",
			email: "owner@example.com",
			password,
		});
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
		expect(
			(await browser.request("/api/auth/sign-in/email", { email: "owner@example.com", password }))
				.status,
		).toBe(403);
		const verifyToken = f.mailer.link("verification", "owner@example.com");
		await browser.json("/api/platform/verify-email", { token: verifyToken });
		expect(
			(await browser.request("/api/platform/verify-email", { token: verifyToken })).status,
		).toBe(410);
		const signIn = await browser.json("/api/auth/sign-in/email", {
			email: "owner@example.com",
			password,
		});
		expect(signIn.twoFactorRedirect).toBe(true);
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
		await browser.json("/api/auth/two-factor/send-otp", {});
		const otp = f.mailer.otp("owner@example.com");
		const verified = await browser.json("/api/auth/two-factor/verify-otp", {
			code: otp,
			trustDevice: false,
		});
		expect(verified.token).toBeUndefined();
		await browser.json("/api/platform/session/exchange", {});
		expect((await browser.request("/api/platform/session")).status).toBe(200);
		const raw = browser.cookies.get(SESSION_COOKIE);
		const [session] = await f.sql`SELECT token_hash,auth_method FROM platform_merchant_sessions`;
		expect(session.auth_method).toBe("password");
		expect(session.token_hash).not.toBe(raw);
		expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);
		expect(await f.sql`SELECT id FROM platform_policy_acceptances`).toHaveLength(1);
		expect((await f.sql`SELECT issuer FROM platform_external_identities`)[0].issuer).toBe(
			"local:credential",
		);
	});
	it("rejects skipped legal acceptance, short passwords, alternate auth endpoints, and CSRF", async () => {
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		expect(
			(
				await browser.request("/api/auth/sign-up/email", {
					name: "Merchant",
					email: "owner@example.com",
					password,
				})
			).status,
		).toBe(400);
		for (const path of [
			"/two-factor/disable",
			"/two-factor/enable",
			"/sign-in/email-otp",
			"/link-social",
			"/get-session",
		])
			expect((await browser.request(`/api/auth${path}`, {})).status).toBe(404);
		expect(
			(
				await browser.request(
					"/api/platform/signup-intent",
					{},
					{ headers: { origin: "https://evil.test" } },
				)
			).status,
		).toBe(403);
		expect(
			(
				await browser.request(
					"/api/platform/signup-intent",
					{},
					{ headers: { "x-csrf-token": "wrong" } },
				)
			).status,
		).toBe(403);
		expect(
			(
				await browser.request("/api/platform/config", undefined, {
					headers: { "x-quotum-service-token": "wrong" },
				})
			).status,
		).toBe(401);
	});
	it("expires sessions on both idle and absolute limits", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		f.advance(IDLE_MS - 60_000);
		expect((await browser.request("/api/platform/onboarding")).status).toBe(200);
		f.advance(120_000);
		// Protected API activity extends idle expiry, not the absolute deadline.
		expect((await browser.request("/api/platform/session")).status).toBe(200);
		f.advance(IDLE_MS + 1);
		expect((await browser.request("/api/platform/session")).status).toBe(401);
		await f.sql`UPDATE platform_merchant_sessions SET last_seen_at=${new Date(Date.now() + ABSOLUTE_MS)}`;
		f.advance(ABSOLUTE_MS);
		expect((await browser.request("/api/platform/session")).status).toBe(401);
	});
	it("revokes custom sessions on password reset and prevents reset replay", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		const recovery = new MerchantBrowser(f);
		await recovery.json("/api/platform/config");
		await recovery.json("/api/auth/request-password-reset", {
			email: "owner@example.com",
			redirectTo: `${testConfig.origin}/reset-password`,
		});
		const token = f.mailer.link("reset", "owner@example.com");
		await recovery.json("/api/auth/reset-password", {
			token,
			newPassword: "A different strong password 123!",
		});
		expect((await browser.request("/api/platform/session")).status).toBe(401);
		expect(
			(await recovery.request("/api/auth/reset-password", { token, newPassword: password })).status,
		).toBe(410);
	});
	it("uses atomic rate-limit buckets under concurrent requests", async () => {
		await f.store.rateLimit("initial-probe", 5, 60_000);
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => f.store.rateLimit("concurrent-signup", 5, 60_000)),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(15);
	});
	it("locks OTP verification for fifteen minutes after five failures and never stores the code", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
		f.advance(31_000);
		await browser.json("/api/auth/two-factor/send-otp", {});
		const code = f.mailer.otp("owner@example.com");
		expect(
			JSON.stringify(await f.sql`SELECT value FROM platform_auth_verifications`),
		).not.toContain(code);
		const wrong = code === "000000" ? "111111" : "000000";
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				(await browser.request("/api/auth/two-factor/verify-otp", { code: wrong })).status,
			).toBe(401);
		const [factor] = await f.sql<
			{ failed_verification_count: number; locked_until: Date }[]
		>`SELECT failed_verification_count,locked_until FROM platform_auth_two_factors`;
		expect(factor.failed_verification_count).toBe(5);
		expect(factor.locked_until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
		expect((await browser.request("/api/auth/two-factor/verify-otp", { code })).status).toBe(429);
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
	});
	it("rejects expired OTPs and trusted devices without issuing an authenticated session", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
		f.advance(31_000);
		await browser.json("/api/auth/two-factor/send-otp", {});
		const code = f.mailer.otp("owner@example.com");
		expect(
			(await browser.request("/api/auth/two-factor/verify-otp", { code, trustDevice: true }))
				.status,
		).toBe(400);
		await f.sql`UPDATE platform_auth_verifications SET expires_at=now()-interval '1 second' WHERE value LIKE '%:0'`;
		const response = await browser.request("/api/auth/two-factor/verify-otp", { code });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "OTP_HAS_EXPIRED" });
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
	});
	it("throttles sends before replacing a usable OTP and surfaces delivery failures", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
		f.advance(31_000);
		await browser.json("/api/auth/two-factor/send-otp", {});
		const code = f.mailer.otp("owner@example.com");
		const throttled = await browser.request("/api/auth/two-factor/send-otp", {});
		expect(throttled.status).toBe(429);
		expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
		await browser.json("/api/auth/two-factor/verify-otp", { code });
		await browser.json("/api/platform/session/exchange", {});
		await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
		f.advance(31_000);
		f.mailer.fail = true;
		const delivery = await browser.request("/api/auth/two-factor/send-otp", {});
		expect(delivery.status).toBe(503);
		expect(await delivery.json()).toMatchObject({ error: { code: "EMAIL_DELIVERY_FAILED" } });
	});
	it("counts password failures, not successful first-factor authentications", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		for (let attempt = 0; attempt < 6; attempt++)
			expect(
				(await browser.request("/api/auth/sign-in/email", { email: "owner@example.com", password }))
					.status,
			).toBe(200);
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				(
					await browser.request("/api/auth/sign-in/email", {
						email: "owner@example.com",
						password: "wrong password 123!",
					})
				).status,
			).toBe(401);
		expect(
			(await browser.request("/api/auth/sign-in/email", { email: "owner@example.com", password }))
				.status,
		).toBe(429);
	});
	it("rotates the current session on authentication and rejects replay of the exchanged proof", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		const previous = browser.cookies.get(SESSION_COOKIE);
		f.advance(31_000);
		await browser.login("owner@example.com");
		expect(browser.cookies.get(SESSION_COOKIE) === previous).toBe(false);
		expect(
			(
				await browser.request("/api/platform/session", undefined, {
					headers: { cookie: `${SESSION_COOKIE}=${previous}` },
				})
			).status,
		).toBe(401);
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
		expect(
			(
				await f.sql`SELECT count(*)::int AS count FROM platform_merchant_sessions WHERE revoked_at IS NULL`
			)[0].count,
		).toBe(1);
	});
	it("serializes concurrent registration of one email without duplicate identities", async () => {
		const browsers = [new MerchantBrowser(f), new MerchantBrowser(f)];
		for (const browser of browsers) {
			await browser.json("/api/platform/config");
			await browser.json("/api/platform/signup-intent", {
				accepted: true,
				termsVersion: testConfig.termsVersion,
				privacyVersion: testConfig.privacyVersion,
			});
		}
		const responses = await Promise.all(
			browsers.map((browser) =>
				browser.request("/api/auth/sign-up/email", {
					name: "Same Merchant",
					email: "duplicate@example.com",
					password,
				}),
			),
		);
		for (const response of responses) expect(response.status).toBe(200);
		expect(await f.sql`SELECT id FROM platform_auth_users`).toHaveLength(1);
		expect(await f.sql`SELECT id FROM platform_auth_accounts`).toHaveLength(1);
	});
});
