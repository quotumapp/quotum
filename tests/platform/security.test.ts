import { describe, expect, it } from "bun:test";
import { billingOperation } from "../../src/platform/application/billing-port";
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
		for (const [changed, code] of [
			[{ origin: "https://app.quotum.dev.evil.test" }, "ORIGIN_REJECTED"],
			[{ "x-csrf-token": "different" }, "CSRF_REJECTED"],
			[{ cookie: "" }, "CSRF_REJECTED"],
		] as const)
			expect(() =>
				assertCsrf(
					new Request("https://app.quotum.dev/action", {
						method: "POST",
						headers: { ...headers, ...changed },
					}),
					"https://app.quotum.dev",
				),
			).toThrow(expect.objectContaining({ code, status: 403 }));
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
	it("exposes project usage events to merchants as a billing read", () => {
		for (const environment of ["sandbox", "production"] as const) {
			expect(
				merchantBillingRoute("GET", "/api/billing/admin/usage-events", environment),
			).toMatchObject({ capability: "billing.read", sensitive: false });
		}
	});
	it("marks the admitted read-only POST explicitly without relaxing audited previews", () => {
		for (const environment of ["sandbox", "production"] as const) {
			expect(
				merchantBillingRoute(
					"POST",
					"/api/billing/admin/billing-accounts/account/usage/check",
					environment,
				),
			).toMatchObject({ readOnly: true, capability: "billing.read", action: null });
			expect(
				merchantBillingRoute("POST", "/api/billing/admin/catalog/preview", environment),
			).toMatchObject({ readOnly: false, capability: "catalog.author" });
			expect(
				merchantBillingRoute(
					"POST",
					"/api/billing/admin/billing-accounts/account/commercial-actions/preview",
					environment,
				),
			).toMatchObject({ readOnly: false, capability: "operations.write" });
		}
	});
	it("exposes the capability reads to merchants as billing reads", () => {
		for (const environment of ["sandbox", "production"] as const) {
			expect(
				merchantBillingRoute("GET", "/api/billing/admin/providers/capabilities", environment),
			).toEqual({
				path: "/v1/admin/providers/capabilities",
				readOnly: true,
				capability: "billing.read",
				action: null,
				sensitive: false,
			});
			expect(
				merchantBillingRoute(
					"GET",
					"/api/billing/admin/billing-accounts/acct_1/available-actions",
					environment,
				),
			).toEqual({
				path: "/v1/billing-accounts/acct_1/available-actions",
				readOnly: true,
				capability: "billing.read",
				action: null,
				sensitive: false,
			});
		}
		expect(billingOperation("GET", "/v1/admin/providers/capabilities")).toEqual({
			operation: "providers.capabilities",
			parameters: [],
		});
		expect(billingOperation("GET", "/v1/billing-accounts/acct%201/available-actions")).toEqual({
			operation: "account.actions",
			parameters: ["acct 1"],
		});
		for (const path of [
			"/api/billing/admin/providers/capabilities",
			"/api/billing/admin/billing-accounts/acct_1/available-actions",
		])
			expect(merchantBillingRoute("POST", path, "sandbox")).toBeNull();
		for (const path of [
			"/api/billing/admin/providers/capabilities/stripe",
			"/api/billing/admin/providers",
			"/api/billing/admin/billing-accounts/acct_1/available-actions/extra",
			"/api/billing/billing-accounts/acct_1/available-actions",
		])
			expect(merchantBillingRoute("GET", path, "sandbox")).toBeNull();
	});
	it("guards the payment setup session read as a write, because it exposes an actionable link", () => {
		for (const environment of ["sandbox", "production"] as const) {
			expect(
				merchantBillingRoute(
					"GET",
					"/api/billing/admin/billing-accounts/acct_1/payment-setup-sessions/cs_1",
					environment,
				),
			).toEqual({
				path: "/v1/billing-accounts/acct_1/payment-setup-sessions/cs_1",
				readOnly: false,
				capability: "operations.write",
				action: null,
				sensitive: false,
			});
		}
		expect(
			billingOperation("GET", "/v1/billing-accounts/acct%201/payment-setup-sessions/cs_1"),
		).toEqual({ operation: "account.payment-setup", parameters: ["acct 1", "cs_1"] });
		for (const path of [
			"/api/billing/admin/billing-accounts/acct_1/payment-setup-sessions",
			"/api/billing/admin/billing-accounts/acct_1/payment-setup-sessions/cs_1/extra",
		])
			expect(merchantBillingRoute("GET", path, "sandbox")).toBeNull();
		expect(
			merchantBillingRoute(
				"POST",
				"/api/billing/admin/billing-accounts/acct_1/payment-setup-sessions/cs_1",
				"sandbox",
			),
		).toBeNull();
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
		expect(() => loadMerchantConfig({})).toThrow("MERCHANT_ORIGIN is required in production");
		expect(() => loadMerchantConfig({ BILLING_ENV: "test" })).toThrow(
			"QUOTUM_AUTH_SECRET is required",
		);
		expect(() => loadMerchantConfig({ BILLING_ENV: "development" })).toThrow(
			"QUOTUM_AUTH_SECRET is required",
		);
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
