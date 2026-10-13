import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSecondFactor } from "../../src/platform/operator-second-factor";
import { MerchantBrowser, merchantFixture, totpCode } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const email = "owner@example.com";
const notices = () => f.mailer.messages.filter((message) => message.kind === "security_notice");

describe("operator reset of a second factor", () => {
	it("returns the person to setting an authenticator up and ends everything they hold", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		const other = new MerchantBrowser(f);
		await other.login(email);
		const before = f.authenticators.get(email);
		expect(
			(await f.sql`SELECT id FROM platform_merchant_sessions WHERE revoked_at IS NULL`).length,
		).toBe(2);

		const result = await resetSecondFactor(f.sql, {
			email: "OWNER@example.com",
			operator: "ops-runbook",
			reason: "Verified by video call",
		});
		expect(result).toEqual({ email, hadAuthenticator: true, sessionsRevoked: 2 });

		// Both sessions are over, and the factor is back to the placeholder every account starts with.
		expect((await browser.request("/api/platform/session")).status).toBe(401);
		expect((await other.request("/api/platform/session")).status).toBe(401);
		const [factor] =
			await f.sql`SELECT verified,secret,pending_secret,last_used_step,enrolled_at,backup_codes,backup_codes_remaining,failed_verification_count,locked_until FROM platform_auth_two_factors`;
		expect(factor).toEqual({
			verified: false,
			secret: "email-otp-only",
			pending_secret: null,
			last_used_step: null,
			enrolled_at: null,
			backup_codes: "[]",
			backup_codes_remaining: 0,
			failed_verification_count: 0,
			locked_until: null,
		});
		const [audit] =
			await f.sql`SELECT principal_id,action,target,metadata FROM platform_audit_events WHERE action='second_factor.operator_reset'`;
		expect(audit).toMatchObject({
			principal_id: null,
			action: "second_factor.operator_reset",
			metadata: {
				operator: "ops-runbook",
				reason: "Verified by video call",
				hadAuthenticator: true,
				sessionsRevoked: 2,
			},
		});

		// The old authenticator no longer signs in: the person starts again with the emailed code.
		const secret = before ?? "";
		const again = new MerchantBrowser(f);
		await again.json("/api/platform/config");
		const signIn = await again.json("/api/auth/sign-in/email", {
			email,
			password: "Merchant test password 123!",
		});
		expect(signIn.twoFactorMethods).toEqual(["email_enrolment"]);
		f.authenticators.delete(email);
		// The emailed code is paced per person, and the first one was sent moments ago.
		f.advance(31_000);
		await new MerchantBrowser(f).login(email);
		const replacement = f.authenticators.get(email);
		expect(replacement).toBeDefined();
		expect(replacement).not.toBe(secret);
		expect(await totpCode(replacement ?? "")).toHaveLength(6);
	});

	it("names an unknown address instead of guessing, and changes nothing", async () => {
		await new MerchantBrowser(f).signup();
		await expect(
			resetSecondFactor(f.sql, { email: "nobody@example.com", operator: "ops", reason: "test" }),
		).rejects.toThrow("No merchant user has that address.");
		const [factor] = await f.sql`SELECT verified FROM platform_auth_two_factors`;
		expect(factor?.verified).toBe(true);
		expect(
			await f.sql`SELECT id FROM platform_audit_events WHERE action='second_factor.operator_reset'`,
		).toHaveLength(0);
	});
});

describe("security notices", () => {
	it("tells the person when an authenticator is set up or its recovery codes change", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		expect(notices().map((message) => message.to)).toEqual([email]);
		expect(notices()[0]?.subject).toContain("an authenticator app was set up on your account");
		// A notice carries no link and no code: it is not a way in.
		expect(notices()[0]?.text).not.toMatch(/https?:\/\/|\b\d{6}\b/);

		await browser.resetReplay(email);
		const secret = f.authenticators.get(email) ?? "";
		await browser.json("/api/platform/second-factor/recovery-codes", {
			code: await totpCode(secret),
		});
		expect(notices()).toHaveLength(2);
		expect(notices()[1]?.subject).toContain("recovery codes");

		// The next step's code, since the previous one is spent.
		const regenerated = await browser.json<{ recoveryCodes: string[] }>(
			"/api/platform/second-factor/recovery-codes",
			{ code: await totpCode(secret, 1) },
		);
		expect(regenerated.recoveryCodes).toHaveLength(10);
		expect(notices()).toHaveLength(3);
	});

	it("tells the person when a recovery code signs someone in", async () => {
		await new MerchantBrowser(f).signup();
		const [code] = f.recoveryCodes.get(email) ?? [];
		const before = notices().length;
		const browser = new MerchantBrowser(f);
		await browser.json("/api/platform/config");
		await browser.json("/api/auth/sign-in/email", {
			email,
			password: "Merchant test password 123!",
		});
		await browser.json("/api/auth/two-factor/verify-backup-code", { code });
		expect(notices()).toHaveLength(before + 1);
		expect(notices().at(-1)?.subject).toContain("a recovery code was used");
	});

	it("does not undo the change when the notice cannot be delivered", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		await browser.resetReplay(email);
		const secret = f.authenticators.get(email) ?? "";
		f.mailer.fail = true;
		const response = await browser.request("/api/platform/second-factor/recovery-codes", {
			code: await totpCode(secret),
		});
		expect(response.status).toBe(200);
		const [factor] = await f.sql`SELECT backup_codes_remaining FROM platform_auth_two_factors`;
		expect(factor?.backup_codes_remaining).toBe(10);
	});
});
