import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { StepUpChallengeView } from "../../src/platform/contracts";
import { mutationTarget } from "../../src/platform/step-up";
import { MerchantBrowser, merchantFixture, onboard, password, totpCode } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const email = "owner@example.com";

async function signedInOwner() {
	const browser = new MerchantBrowser(f);
	await onboard(browser);
	await f.sql`UPDATE projects SET lifecycle_status='active' WHERE environment='production'`;
	return browser;
}

function challengeFor(browser: MerchantBrowser) {
	const path = `/api/billing/admin/store-events/${crypto.randomUUID()}/replay`;
	return browser.json<StepUpChallengeView>("/api/platform/step-up", {
		scope: {
			kind: "merchant",
			organizationSlug: "acme",
			projectKey: "example",
			environment: "production",
		},
		action: "operations.recover",
		target: mutationTarget("POST", path, {}),
		returnTo: "/orgs/acme/projects/example/production/catalog",
	});
}

describe("step-up confirmed with a code from the authenticator", () => {
	it("completes inline, with no sign-in, and names the factor that confirms it", async () => {
		const browser = await signedInOwner();
		const challenge = await challengeFor(browser);
		expect(challenge.factor).toBe("totp");
		const sessionBefore = await f.sql`SELECT id FROM platform_merchant_sessions`;
		const grant = await browser.completeStepUp(challenge.id);
		expect(grant).toBeTruthy();
		// The same session continues; nothing was signed in or left behind as a proof.
		expect(await f.sql`SELECT id FROM platform_merchant_sessions`).toEqual([...sessionBefore]);
		expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);
		const [row] =
			await f.sql`SELECT verified_at FROM platform_step_up_grants WHERE id=${challenge.id}`;
		expect(row?.verified_at).not.toBeNull();
		const audit =
			await f.sql`SELECT action FROM platform_audit_events WHERE action='step_up.completed'`;
		expect(audit).toHaveLength(1);
	});

	it("closes a challenge after five wrong codes, which also lock the account", async () => {
		const browser = await signedInOwner();
		const challenge = await challengeFor(browser);
		const wrong = await browser.wrongCode(email);
		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await browser.request(`/api/platform/step-up/${challenge.id}/complete`, {
				code: wrong,
			});
			expect([response.status, (await response.json()).error.code]).toEqual([400, "INVALID_CODE"]);
		}
		const [row] = await f.sql<
			{ failed_attempts: number }[]
		>`SELECT failed_attempts FROM platform_step_up_grants WHERE id=${challenge.id}`;
		expect(row?.failed_attempts).toBe(5);
		// The same wrong codes also locked the account.
		const [factor] = await f.sql<
			{ locked: boolean }[]
		>`SELECT locked_until>now() AS locked FROM platform_auth_two_factors`;
		expect(factor?.locked).toBe(true);
		// With the lock cleared, the right code still does not help: the challenge itself is closed.
		await browser.resetReplay(email);
		const secret = f.authenticators.get(email) ?? "";
		const closed = await browser.request(`/api/platform/step-up/${challenge.id}/complete`, {
			code: await totpCode(secret),
		});
		expect([closed.status, (await closed.json()).error.code]).toEqual([409, "STEP_UP_EXPIRED"]);
	});

	it("takes a recovery code once", async () => {
		const browser = await signedInOwner();
		const [first] = f.recoveryCodes.get(email) ?? [];
		const challenge = await challengeFor(browser);
		const done = await browser.json<{ grant: string }>(
			`/api/platform/step-up/${challenge.id}/complete`,
			{ code: first },
		);
		expect(done.grant).toBeTruthy();
		const view = await browser.json<{ secondFactor: unknown }>("/api/platform/session");
		expect(view.secondFactor).toEqual({ enrolled: true, recoveryCodesRemaining: 9 });
		const next = await challengeFor(browser);
		const again = await browser.request(`/api/platform/step-up/${next.id}/complete`, {
			code: first,
		});
		expect([again.status, (await again.json()).error.code]).toEqual([400, "INVALID_CODE"]);
	});

	it("refuses a code that has already signed someone in, and accepts the next one", async () => {
		const browser = await signedInOwner();
		const secret = f.authenticators.get(email) ?? "";
		await browser.resetReplay(email);
		const code = await totpCode(secret);
		const elsewhere = new MerchantBrowser(f);
		await elsewhere.json("/api/platform/config");
		await elsewhere.json("/api/auth/sign-in/email", {
			email,
			password,
		});
		await elsewhere.json("/api/auth/two-factor/verify-totp", { code, trustDevice: false });
		const challenge = await challengeFor(browser);
		const replay = await browser.request(`/api/platform/step-up/${challenge.id}/complete`, {
			code,
		});
		expect([replay.status, (await replay.json()).error.code]).toEqual([409, "CODE_ALREADY_USED"]);
		const next = await browser.json<{ grant: string }>(
			`/api/platform/step-up/${challenge.id}/complete`,
			{ code: await totpCode(secret, 1) },
		);
		expect(next.grant).toBeTruthy();
	});

	it("asks a member with no authenticator to set one up before a challenge exists", async () => {
		const browser = await signedInOwner();
		await f.sql`UPDATE platform_auth_two_factors SET verified=false,secret='email-otp-only',backup_codes='[]',backup_codes_remaining=0`;
		const path = `/api/billing/admin/store-events/${crypto.randomUUID()}/replay`;
		const response = await browser.request("/api/platform/step-up", {
			scope: {
				kind: "merchant",
				organizationSlug: "acme",
				projectKey: "example",
				environment: "production",
			},
			action: "operations.recover",
			target: mutationTarget("POST", path, {}),
			returnTo: "/",
		});
		expect([response.status, (await response.json()).error.code]).toEqual([
			409,
			"SECOND_FACTOR_REQUIRED",
		]);
		expect(await f.sql`SELECT id FROM platform_step_up_grants`).toHaveLength(0);
	});
});
