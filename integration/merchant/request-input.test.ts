import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createRemoteMcpApp } from "../../src/composition/remote-mcp";
import { CSRF_COOKIE } from "../../src/platform/security";
import {
	MerchantBrowser,
	merchantFixture,
	merchantTestScope,
	onboard,
	serviceToken,
	testConfig,
} from "./fixture";

const origin = "https://api.example.test";
const f = merchantFixture({ mcp: { origin, writesEnabled: true } });
const remote = createRemoteMcpApp({ auth: f.auth, store: f.store, port: f.billingPort });
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

/** A signed-in browser session that sends bodies and URLs exactly as given. */
async function signedIn() {
	const browser = new MerchantBrowser(f);
	await onboard(browser);
	return (path: string, options: { method?: string; contentType?: string; body?: string } = {}) =>
		f.app
			.handle(
				new Request(new URL(path, testConfig.origin), {
					method: options.method ?? (options.body === undefined ? "GET" : "POST"),
					headers: {
						accept: "application/json",
						"content-type": options.contentType ?? "application/json",
						"x-quotum-service-token": serviceToken,
						origin: testConfig.origin,
						"x-quotum-client-ip": "192.0.2.10",
						cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
						"x-csrf-token": browser.cookies.get(CSRF_COOKIE) ?? "",
						"idempotency-key": crypto.randomUUID(),
					},
					body: options.body,
				}),
			)
			.then(async (response) => ({
				status: response.status,
				body: (await response.json().catch(() => null)) as {
					success?: boolean;
					error?: { code?: string };
				} | null,
			}));
}

const list = "/api/platform/mcp/connections/list";
const authRoute = "/api/auth/request-password-reset";

describe("merchant request text and URLs", () => {
	it("lists connections for a valid scope and answers 400, not 503, for text Postgres cannot store", async () => {
		const send = await signedIn();
		const valid = await send(list, { body: JSON.stringify({ scope: merchantTestScope }) });
		expect(valid.status).toBe(200);
		for (const field of ["organizationSlug", "projectKey"] as const) {
			for (const value of ["\u0000", "\ud800", "acme\u0000", "\u0000".repeat(3)]) {
				const result = await send(list, {
					body: JSON.stringify({ scope: { ...merchantTestScope, [field]: value } }),
				});
				expect({ field, value: JSON.stringify(value), status: result.status }).toEqual({
					field,
					value: JSON.stringify(value),
					status: 400,
				});
				expect(result.body?.error?.code).toBe("INVALID_REQUEST");
			}
		}
		// An oversized slug cannot exist; it is refused or not found, never a service failure.
		const oversized = await send(list, {
			body: JSON.stringify({ scope: { ...merchantTestScope, organizationSlug: "x".repeat(1000) } }),
		});
		expect(oversized.status).toBeLessThan(500);
	});

	it("refuses unstorable keys and nested strings in any merchant JSON body", async () => {
		const send = await signedIn();
		// Auth routes take a loose JSON object; before, only its top-level strings were checked.
		for (const body of [
			'{"\\u0000":1}',
			'{"a":["ok",{"b":"\\ud800"}]}',
			'{"a":{"b":{"c":"x\\u0000"}}}',
		]) {
			const result = await send(authRoute, { body });
			expect({ body, status: result.status }).toEqual({ body, status: 400 });
			expect(result.body?.error?.code).toBe("INVALID_REQUEST");
		}
		const nested = `${"[".repeat(20_000)}${"]".repeat(20_000)}`;
		const deep = await send(authRoute, { body: nested });
		expect(deep.status).toBeLessThan(500);
		// Text that merely looks unusual is stored: accents, emoji and escaped quotes.
		const fine = await send(authRoute, {
			body: JSON.stringify({ email: "nobody@example.com", note: 'caf\u00e9 \u{1f600} "quoted"' }),
		});
		expect(fine.status).toBeLessThan(500);
		expect(fine.body?.error?.code).not.toBe("INVALID_REQUEST");
	});

	it("refuses an encoded NUL in any merchant URL before routing", async () => {
		const send = await signedIn();
		for (const path of [
			"/api/platform/provisioning/%00",
			"/api/platform/step-up/%00",
			"/api/platform/config?x=%00",
			"/api/billing/billing-accounts/%00/balances/credits",
			"/api/billing/billing-accounts/acme?q=%00",
			"/api/auth/oauth2/authorize?client_id=%00",
		]) {
			const result = await send(path);
			expect({ path, status: result.status }).toEqual({ path, status: 400 });
			expect(result.body?.error?.code).toBe("INVALID_REQUEST");
		}
		const post = await send("/api/platform/team/invitations/%00/revoke", { body: "{}" });
		expect(post.status).toBe(400);
	});

	it("refuses unstorable text in remote MCP OAuth forms", async () => {
		for (const form of ["token=%00&client_id=quotum-claude-code", "token=abc&client_id=%00"]) {
			const response = await remote.handle(
				new Request(`${origin}/oauth/revoke`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form,
				}),
			);
			expect({ form, status: response.status }).toEqual({ form, status: 400 });
		}
	});
});
