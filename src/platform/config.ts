import { z } from "zod";

const enabled = (value: string | undefined) => value === "true";
export interface MerchantConfig {
	enabled: boolean;
	signupEnabled: boolean;
	origin: string;
	publicUrl: string;
	secret: string;
	termsVersion: string;
	privacyVersion: string;
	google: { clientId: string; clientSecret: string } | null;
	email: { accountId: string; apiToken: string; from: string } | null;
	testMode: boolean;
}
export function loadMerchantConfig(
	env: Record<string, string | undefined> = process.env,
): MerchantConfig | null {
	const production = (env.BILLING_ENV ?? "production") === "production";
	if (production && env.MERCHANT_AUTH_ENABLED === "false")
		throw new Error("Merchant authentication is required in production");
	if (!production && !enabled(env.MERCHANT_AUTH_ENABLED)) return null;
	const testMode = env.BILLING_ENV === "test";
	const origin = z.url().parse(env.MERCHANT_ORIGIN ?? "https://app.quotum.dev");
	const originUrl = new URL(origin);
	if (originUrl.origin !== origin || (!testMode && originUrl.protocol !== "https:"))
		throw new Error("MERCHANT_ORIGIN must be an HTTPS origin");
	const secret = z.string().min(32).parse(env.MERCHANT_AUTH_SECRET);
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
	const email =
		env.MERCHANT_EMAIL_ACCOUNT_ID && env.MERCHANT_EMAIL_API_TOKEN && env.MERCHANT_EMAIL_FROM
			? {
					accountId: env.MERCHANT_EMAIL_ACCOUNT_ID,
					apiToken: env.MERCHANT_EMAIL_API_TOKEN,
					from: z.email().parse(env.MERCHANT_EMAIL_FROM),
				}
			: null;
	if (!testMode && email === null)
		throw new Error("Cloudflare merchant email configuration is required");
	return {
		enabled: true,
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
