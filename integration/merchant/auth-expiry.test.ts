import { afterAll, beforeEach, expect, test } from "bun:test";
import { createMerchantOtpFixture } from "../../src/testing/merchant-auth-fixture";
import { MerchantBrowser, merchantFixture, password, testConfig } from "./fixture";

const fixture = merchantFixture();
beforeEach(() => fixture.reset());
afterAll(() => fixture.sql.close());

async function pendingOtp(browser: MerchantBrowser, email: string) {
	await browser.json("/api/platform/config");
	await browser.json("/api/platform/signup-intent", {
		accepted: true,
		termsVersion: testConfig.termsVersion,
		privacyVersion: testConfig.privacyVersion,
	});
	await browser.json("/api/auth/sign-up/email", { name: "Expiry Merchant", email, password });
	await browser.json("/api/platform/verify-email", {
		token: fixture.mailer.link("verification", email),
	});
	await browser.json("/api/auth/sign-in/email", { email, password });
	const state = createMerchantOtpFixture(fixture.sql, fixture.mailer);
	const response = await state.track(() => browser.request("/api/auth/two-factor/send-otp", {}));
	expect(response.status).toBe(200);
	return { state, code: fixture.mailer.otp(email) };
}

test("disposable fixture expires only its observed OTP through ordinary HTTP and database state", async () => {
	const owner = new MerchantBrowser(fixture);
	const other = new MerchantBrowser(fixture);
	const pending = await pendingOtp(owner, "expiry-owner@example.com");
	const independent = await pendingOtp(other, "expiry-other@example.com");
	expect(await pending.state.expire("expiry-other@example.com")).toBe(false);
	expect(await pending.state.expire("expiry-owner@example.com")).toBe(true);
	const denied = await owner.request("/api/auth/two-factor/verify-otp", {
		code: pending.code,
		trustDevice: false,
	});
	expect(denied.status).toBe(400);
	expect((await denied.json()).code).toBe("OTP_HAS_EXPIRED");
	expect((await owner.request("/api/platform/session/exchange", {})).status).toBe(401);
	const allowed = await other.request("/api/auth/two-factor/verify-otp", {
		code: independent.code,
		trustDevice: false,
	});
	expect(allowed.status).toBe(200);
	expect((await other.request("/api/platform/session/exchange", {})).status).toBe(200);
});
