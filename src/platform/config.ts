import { z } from "zod";

const enabled = (value: string | undefined) => value === "true";
export type QuotumEmailConfig =
	| { provider: "cloudflare"; accountId: string; apiToken: string; from: string }
	| { provider: "resend"; apiKey: string; from: string };

const retiredSettings = {
	MERCHANT_AUTH_SECRET: "QUOTUM_AUTH_SECRET",
	MERCHANT_EMAIL_ACCOUNT_ID: "QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID",
	MERCHANT_EMAIL_API_TOKEN: "QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN",
	MERCHANT_EMAIL_FROM: "QUOTUM_EMAIL_FROM",
};

function required(env: Record<string, string | undefined>, name: string): string {
	const value = env[name];
	if (!value?.trim()) throw new Error(`${name} is required`);
	return value;
}

function loadEmailConfig(
	env: Record<string, string | undefined>,
	testMode: boolean,
): QuotumEmailConfig | null {
	const configured = Object.entries(env).some(
		([key, value]) => key.startsWith("QUOTUM_EMAIL_") && value !== undefined,
	);
	if (testMode && !configured) return null;
	const provider = required(env, "QUOTUM_EMAIL_PROVIDER");
	if (provider !== "cloudflare" && provider !== "resend")
		throw new Error("QUOTUM_EMAIL_PROVIDER must be cloudflare or resend");
	const from = required(env, "QUOTUM_EMAIL_FROM");
	if (!z.email().safeParse(from).success)
		throw new Error("QUOTUM_EMAIL_FROM must be a valid email address");
	return provider === "cloudflare"
		? {
				provider,
				from,
				accountId: required(env, "QUOTUM_EMAIL_CLOUDFLARE_ACCOUNT_ID"),
				apiToken: required(env, "QUOTUM_EMAIL_CLOUDFLARE_API_TOKEN"),
			}
		: { provider, from, apiKey: required(env, "QUOTUM_EMAIL_RESEND_API_KEY") };
}

export interface MerchantConfig {
	signupEnabled: boolean;
	origin: string;
	publicUrl: string;
	secret: string;
	termsVersion: string;
	privacyVersion: string;
	google: { clientId: string; clientSecret: string } | null;
	email: QuotumEmailConfig | null;
	testMode: boolean;
}
export function loadMerchantConfig(
	env: Record<string, string | undefined> = process.env,
): MerchantConfig {
	for (const [oldName, newName] of Object.entries(retiredSettings)) {
		if (env[oldName] !== undefined)
			throw new Error(`${oldName} has been removed; use ${newName} instead`);
	}
	const production = (env.BILLING_ENV ?? "production") === "production";
	if (production) {
		for (const name of ["MERCHANT_ORIGIN", "MERCHANT_PUBLIC_URL"] as const) {
			if (!env[name]?.trim()) throw new Error(`${name} is required in production`);
		}
	}
	const testMode = env.BILLING_ENV === "test";
	const origin = z.url().parse(env.MERCHANT_ORIGIN ?? "https://app.quotum.dev");
	const originUrl = new URL(origin);
	if (originUrl.origin !== origin || (!testMode && originUrl.protocol !== "https:"))
		throw new Error("MERCHANT_ORIGIN must be an HTTPS origin");
	const secret = required(env, "QUOTUM_AUTH_SECRET");
	if (secret.length < 32) throw new Error("QUOTUM_AUTH_SECRET must be at least 32 characters");
	const termsVersion = z.string().min(1).parse(env.MERCHANT_TERMS_VERSION);
	const privacyVersion = z.string().min(1).parse(env.MERCHANT_PRIVACY_VERSION);
	const signupEnabled =
		env.MERCHANT_SIGNUP_ENABLED === undefined ? true : enabled(env.MERCHANT_SIGNUP_ENABLED);
	if (
		signupEnabled &&
		!testMode &&
		(termsVersion.startsWith("draft") || privacyVersion.startsWith("draft"))
	)
		throw new Error("Approve legal versions before enabling merchant signup");
	const google =
		env.MERCHANT_GOOGLE_CLIENT_ID && env.MERCHANT_GOOGLE_CLIENT_SECRET
			? { clientId: env.MERCHANT_GOOGLE_CLIENT_ID, clientSecret: env.MERCHANT_GOOGLE_CLIENT_SECRET }
			: null;
	const email = loadEmailConfig(env, testMode);
	return {
		signupEnabled,
		origin,
		publicUrl: env.MERCHANT_PUBLIC_URL ?? "https://quotum.dev",
		secret,
		termsVersion,
		privacyVersion,
		google,
		email,
		testMode,
	};
}
