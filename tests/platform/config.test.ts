import { describe, expect, it } from "bun:test";
import {
	loadMerchantConfig,
	loadOptionalMerchantConfig,
	merchantPlatformEnabled,
} from "../../src/platform/config";

const merchantEnv = {
	MERCHANT_ORIGIN: "https://app.example.com",
	MERCHANT_PUBLIC_URL: "https://example.com",
	QUOTUM_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
	MERCHANT_TERMS_VERSION: "2026-09-01",
	MERCHANT_PRIVACY_VERSION: "2026-09-01",
	QUOTUM_EMAIL_PROVIDER: "cloudflare",
	QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID: "test-account",
	QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN: "test-token",
	QUOTUM_EMAIL_FROM: "mail@example.com",
};

describe("merchant deployment URLs", () => {
	it("keeps remote MCP opt-in and requires an exact public HTTPS origin", () => {
		expect(loadMerchantConfig(merchantEnv).mcp).toBeNull();
		for (const value of ["", " \t "])
			expect(loadMerchantConfig({ ...merchantEnv, QUOTUM_MCP_ENABLED: value }).mcp).toBeNull();
		expect(() => loadMerchantConfig({ ...merchantEnv, QUOTUM_MCP_ENABLED: "yes" })).toThrow(
			"true or false",
		);
		expect(() => loadMerchantConfig({ ...merchantEnv, QUOTUM_MCP_ENABLED: "true" })).toThrow(
			"QUOTUM_MCP_PUBLIC_ORIGIN",
		);
		for (const origin of [
			"http://api.example.com",
			"https://api.example.com/",
			"https://api.example.com/mcp",
			"https://user:pass@api.example.com",
			"https://api.example.com?foo=1",
		]) {
			expect(() =>
				loadMerchantConfig({
					...merchantEnv,
					QUOTUM_MCP_ENABLED: "true",
					QUOTUM_MCP_PUBLIC_ORIGIN: origin,
				}),
			).toThrow("QUOTUM_MCP_PUBLIC_ORIGIN must be an HTTPS origin");
		}
		expect(
			loadMerchantConfig({
				...merchantEnv,
				QUOTUM_MCP_ENABLED: "true",
				QUOTUM_MCP_PUBLIC_ORIGIN: "https://api.example.com",
			}).mcp,
		).toEqual({ origin: "https://api.example.com", writesEnabled: false });
		for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
			expect(
				loadMerchantConfig({
					...merchantEnv,
					BILLING_ENV: "test",
					QUOTUM_MCP_ENABLED: "true",
					QUOTUM_MCP_PUBLIC_ORIGIN: origin,
				}).mcp,
			).toEqual({ origin, writesEnabled: false });
		}
		expect(() =>
			loadMerchantConfig({
				...merchantEnv,
				BILLING_ENV: "test",
				QUOTUM_MCP_ENABLED: "true",
				QUOTUM_MCP_PUBLIC_ORIGIN: "ftp://localhost",
			}),
		).toThrow("QUOTUM_MCP_PUBLIC_ORIGIN must be an HTTPS origin");
	});
	for (const billingEnv of ["production", undefined]) {
		for (const name of ["MERCHANT_ORIGIN", "MERCHANT_PUBLIC_URL"]) {
			for (const value of [undefined, "", " \t "]) {
				it(`rejects ${name}=${JSON.stringify(value)} with BILLING_ENV=${billingEnv}`, () => {
					expect(() =>
						loadMerchantConfig({ ...merchantEnv, BILLING_ENV: billingEnv, [name]: value }),
					).toThrow(`${name} is required in production`);
				});
			}
		}
		it(`uses explicit deployment URLs with BILLING_ENV=${billingEnv}`, () => {
			expect(loadMerchantConfig({ ...merchantEnv, BILLING_ENV: billingEnv })).toMatchObject({
				origin: merchantEnv.MERCHANT_ORIGIN,
				publicUrl: merchantEnv.MERCHANT_PUBLIC_URL,
			});
		});
	}
	for (const billingEnv of ["development", "test"]) {
		it(`preserves URL defaults in ${billingEnv}`, () => {
			expect(
				loadMerchantConfig({
					...merchantEnv,
					BILLING_ENV: billingEnv,
					MERCHANT_ORIGIN: undefined,
					MERCHANT_PUBLIC_URL: undefined,
				}),
			).toMatchObject({ origin: "https://app.quotum.dev", publicUrl: "https://quotum.dev" });
		});
	}
});

describe("headless mode", () => {
	it("runs headless unless QUOTUM_CONSOLE_ENABLED is exactly true", () => {
		for (const value of [undefined, "", " \t ", "false", " false "])
			expect(merchantPlatformEnabled({ QUOTUM_CONSOLE_ENABLED: value })).toBe(false);
		for (const value of ["true", " true "])
			expect(merchantPlatformEnabled({ QUOTUM_CONSOLE_ENABLED: value })).toBe(true);
		for (const value of ["FALSE", "0", "no", "off"])
			expect(() => merchantPlatformEnabled({ QUOTUM_CONSOLE_ENABLED: value })).toThrow(
				"QUOTUM_CONSOLE_ENABLED must be true or false",
			);
	});

	it("refuses the retired QUOTUM_MERCHANT_ENABLED name whatever its value", () => {
		for (const value of ["true", "false", ""]) {
			const env = { QUOTUM_MERCHANT_ENABLED: value, QUOTUM_CONSOLE_ENABLED: "true" };
			expect(() => merchantPlatformEnabled(env)).toThrow(
				"QUOTUM_MERCHANT_ENABLED has been removed; use QUOTUM_CONSOLE_ENABLED instead",
			);
			expect(() => loadOptionalMerchantConfig(env)).toThrow(
				"QUOTUM_MERCHANT_ENABLED has been removed; use QUOTUM_CONSOLE_ENABLED instead",
			);
		}
	});

	it("loads the merchant settings unchanged while the platform is on", () => {
		expect(loadOptionalMerchantConfig({ ...merchantEnv, QUOTUM_CONSOLE_ENABLED: "true" })).toEqual(
			loadMerchantConfig(merchantEnv),
		);
		expect(() => loadOptionalMerchantConfig({ QUOTUM_CONSOLE_ENABLED: "true" })).toThrow(
			"MERCHANT_ORIGIN is required in production",
		);
	});

	it("needs no merchant, email or auth settings in headless production", () => {
		expect(loadOptionalMerchantConfig({ BILLING_ENV: "production" })).toBeNull();
		expect(loadOptionalMerchantConfig({})).toBeNull();
		// Leftover merchant settings are ignored rather than half-applied.
		expect(
			loadOptionalMerchantConfig({ ...merchantEnv, QUOTUM_CONSOLE_ENABLED: "false" }),
		).toBeNull();
		expect(loadOptionalMerchantConfig({ ...merchantEnv })).toBeNull();
	});

	it("refuses remote MCP and retired settings in headless mode", () => {
		const headless = {};
		expect(() => loadOptionalMerchantConfig({ ...headless, QUOTUM_MCP_ENABLED: "true" })).toThrow(
			"QUOTUM_MCP_ENABLED=true requires the merchant platform",
		);
		expect(() => loadOptionalMerchantConfig({ ...headless, QUOTUM_MCP_ENABLED: "yes" })).toThrow(
			"QUOTUM_MCP_ENABLED must be true or false",
		);
		for (const value of ["false", "", " "])
			expect(loadOptionalMerchantConfig({ ...headless, QUOTUM_MCP_ENABLED: value })).toBeNull();
		expect(() =>
			loadOptionalMerchantConfig({ ...headless, MERCHANT_AUTH_SECRET: "old-secret" }),
		).toThrow("MERCHANT_AUTH_SECRET has been removed; use QUOTUM_AUTH_SECRET instead");
	});
});

it("MCP billing writes require an enabled remote transport and explicit opt-in", () => {
	expect(() => loadMerchantConfig({ ...merchantEnv, QUOTUM_MCP_WRITES_ENABLED: "true" })).toThrow();
	expect(
		loadMerchantConfig({
			...merchantEnv,
			QUOTUM_MCP_ENABLED: "true",
			QUOTUM_MCP_PUBLIC_ORIGIN: "https://api.example.com",
			QUOTUM_MCP_WRITES_ENABLED: "true",
		}).mcp?.writesEnabled,
	).toBe(true);
	expect(() => loadMerchantConfig({ ...merchantEnv, QUOTUM_MCP_WRITES_ENABLED: "yes" })).toThrow();
});
