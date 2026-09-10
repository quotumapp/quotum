import { describe, expect, it } from "bun:test";
import { createStripeOAuthPort } from "../../src/composition/stripe-oauth";

const env = {
	STRIPE_APP_CLIENT_ID: "ca_test",
	STRIPE_APP_REDIRECT_URI: "https://app.quotum.dev/stripe/callback",
	STRIPE_APP_TEST_API_KEY: "sk_test_oauth",
	STRIPE_APP_TEST_WEBHOOK_SECRET: "whsec_test",
	STRIPE_APP_LIVE_API_KEY: "sk_live_oauth",
	STRIPE_APP_LIVE_WEBHOOK_SECRET: "whsec_live",
	STRIPE_APP_TEST_AUTHORIZE_URL: "https://marketplace.stripe.com/oauth/v2/authorize",
	STRIPE_APP_LIVE_AUTHORIZE_URL: "https://marketplace.stripe.com/oauth/v2/authorize",
};

describe("createStripeOAuthPort", () => {
	it("returns null without STRIPE_APP_CLIENT_ID", () => {
		expect(createStripeOAuthPort({})).toBeNull();
	});

	it("builds a Stripe marketplace authorize URL", () => {
		const port = createStripeOAuthPort(env);
		const url = new URL(port?.authorize("sandbox", "state-1") ?? "");
		expect(url.origin).toBe("https://marketplace.stripe.com");
		expect(url.searchParams.get("client_id")).toBe("ca_test");
		expect(url.searchParams.get("state")).toBe("state-1");
	});

	it("posts exchange and refresh without leaking error bodies", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = Object.assign(
			async (url: URL | RequestInfo, init?: RequestInit) => {
				requests.push({ url: String(url), init: init ?? {} });
				return new Response("secret-error-body", { status: 400 });
			},
			{ preconnect: fetch.preconnect },
		);
		const port = createStripeOAuthPort(env, { fetch: fetchImpl });
		await expect(port?.exchange("sandbox", "code_1")).rejects.toThrow(
			"Stripe app authorization failed",
		);
		expect(String(requests[0]?.init.body)).toContain("grant_type=authorization_code");
		expect(String(requests[0]?.init.body)).toContain("code=code_1");
		await expect(port?.exchange("sandbox", "code_1")).rejects.not.toThrow(/secret-error-body/);
		await expect(port?.refresh("sandbox", "rt_1")).rejects.toThrow(
			"Stripe app authorization failed",
		);
		expect(String(requests.at(-1)?.init.body)).toContain("grant_type=refresh_token");
	});

	it("rejects malformed JSON and missing refresh tokens", async () => {
		const port = createStripeOAuthPort(env, {
			fetch: Object.assign(async () => new Response("not-json", { status: 200 }), {
				preconnect: fetch.preconnect,
			}),
		});
		await expect(port?.exchange("sandbox", "code")).rejects.toThrow();
		const missingRefresh = createStripeOAuthPort(env, {
			fetch: Object.assign(
				async () =>
					Response.json({
						access_token: "sk_test_1",
						expires_in: 3600,
						livemode: false,
					}),
				{ preconnect: fetch.preconnect },
			),
		});
		await expect(missingRefresh?.exchange("sandbox", "code")).rejects.toThrow();
	});

	it("selects production keys and rejects http authorize URLs", () => {
		expect(() =>
			createStripeOAuthPort({
				...env,
				STRIPE_APP_LIVE_AUTHORIZE_URL: "http://marketplace.stripe.com/oauth/v2/authorize",
			})?.authorize("production", "state"),
		).toThrow();
		const port = createStripeOAuthPort(env);
		expect(port?.webhookSecret("production")).toBe("whsec_live");
		expect(port?.webhookSecret("sandbox")).toBe("whsec_test");
	});
});
