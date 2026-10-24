import { describe, expect, it } from "bun:test";
import { createStripeOAuthPort } from "../../src/composition/stripe-oauth";

const env = {
	STRIPE_APP_CLIENT_ID: "ca_test",
	STRIPE_APP_ID: "app_quotum",
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

	it("requires the Stripe App resource id when OAuth is enabled", () => {
		for (const appId of [undefined, "ca_oauth-client", "com.example.app"])
			expect(() => createStripeOAuthPort({ ...env, STRIPE_APP_ID: appId })).toThrow();
	});

	it.each(["sandbox", "production"] as const)(
		"reads %s installations using the developer key",
		async (environment) => {
			let requestUrl = "";
			let authorization = "";
			const port = createStripeOAuthPort(env, {
				fetch: Object.assign(
					async (url: URL | RequestInfo, init?: RequestInit) => {
						requestUrl = String(url);
						authorization = new Headers(init?.headers).get("authorization") ?? "";
						return Response.json({
							has_more: false,
							data: [
								{
									object: "apps.install",
									account: "acct_customer",
									app: "app_quotum",
									livemode: environment === "production",
									status: "installed",
								},
							],
						});
					},
					{ preconnect: fetch.preconnect },
				),
			});
			expect(await port?.installationStatus(environment, "acct_customer")).toBe("installed");
			const url = new URL(requestUrl);
			expect(url.pathname).toBe("/v1/apps/installs");
			expect(Object.fromEntries(url.searchParams)).toEqual({
				app: "app_quotum",
				account: "acct_customer",
				limit: "100",
			});
			expect(authorization).toBe(
				`Bearer ${environment === "production" ? env.STRIPE_APP_LIVE_API_KEY : env.STRIPE_APP_TEST_API_KEY}`,
			);
		},
	);

	it("requires a complete successful empty installation list to prove absence", async () => {
		const install = {
			object: "apps.install",
			account: "acct_customer",
			app: "app_quotum",
			livemode: false,
			status: "installed",
		};
		const scenarios = [
			{ response: { has_more: false, data: [] }, expected: "absent" },
			...[
				"installing",
				"install_failed",
				"uninstalling",
				"uninstall_failed",
				"uninstalled",
				"future_status",
			].map((status) => ({
				response: { has_more: false, data: [{ ...install, status }] },
				expected: "indeterminate",
			})),
			{ response: { has_more: true, data: [install] }, expected: "indeterminate" },
			...[{ account: "acct_other" }, { app: "app_other" }, { livemode: true }].map((change) => ({
				response: { has_more: false, data: [{ ...install, ...change }] },
				expected: "indeterminate",
			})),
			{ response: { data: [] }, expected: "indeterminate" },
		];
		for (const scenario of scenarios) {
			const port = createStripeOAuthPort(env, {
				fetch: Object.assign(async () => Response.json(scenario.response), {
					preconnect: fetch.preconnect,
				}),
			});
			expect(String(await port?.installationStatus("sandbox", "acct_customer"))).toBe(
				scenario.expected,
			);
		}
	});

	it.each([401, 403, 429, 500, 503])(
		"does not interpret HTTP %s as an absent installation",
		async (status) => {
			const port = createStripeOAuthPort(env, {
				fetch: Object.assign(
					async () =>
						Response.json(
							{ error: { message: "private-provider-message", type: "api_error" } },
							{ status },
						),
					{ preconnect: fetch.preconnect },
				),
			});
			expect(await port?.installationStatus("sandbox", "acct_customer")).toBe("indeterminate");
		},
	);

	it("defers network failures and malformed provider responses", async () => {
		for (const response of ["malformed", "timeout"]) {
			const port = createStripeOAuthPort(env, {
				fetch: Object.assign(
					async () => {
						if (response === "timeout") throw new Error("request timed out");
						return new Response("not-json");
					},
					{ preconnect: fetch.preconnect },
				),
			});
			expect(await port?.installationStatus("sandbox", "acct_customer")).toBe("indeterminate");
		}
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
		await expect(port?.exchange("sandbox", "code")).rejects.toBeInstanceOf(SyntaxError);
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
		await expect(missingRefresh?.exchange("sandbox", "code")).rejects.toMatchObject({
			issues: [expect.objectContaining({ path: ["refresh_token"] })],
		});
	});

	it("selects production keys and rejects http authorize URLs", () => {
		expect(() =>
			createStripeOAuthPort({
				...env,
				STRIPE_APP_LIVE_AUTHORIZE_URL: "http://marketplace.stripe.com/oauth/v2/authorize",
			})?.authorize("production", "state"),
		).toThrow("Use the Stripe Dashboard OAuth install URL");
		const port = createStripeOAuthPort(env);
		expect(port?.webhookSecret("production")).toBe("whsec_live");
		expect(port?.webhookSecret("sandbox")).toBe("whsec_test");
	});
});
