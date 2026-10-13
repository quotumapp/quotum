import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { ABSOLUTE_MS, IDLE_MS, SESSION_COOKIE } from "../../src/platform/security";
import {
	authenticatorSecret,
	MerchantBrowser,
	merchantFixture,
	password,
	testConfig,
	totpCode,
} from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());
describe("real Better Auth merchant authentication", () => {
	it("answers the library's own sign-up rate limit in the platform error envelope", async () => {
		let limited: Response | undefined;
		for (let attempt = 0; attempt < 5 && limited === undefined; attempt++) {
			const browser = new MerchantBrowser(f);
			await browser.json("/api/platform/config");
			await browser.json("/api/platform/signup-intent", {
				accepted: true,
				termsVersion: testConfig.termsVersion,
				privacyVersion: testConfig.privacyVersion,
			});
			const response = await browser.request("/api/auth/sign-up/email", {
				name: "Merchant",
				email: `owner-${attempt}@example.com`,
				password,
			});
			if (response.status === 429) limited = response;
		}
		expect(limited).toBeDefined();
		expect(limited?.headers.get("content-type")).toContain("application/json");
		expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(await limited?.json()).toMatchObject({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
		});
	});

	it("requires verification, password, and an authenticator before custom session exchange", async () => {
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
		// No authenticator yet: the emailed code is only the way to set one up.
		expect(signIn.twoFactorMethods).toEqual(["email_enrolment"]);
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
		await browser.json("/api/auth/two-factor/send-otp", {});
		const otp = f.mailer.otp("owner@example.com");
		const verified = await browser.json("/api/auth/two-factor/verify-otp", {
			code: otp,
			trustDevice: false,
		});
		expect(verified.token).toBeUndefined();
		// An emailed code proves the mailbox; it is not a sign-in.
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
		const setup = await browser.json<{ otpauthUri: string; secret: string }>(
			"/api/platform/second-factor/enrolment",
			{},
		);
		expect(setup.otpauthUri).toStartWith("otpauth://totp/Quotum:owner%40example.com");
		const confirmed = await browser.json<{ recoveryCodes: string[] }>(
			"/api/platform/second-factor/enrolment/confirm",
			{ code: await totpCode(authenticatorSecret(setup.secret)) },
		);
		expect(confirmed.recoveryCodes).toHaveLength(10);
		await browser.json("/api/platform/session/exchange", {});
		expect((await browser.request("/api/platform/session")).status).toBe(200);
		const view = await browser.json<{ secondFactor: unknown }>("/api/platform/session");
		expect(view.secondFactor).toEqual({ enrolled: true, recoveryCodesRemaining: 10 });
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
			"/two-factor/get-totp-uri",
			"/two-factor/generate-backup-codes",
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
	it("refuses sign-up names with control or text-direction characters or over 100 characters", async () => {
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		await browser.json("/api/platform/signup-intent", {
			accepted: true,
			termsVersion: testConfig.termsVersion,
			privacyVersion: testConfig.privacyVersion,
		});
		for (const [index, name] of [
			"Jane\u0000Doe",
			"Jane\r\nDoe",
			"Jane\u202eeoD",
			"",
			"a".repeat(101),
		].entries()) {
			await f.sql`DELETE FROM platform_rate_limits`;
			const response = await browser.request("/api/auth/sign-up/email", {
				name,
				email: `refused-${index}@example.com`,
				password,
			});
			expect([response.status, (await response.json()).error?.code]).toEqual([
				400,
				"INVALID_REQUEST",
			]);
		}
		const email = await browser.request("/api/auth/sign-up/email", {
			name: "Jane",
			email: "owner\u0000@example.com",
			password,
		});
		expect(email.status).toBe(400);
		expect(await f.sql`SELECT id FROM platform_auth_users`).toHaveLength(0);
		await f.sql`DELETE FROM platform_rate_limits`;
		await browser.json("/api/auth/sign-up/email", {
			name: "  Jane Doe  ",
			email: "owner@example.com",
			password,
		});
		expect(await f.sql`SELECT name FROM platform_auth_users`).toEqual([{ name: "Jane Doe" }]);
	});
	it("spends an address's signup budget only on a request that can send it mail", async () => {
		const victim = "victim@example.com";
		const body = { name: "Victim", email: victim, password };
		const as = (ip: string) => ({ headers: { "x-quotum-client-ip": ip } });
		const outcome = async (response: Response) => {
			const result = await response.json();
			return [response.status, result.error?.code ?? result.code];
		};
		// Someone else, from another address, fails every check that comes before registration.
		const stranger = new MerchantBrowser(f);
		await stranger.json("/api/platform/config", undefined, as("192.0.2.99"));
		const refused: unknown[] = [];
		for (let attempt = 0; attempt < 3; attempt++)
			refused.push(
				await outcome(await stranger.request("/api/auth/sign-up/email", body, as("192.0.2.99"))),
			);
		await stranger.json(
			"/api/platform/signup-intent",
			{
				accepted: true,
				termsVersion: testConfig.termsVersion,
				privacyVersion: testConfig.privacyVersion,
			},
			as("192.0.2.99"),
		);
		// The first is refused by Quotum, the others by the sign-in library after the address is
		// charged; each comes from its own client address, so only the address budget is in play.
		for (const [ip, refusedBody] of [
			["192.0.2.98", { ...body, name: "" }],
			["192.0.2.97", { ...body, password: "short" }],
			["192.0.2.96", { ...body, termsVersion: "2020-01-01" }],
		] as const)
			refused.push(
				await outcome(await stranger.request("/api/auth/sign-up/email", refusedBody, as(ip))),
			);
		expect(refused.slice(0, 4)).toEqual([
			[400, "POLICY_ACCEPTANCE_REQUIRED"],
			[400, "POLICY_ACCEPTANCE_REQUIRED"],
			[400, "POLICY_ACCEPTANCE_REQUIRED"],
			[400, "INVALID_REQUEST"],
		]);
		expect(refused.slice(4).map((result) => (result as unknown[])[0])).toEqual([400, 400]);
		expect(f.mailer.messages).toHaveLength(0);

		// The address's owner still registers: the refusals spent none of its three daily attempts.
		const owner = new MerchantBrowser(f);
		await owner.json("/api/platform/config");
		await owner.json("/api/platform/signup-intent", {
			accepted: true,
			termsVersion: testConfig.termsVersion,
			privacyVersion: testConfig.privacyVersion,
		});
		expect(await outcome(await owner.request("/api/auth/sign-up/email", body))).toEqual([
			200,
			undefined,
		]);
		expect(f.mailer.messages).toHaveLength(1);

		// Requests that do send mail still spend it: the third attempt of the day is the last.
		const attempts: unknown[] = [];
		for (const ip of ["192.0.2.21", "192.0.2.22"])
			attempts.push((await owner.request("/api/auth/sign-up/email", body, as(ip))).status);
		const fourth = await owner.request("/api/auth/sign-up/email", body, as("192.0.2.23"));
		expect([...attempts, fourth.status]).toEqual([200, 200, 429]);
		expect((await fourth.json()).error.code).toBe("RATE_LIMITED");
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
		const [principal] = await f.sql<
			{ id: string; auth_user_id: string }[]
		>`SELECT id,auth_user_id FROM platform_principals`;
		expect(
			await f.sql`SELECT principal_id,organization_id,action,target,metadata FROM platform_audit_events WHERE action='password.reset'`,
		).toEqual([
			{
				principal_id: principal?.id,
				organization_id: null,
				action: "password.reset",
				target: principal?.auth_user_id,
				metadata: { sessionsRevoked: 1 },
			},
		]);
	});
	it("uses atomic rate-limit buckets under concurrent requests", async () => {
		await f.store.rateLimit("initial-probe", 5, 60_000);
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => f.store.rateLimit("concurrent-signup", 5, 60_000)),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(15);
	});
	it("locks an emailed enrolment code for fifteen minutes after five failures and never stores it", async () => {
		const owner = new MerchantBrowser(f);
		await owner.register();
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
		// A locked account is not sent a code it cannot use.
		const sent = f.mailer.messages.length;
		f.advance(31_000);
		const send = await browser.request("/api/auth/two-factor/send-otp", {});
		expect([send.status, (await send.json()).code]).toEqual([429, "ACCOUNT_TEMPORARILY_LOCKED"]);
		expect(f.mailer.messages).toHaveLength(sent);
	});
	it("rejects expired OTPs and trusted devices without issuing an authenticated session", async () => {
		const owner = new MerchantBrowser(f);
		await owner.register();
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
		await owner.register();
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
	it("signs in with the authenticator once per code and refuses emailed codes after enrolment", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		const secret = f.authenticators.get("owner@example.com") ?? "";
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		const signIn = await browser.json("/api/auth/sign-in/email", {
			email: "owner@example.com",
			password,
		});
		expect(signIn.twoFactorMethods).toEqual(["totp", "backup_code"]);
		// Emailed codes only set an authenticator up; an enrolled person is never sent one.
		const mailed = f.mailer.messages.length;
		f.advance(31_000);
		for (const path of ["send-otp", "verify-otp"]) {
			const refused = await browser.request(`/api/auth/two-factor/${path}`, { code: "123456" });
			expect([refused.status, (await refused.json()).code]).toEqual([403, "OTP_NOT_ALLOWED"]);
		}
		expect(f.mailer.messages).toHaveLength(mailed);
		await f.sql`UPDATE platform_auth_two_factors SET last_used_step=NULL`;
		const code = await totpCode(secret);
		await browser.json("/api/auth/two-factor/verify-totp", { code, trustDevice: false });
		await browser.json("/api/platform/session/exchange", {});
		expect((await browser.request("/api/platform/session")).status).toBe(200);
		// The code is spent: it does not sign in a second time while it is still inside its window.
		const again = new MerchantBrowser(f);
		await again.json("/api/platform/config");
		await again.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
		const replay = await again.request("/api/auth/two-factor/verify-totp", {
			code,
			trustDevice: false,
		});
		expect([replay.status, (await replay.json()).error?.code]).toEqual([409, "CODE_ALREADY_USED"]);
		expect((await again.request("/api/platform/session/exchange", {})).status).toBe(401);
		// A later step's code is accepted.
		await again.json("/api/auth/two-factor/verify-totp", {
			code: await totpCode(secret, 1),
			trustDevice: false,
		});
		await again.json("/api/platform/session/exchange", {});
		expect((await again.request("/api/platform/session")).status).toBe(200);
	});
	it("signs in with a recovery code once and keeps the remaining count", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		const [first, second] = f.recoveryCodes.get("owner@example.com") ?? [];
		expect(first).toBeDefined();
		const signIn = async () => {
			const browser = new MerchantBrowser(f);
			await browser.json("/api/platform/config");
			await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
			return browser;
		};
		const browser = await signIn();
		await browser.json("/api/auth/two-factor/verify-backup-code", { code: first });
		await browser.json("/api/platform/session/exchange", {});
		const view = await browser.json<{ secondFactor: unknown }>("/api/platform/session");
		expect(view.secondFactor).toEqual({ enrolled: true, recoveryCodesRemaining: 9 });
		const again = await signIn();
		expect(
			(await again.request("/api/auth/two-factor/verify-backup-code", { code: first })).status,
		).toBe(401);
		await again.json("/api/auth/two-factor/verify-backup-code", { code: second });
		await again.json("/api/platform/session/exchange", {});
	});
	it("locks the authenticator for fifteen minutes after five wrong codes", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		const secret = f.authenticators.get("owner@example.com") ?? "";
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
		const valid = new Set([
			await totpCode(secret, -1),
			await totpCode(secret),
			await totpCode(secret, 1),
		]);
		const wrong = ["000000", "111111", "222222", "333333"].find((code) => !valid.has(code)) ?? "";
		await f.sql`UPDATE platform_auth_two_factors SET last_used_step=NULL`;
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				(await browser.request("/api/auth/two-factor/verify-totp", { code: wrong })).status,
			).toBe(401);
		const [factor] = await f.sql<
			{ failed_verification_count: number; locked_until: Date }[]
		>`SELECT failed_verification_count,locked_until FROM platform_auth_two_factors`;
		expect(factor?.failed_verification_count).toBe(5);
		expect((factor?.locked_until.getTime() ?? 0) - Date.now()).toBeGreaterThan(14 * 60_000);
		const locked = await browser.request("/api/auth/two-factor/verify-totp", {
			code: await totpCode(secret),
		});
		expect([locked.status, (await locked.json()).error?.code]).toEqual([
			429,
			"ACCOUNT_TEMPORARILY_LOCKED",
		]);
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
	});
	it("replaces an authenticator only with a current code, and regenerates recovery codes the same way", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		const email = "owner@example.com";
		const secret = f.authenticators.get(email) ?? "";
		const [oldCode] = f.recoveryCodes.get(email) ?? [];
		// A live session alone cannot start a replacement.
		const bare = await browser.request("/api/platform/second-factor/enrolment", {});
		expect([bare.status, (await bare.json()).error.code]).toEqual([400, "CODE_REQUIRED"]);
		await f.sql`UPDATE platform_auth_two_factors SET last_used_step=NULL`;
		const setup = await browser.json<{ secret: string }>("/api/platform/second-factor/enrolment", {
			code: await totpCode(secret),
		});
		const replacement = authenticatorSecret(setup.secret);
		// The old authenticator keeps working until the new one proves itself.
		const [pending] = await f.sql<
			{ verified: boolean; pending: boolean }[]
		>`SELECT verified,pending_secret IS NOT NULL AS pending FROM platform_auth_two_factors`;
		expect(pending).toEqual({ verified: true, pending: true });
		const confirmed = await browser.json<{ recoveryCodes: string[] }>(
			"/api/platform/second-factor/enrolment/confirm",
			{ code: await totpCode(replacement) },
		);
		expect(confirmed.recoveryCodes).toHaveLength(10);
		f.authenticators.set(email, replacement);
		f.recoveryCodes.set(email, confirmed.recoveryCodes);
		// The replaced authenticator and its recovery codes no longer sign in.
		await f.sql`UPDATE platform_auth_two_factors SET last_used_step=NULL`;
		const stale = new MerchantBrowser(f);
		await stale.json("/api/platform/config");
		await stale.json("/api/auth/sign-in/email", { email, password });
		expect(
			(
				await stale.request("/api/auth/two-factor/verify-totp", {
					code: await totpCode(secret),
				})
			).status,
		).toBe(401);
		expect(
			(await stale.request("/api/auth/two-factor/verify-backup-code", { code: oldCode })).status,
		).toBe(401);
		// Regenerating needs a code too, and replaces the set as a whole.
		expect(
			(await browser.request("/api/platform/second-factor/recovery-codes", { code: "000000" }))
				.status,
		).toBe(400);
		await f.sql`UPDATE platform_auth_two_factors SET last_used_step=NULL`;
		const regenerated = await browser.json<{ recoveryCodes: string[] }>(
			"/api/platform/second-factor/recovery-codes",
			{ code: await totpCode(replacement) },
		);
		expect(regenerated.recoveryCodes).toHaveLength(10);
		expect(regenerated.recoveryCodes.some((code) => confirmed.recoveryCodes.includes(code))).toBe(
			false,
		);
		const actions = await f.sql<
			{ action: string }[]
		>`SELECT action FROM platform_audit_events WHERE action LIKE 'second_factor.%' ORDER BY created_at,action`;
		expect(actions.map((row) => row.action).sort()).toEqual([
			"second_factor.enrolled",
			"second_factor.recovery_codes_regenerated",
			"second_factor.replaced",
		]);
	});
	it("does not let a session that never enrolled set an authenticator up", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		// A session from before authenticators existed: signed in, but no factor behind it.
		await f.sql`UPDATE platform_auth_two_factors SET verified=false,secret='email-otp-only',backup_codes='[]',backup_codes_remaining=0`;
		const start = await browser.request("/api/platform/second-factor/enrolment", {});
		expect([start.status, (await start.json()).error.code]).toEqual([
			403,
			"SECOND_FACTOR_BOOTSTRAP_REQUIRED",
		]);
		const confirm = await browser.request("/api/platform/second-factor/enrolment/confirm", {
			code: "123456",
		});
		expect([confirm.status, (await confirm.json()).error.code]).toEqual([
			403,
			"SECOND_FACTOR_BOOTSTRAP_REQUIRED",
		]);
	});
});
