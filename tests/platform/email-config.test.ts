import { describe, expect, it } from "bun:test";
import { loadMerchantConfig } from "../../src/platform/config";

const baseEnv = {
	MERCHANT_ORIGIN: "https://app.example.com",
	MERCHANT_PUBLIC_URL: "https://example.com",
	QUOTUM_AUTH_SECRET: "synthetic-secret-that-is-at-least-32-characters",
	MERCHANT_TERMS_VERSION: "2026-09-01",
	MERCHANT_PRIVACY_VERSION: "2026-09-01",
};
const cloudflareEnv = {
	...baseEnv,
	QUOTUM_EMAIL_PROVIDER: "cloudflare",
	QUOTUM_EMAIL_FROM: "auth@example.com",
	QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
	QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN: "synthetic-token",
};
const resendEnv = {
	...baseEnv,
	QUOTUM_EMAIL_PROVIDER: "resend",
	QUOTUM_EMAIL_FROM: "auth@example.com",
	QUOTUM_EMAIL_RESEND_API_KEY: "synthetic-key",
};

describe("Quotum operator email configuration", () => {
	it("loads only selected provider credentials and preserves the auth secret", () => {
		expect(loadMerchantConfig(cloudflareEnv).email).toEqual({
			provider: "cloudflare",
			accountId: "synthetic-account",
			apiToken: "synthetic-token",
			from: "auth@example.com",
		});
		expect(loadMerchantConfig(resendEnv).email).toEqual({
			provider: "resend",
			apiKey: "synthetic-key",
			from: "auth@example.com",
		});
		expect(loadMerchantConfig({ ...cloudflareEnv, ...resendEnv }).email).toEqual(
			loadMerchantConfig(resendEnv).email,
		);
		const secret = ` ${baseEnv.QUOTUM_AUTH_SECRET} `;
		expect(loadMerchantConfig({ ...resendEnv, QUOTUM_AUTH_SECRET: secret }).secret).toBe(secret);
	});
	for (const billingEnv of [undefined, "production", "development", "test"]) {
		for (const config of [cloudflareEnv, resendEnv]) {
			const keys = [
				"QUOTUM_EMAIL_PROVIDER",
				"QUOTUM_EMAIL_FROM",
				"QUOTUM_AUTH_SECRET",
				...(config.QUOTUM_EMAIL_PROVIDER === "cloudflare"
					? ["QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID", "QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN"]
					: ["QUOTUM_EMAIL_RESEND_API_KEY"]),
			];
			for (const key of keys) {
				it(`requires ${key} for ${config.QUOTUM_EMAIL_PROVIDER} in ${billingEnv} with signup closed`, () => {
					for (const value of [undefined, "", " \t "]) {
						expect(() =>
							loadMerchantConfig({
								...config,
								BILLING_ENV: billingEnv,
								MERCHANT_SIGNUP_ENABLED: "false",
								[key]: value,
							}),
						).toThrow(key);
					}
				});
			}
		}
	}
	it("rejects invalid settings without exposing their values", () => {
		for (const [key, value] of [
			["QUOTUM_EMAIL_PROVIDER", "private-invalid-provider"],
			["QUOTUM_EMAIL_FROM", "private-invalid-sender"],
			["QUOTUM_AUTH_SECRET", "private-short-secret"],
		] as const) {
			let error: unknown;
			try {
				loadMerchantConfig({ ...resendEnv, [key]: value });
			} catch (caught) {
				error = caught;
			}
			expect(String(error)).toContain(key);
			expect(String(error)).not.toContain(value);
		}
	});
	it("rejects retired names even alongside new settings", () => {
		const renames = {
			MERCHANT_AUTH_SECRET: "QUOTUM_AUTH_SECRET",
			MERCHANT_EMAIL_FROM: "QUOTUM_EMAIL_FROM",
			MERCHANT_EMAIL_ACCOUNT_ID: "QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID",
			MERCHANT_EMAIL_API_TOKEN: "QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN",
		};
		for (const [oldName, newName] of Object.entries(renames)) {
			for (const value of ["private-retired-value", ""]) {
				expect(() => loadMerchantConfig({ ...resendEnv, [oldName]: value })).toThrow(
					`${oldName} has been removed; use ${newName} instead`,
				);
			}
		}
	});
	it("allows absent email configuration only in tests", () => {
		expect(loadMerchantConfig({ ...baseEnv, BILLING_ENV: "test" }).email).toBeNull();
		for (const BILLING_ENV of [undefined, "production", "development"]) {
			expect(() => loadMerchantConfig({ ...baseEnv, BILLING_ENV })).toThrow(
				"QUOTUM_EMAIL_PROVIDER",
			);
		}
		expect(() =>
			loadMerchantConfig({ ...baseEnv, BILLING_ENV: "test", QUOTUM_EMAIL_RESEND_API_KEY: "key" }),
		).toThrow("QUOTUM_EMAIL_PROVIDER");
	});
});
