import { describe, expect, it } from "bun:test";
import { loadMerchantConfig } from "../../src/platform/config";

const merchantEnv = {
	MERCHANT_ORIGIN: "https://app.example.com",
	MERCHANT_PUBLIC_URL: "https://example.com",
	MERCHANT_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
	MERCHANT_TERMS_VERSION: "2026-09-01",
	MERCHANT_PRIVACY_VERSION: "2026-09-01",
	MERCHANT_EMAIL_ACCOUNT_ID: "test-account",
	MERCHANT_EMAIL_API_TOKEN: "test-token",
	MERCHANT_EMAIL_FROM: "mail@example.com",
};

describe("merchant deployment URLs", () => {
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
