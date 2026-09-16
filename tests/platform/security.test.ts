import { describe, expect, it } from "bun:test";
import { merchantBillingRoute } from "../../src/platform/billing";
import { loadMerchantConfig } from "../../src/platform/config";
import {
	assertCsrf,
	CSRF_COOKIE,
	capabilitiesFor,
	maskEmail,
	randomToken,
	safeReturnTo,
	secureEqual,
	sessionCookie,
	tokenHash,
} from "../../src/platform/security";
import { canonicalJson, mutationTarget } from "../../src/platform/step-up";

describe("merchant security boundaries", () => {
	it("uses unpredictable opaque tokens and keyed hashes", () => {
		const first = randomToken();
		const second = randomToken();
		expect(first).toHaveLength(43);
		expect(first).not.toBe(second);
		expect(tokenHash(first, "a")).not.toBe(tokenHash(first, "b"));
		expect(tokenHash(first, "a")).toHaveLength(64);
		expect(secureEqual(first, first)).toBe(true);
		expect(secureEqual(first, second)).toBe(false);
		expect(secureEqual(first, "")).toBe(false);
	});
	it("requires exact origin plus matching CSRF cookie/header", () => {
		const csrf = randomToken();
		const headers = {
			origin: "https://app.quotum.dev",
			cookie: `${CSRF_COOKIE}=${csrf}`,
			"x-csrf-token": csrf,
		};
		expect(() =>
			assertCsrf(
				new Request("https://app.quotum.dev/action", { method: "POST", headers }),
				"https://app.quotum.dev",
			),
		).not.toThrow();
		for (const changed of [
			{ origin: "https://app.quotum.dev.evil.test" },
			{ "x-csrf-token": "different" },
			{ cookie: "" },
		])
			expect(() =>
				assertCsrf(
					new Request("https://app.quotum.dev/action", {
						method: "POST",
						headers: { ...headers, ...changed },
					}),
					"https://app.quotum.dev",
				),
			).toThrow();
		expect(sessionCookie("opaque")).toContain(
			"__Host-quotum_session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax",
		);
	});
	it("only preserves approved local return paths", () => {
		expect(safeReturnTo("/orgs/acme/projects/example/sandbox/customers?q=test%40example.com")).toBe(
			"/orgs/acme/projects/example/sandbox/customers?q=test%40example.com",
		);
		expect(safeReturnTo("/orgs/acme/projects/example/sandbox/customers?q=test")).toBe(
			"/orgs/acme/projects/example/sandbox/customers?q=test",
		);
		for (const value of [
			"https://evil.test",
			"//evil.test",
			"/\\evil.test",
			"/%2f%2fevil.test",
			"/api/auth/sign-out",
			"/sign-in",
			"javascript:alert(1)",
			"/team\r\nlocation:evil",
			null,
		])
			expect(safeReturnTo(value)).toBe("/");
	});
	it("enforces role-specific capabilities", () => {
		expect(capabilitiesFor("Viewer")).toEqual(["billing.read"]);
		expect(capabilitiesFor("Operator")).toContain("operations.recover");
		expect(capabilitiesFor("Operator")).not.toContain("catalog.author");
		expect(capabilitiesFor("Developer")).toContain("catalog.publish.sandbox");
		expect(capabilitiesFor("Developer")).not.toContain("catalog.publish.production");
		for (const role of ["Owner", "Admin"] as const)
			expect(capabilitiesFor(role)).toContain("catalog.publish.production");
	});
	it("binds confirmation to the canonical payload and HTTP method/path", () => {
		expect(canonicalJson({ b: 2, a: [1, { z: null }] })).toBe('{"a":[1,{"z":null}],"b":2}');
		expect(mutationTarget("POST", "/api/billing/admin/catalog/publish", { b: 2, a: 1 })).toBe(
			mutationTarget("POST", "/api/billing/admin/catalog/publish", { a: 1, b: 2 }),
		);
		expect(mutationTarget("POST", "/api/billing/admin/catalog/publish", { a: 1 })).not.toBe(
			mutationTarget("POST", "/api/billing/admin/catalog/publish", { a: 2 }),
		);
	});
	it("does not expose global reconciliation or provider routes to merchants", () => {
		for (const path of [
			"/api/billing/admin/reconciliation/subscriptions/run",
			"/api/billing/projects/foo/webhooks/stripe",
			"/api/billing/admin/customers/%2e%2e",
			"/api/billing/admin/catalog/publish/extra",
		])
			expect(merchantBillingRoute("POST", path, "production")).toBeNull();
		expect(
			merchantBillingRoute("POST", "/api/billing/admin/catalog/publish", "production")?.sensitive,
		).toBe(true);
		expect(
			merchantBillingRoute("POST", "/api/billing/admin/catalog/publish", "sandbox")?.sensitive,
		).toBe(false);
		expect(
			merchantBillingRoute(
				"GET",
				"/api/billing/admin/billing-accounts/customer/controls",
				"sandbox",
			)?.path,
		).toBe("/v1/billing-accounts/customer/controls");
	});
	it("maps promotion management to read and audited write capabilities", () => {
		for (const path of [
			"/api/billing/admin/promotions",
			"/api/billing/admin/promotions/spring-sale",
			"/api/billing/admin/promotions/spring-sale/codes",
			"/api/billing/admin/promotions/spring-sale/redemptions",
			"/api/billing/admin/billing-accounts/acct_1/promotion-redemptions",
		])
			expect(merchantBillingRoute("GET", path, "production")).toMatchObject({
				capability: "billing.read",
				sensitive: false,
			});
		for (const path of [
			"/api/billing/admin/promotions",
			"/api/billing/admin/promotions/spring-sale/archive",
			"/api/billing/admin/promotions/spring-sale/provider-sync",
			"/api/billing/admin/promotions/spring-sale/codes",
			"/api/billing/admin/promotions/spring-sale/codes/22222222-2222-4222-8222-222222222222/deactivate",
			"/api/billing/admin/promotion-redemptions/33333333-3333-4333-8333-333333333333/revoke",
		]) {
			expect(merchantBillingRoute("POST", path, "production")).toMatchObject({
				capability: "operations.write",
				action: "operations.write",
				sensitive: true,
				path: path.replace("/api/billing/", "/v1/"),
			});
			expect(merchantBillingRoute("POST", path, "sandbox")?.sensitive).toBe(false);
		}
		for (const path of [
			"/api/billing/admin/promotions/spring-sale/redemptions",
			"/api/billing/admin/promotions/spring-sale/codes/extra/segments/deactivate",
			"/api/billing/admin/promotions/spring-sale/codes/abc/deactivate/extra",
			"/api/billing/admin/billing-accounts/acct_1/promotion-redemptions",
			"/api/billing/admin/promotion-redemptions/a/b/revoke",
		])
			expect(merchantBillingRoute("POST", path, "sandbox")).toBeNull();
		expect(
			merchantBillingRoute("GET", "/api/billing/admin/promotions/a/codes/b", "sandbox"),
		).toBeNull();
	});
	it("requires merchant configuration everywhere and rejects draft signup policies", () => {
		expect(() => loadMerchantConfig({})).toThrow();
		expect(() => loadMerchantConfig({ BILLING_ENV: "test" })).toThrow();
		expect(() => loadMerchantConfig({ BILLING_ENV: "development" })).toThrow();
		expect(
			loadMerchantConfig({
				BILLING_ENV: "test",
				QUOTUM_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
				MERCHANT_TERMS_VERSION: "test-2026-09-10",
				MERCHANT_PRIVACY_VERSION: "test-2026-09-10",
			}),
		).toMatchObject({ signupEnabled: true, testMode: true, email: null });
		expect(() =>
			loadMerchantConfig({
				MERCHANT_ORIGIN: "https://app.example.com",
				MERCHANT_PUBLIC_URL: "https://example.com",
				QUOTUM_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
				MERCHANT_TERMS_VERSION: "2026-09-01",
				MERCHANT_PRIVACY_VERSION: "2026-09-01",
			}),
		).toThrow("QUOTUM_EMAIL_PROVIDER is required");
		expect(() =>
			loadMerchantConfig({
				MERCHANT_ORIGIN: "https://app.example.com",
				MERCHANT_PUBLIC_URL: "https://example.com",
				QUOTUM_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
				MERCHANT_SIGNUP_ENABLED: "true",
				MERCHANT_TERMS_VERSION: "draft-2026-09-05",
				MERCHANT_PRIVACY_VERSION: "draft-2026-09-05",
			}),
		).toThrow("Approve legal versions");
		expect(maskEmail("merchant@example.com")).toBe("m***@example.com");
	});
});
