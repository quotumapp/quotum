import Stripe from "stripe";
import { z } from "zod";
import type { StripeOAuthPort } from "../platform/connections/oauth-port";

/** Stripe Apps OAuth v2. Configuration identifies Quotum's app, never a customer's account. */
export function createStripeOAuthPort(
	env: Record<string, string | undefined> = process.env,
): StripeOAuthPort | null {
	if (!env.STRIPE_APP_CLIENT_ID) return null;
	const clientId = z.string().min(1).parse(env.STRIPE_APP_CLIENT_ID);
	const redirect = z.url().parse(env.STRIPE_APP_REDIRECT_URI);
	if (new URL(redirect).protocol !== "https:")
		throw new Error("Stripe app redirect must use HTTPS");
	const config = (environment: "sandbox" | "production") => {
		const mode = environment === "production" ? "LIVE" : "TEST";
		const apiKey = env[`STRIPE_APP_${mode}_API_KEY`],
			webhookSecret = env[`STRIPE_APP_${mode}_WEBHOOK_SECRET`];
		if (
			!apiKey?.startsWith(environment === "production" ? "sk_live_" : "sk_test_") ||
			!webhookSecret
		)
			throw new Error("Stripe app mode configuration is unavailable");
		return { apiKey, webhookSecret };
	};
	const tokens = async (environment: "sandbox" | "production", body: URLSearchParams) => {
		const response = await fetch("https://api.stripe.com/v1/oauth/token", {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
			headers: {
				authorization: `Bearer ${config(environment).apiKey}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
		});
		if (!response.ok) throw new Error("Stripe app authorization failed");
		const result = z
			.object({
				access_token: z.string().min(1),
				refresh_token: z.string().min(1),
				expires_in: z.number().positive().default(3600),
				stripe_user_id: z.string().optional(),
				livemode: z.boolean(),
			})
			.parse(await response.json());
		if (result.livemode !== (environment === "production"))
			throw new Error("Stripe app mode mismatch");
		const account = await new Stripe(result.access_token, {
			timeout: 10_000,
			maxNetworkRetries: 0,
		}).accounts.retrieve(null);
		if (result.stripe_user_id && account.id !== result.stripe_user_id)
			throw new Error("Stripe account mismatch");
		return {
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt: Date.now() + result.expires_in * 1000,
			accountId: account.id,
			livemode: result.livemode,
		};
	};
	return {
		authorize(environment, state) {
			config(environment);
			const url = new URL(
				z
					.url()
					.parse(
						env[
							environment === "production"
								? "STRIPE_APP_LIVE_AUTHORIZE_URL"
								: "STRIPE_APP_TEST_AUTHORIZE_URL"
						],
					),
			);
			if (
				url.origin !== "https://marketplace.stripe.com" ||
				url.pathname !== "/oauth/v2/authorize" ||
				url.username ||
				url.password
			)
				throw new Error("Use the Stripe Dashboard OAuth install URL");
			url.searchParams.set("client_id", clientId);
			url.searchParams.set("redirect_uri", redirect);
			url.searchParams.set("state", state);
			return url.toString();
		},
		exchange: (environment, code) =>
			tokens(environment, new URLSearchParams({ grant_type: "authorization_code", code })),
		refresh: (environment, refresh_token) =>
			tokens(environment, new URLSearchParams({ grant_type: "refresh_token", refresh_token })),
		webhookSecret: (environment) => config(environment).webhookSecret,
	};
}
