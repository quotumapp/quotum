import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteMcpApp } from "../../src/composition/remote-mcp";
import type { MerchantScope, OnboardingDraftView } from "../../src/platform/contracts";
import { MCP_GRANT_CLAIM, McpAuthorizations } from "../../src/platform/mcp/authorization";
import { CSRF_COOKIE } from "../../src/platform/security";
import { assertOpenApiResponse } from "../../tests/helpers/openapi";
import {
	MerchantBrowser,
	merchantFixture,
	merchantTestScope,
	password,
	serviceToken,
	testConfig,
} from "./fixture";

const origin = "https://api.example.test";
const resource = `${origin}/mcp`;
const f = merchantFixture({ mcp: { origin } });
const remote = createRemoteMcpApp({ auth: f.auth, store: f.store, port: f.billingPort });
beforeEach(() => f.reset());
afterAll(() => f.sql.close());
const email = "owner@example.com";
const redirect = "http://localhost:8788/callback";
const clientId = "quotum-claude-code";

/** Native provider continuations are asserted below; platform calls use the contract fixture. */
class OAuthBrowser extends MerchantBrowser {
	async raw(path: string, body?: unknown) {
		const response = await f.app.handle(
			new Request(new URL(path, testConfig.origin), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-quotum-service-token": serviceToken,
					origin: testConfig.origin,
					"x-quotum-client-ip": "192.0.2.10",
					cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
					"x-csrf-token": this.cookies.get(CSRF_COOKIE) ?? "",
					"idempotency-key": crypto.randomUUID(),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
		for (const cookie of response.headers.getSetCookie()) {
			const [pair = ""] = cookie.split(";");
			const index = pair.indexOf("=");
			const name = pair.slice(0, index),
				value = pair.slice(index + 1);
			if (value) this.cookies.set(name, value);
			else this.cookies.delete(name);
		}
		await assertOpenApiResponse(body === undefined ? "GET" : "POST", path, response, {
			requestBody: body,
			requestContentType: body === undefined ? null : "application/json",
		});
		return response;
	}
	async native(path: string, body?: unknown) {
		const response = await this.raw(path, body);
		const result = await response.json();
		if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
		return result;
	}
}

async function owner() {
	const browser = new OAuthBrowser(f);
	await browser.signup(email);
	const organization = await browser.json<OnboardingDraftView>(
		"/api/platform/onboarding/organization",
		{ name: "Acme Company", slug: "acme" },
	);
	const project = await browser.json<OnboardingDraftView>("/api/platform/onboarding/project", {
		name: "Example Project",
		key: "example",
		revision: organization.revision,
	});
	await browser.json("/api/platform/onboarding/provision", { revision: project.revision });
	return browser;
}

async function signIn(browser: OAuthBrowser) {
	// Exercise fresh authentication without waiting for the existing per-user OTP cooldown.
	await f.sql`DELETE FROM platform_rate_limits`;
	const verifier = randomBytes(32).toString("base64url");
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirect,
		scope: "quotum.read offline_access",
		state: crypto.randomUUID(),
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		resource,
	});
	const started = await browser.native(`/api/auth/oauth2/authorize?${query}`);
	const login = new URL(started.url, testConfig.origin);
	expect(login.pathname).toBe("/sign-in");
	const oauth_query = login.search.slice(1);
	await browser.native("/api/auth/sign-in/email", { email, password, oauth_query });
	await browser.native("/api/auth/two-factor/send-otp", {});
	const verified = await browser.native("/api/auth/two-factor/verify-otp", {
		code: f.mailer.otp(email),
		trustDevice: false,
		oauth_query,
	});
	const selection = new URL(verified.url, testConfig.origin);
	expect(selection.pathname).toBe("/oauth/select");
	return { verifier, query: selection.search.slice(1), state: query.get("state") };
}

async function authorize(
	browser: OAuthBrowser,
	scope: MerchantScope = merchantTestScope,
	beforeConsent?: () => Promise<void>,
) {
	const pending = await signIn(browser);
	const context = await browser.json<{ principal: { email: string }; environments: unknown[] }>(
		"/api/platform/oauth/context",
		{ oauth_query: pending.query },
	);
	expect(context.principal.email).toBe(email);
	expect(context.environments.length).toBeGreaterThanOrEqual(1);
	await browser.json("/api/platform/oauth/selection", {
		oauth_query: pending.query,
		scope,
	});
	const continued = await browser.native("/api/auth/oauth2/continue", {
		oauth_query: pending.query,
		postLogin: true,
	});
	const consent = new URL(continued.redirect_uri ?? continued.url, testConfig.origin);
	expect(consent.pathname).toBe("/oauth/consent");
	await beforeConsent?.();
	const accepted = await browser.native("/api/auth/oauth2/consent", {
		oauth_query: consent.search.slice(1),
		accept: true,
	});
	const callback = new URL(accepted.redirect_uri ?? accepted.url);
	expect(callback.origin + callback.pathname).toBe(redirect);
	expect(callback.searchParams.get("state")).toBe(pending.state);
	return {
		code: callback.searchParams.get("code") ?? "",
		verifier: pending.verifier,
		query: consent.search.slice(1),
	};
}

async function token(body: Record<string, string>) {
	const response = await remote.handle(
		new Request(`${origin}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: clientId, resource, ...body }),
		}),
	);
	await assertOpenApiResponse("POST", "/oauth/token", response);
	return response;
}
async function redeem(browser: OAuthBrowser, scope: MerchantScope = merchantTestScope) {
	const code = await authorize(browser, scope);
	const response = await token({
		grant_type: "authorization_code",
		code: code.code,
		code_verifier: code.verifier,
		redirect_uri: redirect,
	});
	const result = await response.json();
	if (!response.ok) throw new Error(`Token failed: ${JSON.stringify(result)}`);
	return result as { access_token: string; refresh_token: string; expires_in: number };
}
function rpc(
	accessToken?: string,
	method = "tools/list",
	params: Record<string, unknown> = {},
	protocolVersion = "2026-07-28",
) {
	return remote.handle(
		new Request(resource, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": protocolVersion,
				"mcp-method": method,
				...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
				...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method,
				params: {
					...params,
					...(protocolVersion === "2026-07-28"
						? {
								_meta: {
									"io.modelcontextprotocol/protocolVersion": protocolVersion,
									"io.modelcontextprotocol/clientCapabilities": {},
									"io.modelcontextprotocol/clientInfo": { name: "quotum-test", version: "1" },
								},
							}
						: {}),
				},
			}),
		}),
	);
}

describe("remote MCP browser authorization", () => {
	it("lets a consented code outlive browser proof freshness, but never its own expiry", async () => {
		const browser = await owner();
		const pending = await authorize(browser, merchantTestScope, async () => {
			await f.sql`UPDATE platform_auth_sessions SET proof_at=now()-interval '295 seconds',expires_at=now()+interval '5 seconds'`;
		});
		f.advance(20_000);
		expect(
			(await browser.request("/api/platform/oauth/context", { oauth_query: pending.query })).status,
		).toBe(401);
		const response = await token({
			grant_type: "authorization_code",
			code: pending.code,
			code_verifier: pending.verifier,
			redirect_uri: redirect,
		});
		expect(response.status, await response.clone().text()).toBe(200);
		expect((await rpc((await response.json()).access_token)).status).toBe(200);
		expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);

		const expired = await authorize(browser);
		const verification = await (await f.auth.$context).internalAdapter.findVerificationValue(
			new McpAuthorizations(f.store).tokenHash(expired.code),
		);
		expect(verification).not.toBeNull();
		await f.sql`UPDATE platform_auth_verifications SET expires_at=now()-interval '1 second' WHERE id=${verification?.id ?? ""}`;
		expect(
			(
				await token({
					grant_type: "authorization_code",
					code: expired.code,
					code_verifier: expired.verifier,
					redirect_uri: redirect,
				})
			).status,
		).toBe(400);
	});

	it("revokes failed issuance and clears its proof and Google tokens when access changes after minting", async () => {
		const browser = await owner();
		const pending = await authorize(browser);
		await f.sql`INSERT INTO platform_auth_accounts(user_id,provider_id,account_id,access_token,refresh_token,id_token) SELECT id,'google','google-owner','private-access','private-refresh','private-id' FROM platform_auth_users WHERE email=${email}`;
		const original = McpAuthorizations.prototype.approve;
		const approve = spyOn(McpAuthorizations.prototype, "approve").mockImplementationOnce(
			async function (this: McpAuthorizations, grant) {
				// The provider persisted the refresh token and built the JWT before this hook.
				expect(await f.sql`SELECT id FROM platform_auth_oauth_refresh_tokens`).toHaveLength(1);
				await f.sql`UPDATE projects SET lifecycle_status='suspended' WHERE id=${grant.project_instance_id}`;
				return original.call(this, grant);
			},
		);
		try {
			const response = await token({
				grant_type: "authorization_code",
				code: pending.code,
				code_verifier: pending.verifier,
				redirect_uri: redirect,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: "invalid_grant" });
			expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);
			expect(
				await f.sql`SELECT id FROM platform_auth_accounts WHERE provider_id='google' AND (access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL)`,
			).toHaveLength(0);
			expect(
				await f.sql`SELECT id FROM platform_mcp_authorizations WHERE revoked_at IS NULL`,
			).toHaveLength(0);
			expect(
				await f.sql`SELECT id FROM platform_auth_oauth_refresh_tokens WHERE revoked IS NULL`,
			).toHaveLength(0);
		} finally {
			approve.mockRestore();
		}
	});

	it("connects, serves read tools and refreshes after deleting the transient proof", async () => {
		const browser = await owner();
		const tokens = await redeem(browser);
		expect(tokens.expires_in).toBe(900);
		const claims = JSON.parse(
			Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString(),
		);
		expect(claims.client_id).toBe(clientId);
		expect(claims.azp).toBe(clientId);
		expect(await f.sql`SELECT id FROM platform_auth_sessions`).toHaveLength(0);
		const response = await rpc(tokens.access_token);
		expect(response.status, await response.clone().text()).toBe(200);
		const result = await response.json();
		expect(result.result.tools).toHaveLength(17);
		const read = await rpc(tokens.access_token, "tools/call", {
			name: "get_project_stats",
			arguments: {},
		});
		expect(read.status).toBe(200);
		expect((await read.json()).result.isError).not.toBe(true);
		const refreshed = await token({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
		});
		expect(refreshed.status).toBe(200);
		const next = await refreshed.json();
		expect((await rpc(next.access_token)).status).toBe(200);
		const listed = await browser.json<{ connections: { id: string }[] }>(
			"/api/platform/mcp/connections/list",
			{ scope: merchantTestScope },
		);
		expect(listed.connections).toHaveLength(1);
		expect(
			await f.sql`SELECT id FROM platform_audit_events WHERE action='mcp.authorized'`,
		).toHaveLength(1);
	});
	it("revokes JWTs and rotated-refresh replay responses immediately, including after reconnect", async () => {
		const browser = await owner();
		const tokens = await redeem(browser);
		const refreshed = await token({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
		});
		expect(refreshed.status).toBe(200);
		const next = await refreshed.json();
		const listed = await browser.json<{ connections: { id: string }[] }>(
			"/api/platform/mcp/connections/list",
			{ scope: merchantTestScope },
		);
		await browser.json("/api/platform/mcp/connections/revoke", {
			scope: merchantTestScope,
			id: listed.connections[0]?.id,
		});
		expect((await rpc(tokens.access_token)).status).toBe(401);
		expect((await rpc(next.access_token)).status).toBe(401);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status,
		).toBe(400);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: next.refresh_token })).status,
		).toBe(400);
		const reconnected = await redeem(browser);
		expect((await rpc(reconnected.access_token)).status).toBe(200);
		expect((await rpc(tokens.access_token)).status).toBe(401);
	});
	it("does not exchange an MCP proof for a console session or change a selected environment", async () => {
		const browser = await owner();
		const pending = await signIn(browser);
		expect((await browser.request("/api/platform/session/exchange", {})).status).toBe(401);
		await browser.json("/api/platform/oauth/selection", {
			oauth_query: pending.query,
			scope: merchantTestScope,
		});
		const other = new URLSearchParams(pending.query);
		other.set("state", "another-tab");
		expect(
			(await browser.request("/api/platform/oauth/context", { oauth_query: other.toString() }))
				.status,
		).toBe(409);
		f.advance(301_000);
		expect(
			(
				await browser.request("/api/platform/oauth/selection", {
					oauth_query: pending.query,
					scope: merchantTestScope,
				})
			).status,
		).toBe(401);
	});
	it("checks absolute expiry before refresh replay and rejects tenant/client claim tampering", async () => {
		const browser = await owner();
		const tokens = await redeem(browser);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status,
		).toBe(200);
		await f.sql`UPDATE platform_mcp_authorizations SET expires_at=now()-interval '1 second',created_at=now()-interval '31 days'`;
		expect((await rpc(tokens.access_token)).status).toBe(401);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status,
		).toBe(400);
		const parts = tokens.access_token.split(".");
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString());
		payload[MCP_GRANT_CLAIM] = crypto.randomUUID();
		parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
		expect((await rpc(parts.join("."))).status).toBe(401);
	});
	it("invalidates grants permanently on principal or membership suspension", async () => {
		const browser = await owner();
		const tokens = await redeem(browser);
		await f.sql`UPDATE platform_memberships SET status='suspended'`;
		await f.sql`UPDATE platform_memberships SET status='active'`;
		expect((await rpc(tokens.access_token)).status).toBe(401);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status,
		).toBe(400);
		const next = await redeem(browser);
		await f.sql`UPDATE platform_principals SET status='suspended'`;
		await f.sql`UPDATE platform_principals SET status='active'`;
		expect((await rpc(next.access_token)).status).toBe(401);
	});
	it("advertises browser discovery without DCR or DPoP and rejects untrusted ingress", async () => {
		const browser = new OAuthBrowser(f);
		for (const redirectUri of [
			"com.example.client:/callback",
			"http://public.example.test/callback",
		]) {
			const query = new URLSearchParams({
				client_id: "https://client.example.test/oauth.json",
				redirect_uri: redirectUri,
				response_type: "code",
				resource,
				code_challenge_method: "S256",
				code_challenge: "A".repeat(43),
			});
			const denied = await browser.raw(`/api/auth/oauth2/authorize?${query}`);
			expect(denied.status).toBe(400);
			expect(await denied.json()).toMatchObject({ error: "invalid_request" });
		}
		expect(
			await f.sql`SELECT client_id FROM platform_auth_oauth_clients WHERE client_id='https://client.example.test/oauth.json'`,
		).toHaveLength(0);
		const challenge = await rpc();
		expect(challenge.status).toBe(401);
		expect(challenge.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
		const document = await (
			await remote.handle(new Request(`${origin}/.well-known/oauth-authorization-server`))
		).json();
		expect(document.authorization_endpoint).toBe(`${testConfig.origin}/oauth/authorize`);
		expect(document.token_endpoint_auth_methods_supported).toEqual(["none"]);
		expect(document.registration_endpoint).toBeUndefined();
		expect(document.dpop_signing_alg_values_supported).toBeUndefined();
		expect(
			(await remote.handle(new Request(resource, { headers: { host: "attacker.example" } })))
				.status,
		).toBe(403);
		expect(
			(
				await remote.handle(
					new Request(resource, { headers: { origin: "https://attacker.example" } }),
				)
			).status,
		).toBe(403);
		expect((await token({ grant_type: "client_credentials" })).status).toBe(400);
	});
	it("contains rotated-token replay and public token revocation to one environment", async () => {
		const browser = await owner();
		await f.sql`UPDATE projects SET lifecycle_status='active' WHERE environment='production'`;
		const sandbox = await redeem(browser);
		const production = await redeem(browser, { ...merchantTestScope, environment: "production" });
		const rotated = await token({
			grant_type: "refresh_token",
			refresh_token: sandbox.refresh_token,
		});
		expect(rotated.status).toBe(200);
		const latest = await rotated.json();
		const replay = await token({
			grant_type: "refresh_token",
			refresh_token: sandbox.refresh_token,
		});
		expect(replay.status).toBe(200);
		expect((await replay.json()).refresh_token).toBe(latest.refresh_token);
		await f.sql`UPDATE platform_auth_oauth_refresh_tokens SET rotation_replay_expires_at=now()-interval '1 second' WHERE token=${new McpAuthorizations(f.store).tokenHash(sandbox.refresh_token)}`;
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: sandbox.refresh_token })).status,
		).toBe(400);
		expect((await rpc(latest.access_token)).status).toBe(401);
		expect((await rpc(production.access_token)).status).toBe(200);
		const productionRefresh = await token({
			grant_type: "refresh_token",
			refresh_token: production.refresh_token,
		});
		expect(productionRefresh.status).toBe(200);
		const productionLatest = await productionRefresh.json();
		const revoke = (value: string) =>
			remote.handle(
				new Request(`${origin}/oauth/revoke`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ client_id: clientId, token: value }),
				}),
			);
		const newSandbox = await redeem(browser);
		expect((await revoke(production.refresh_token)).status).toBe(200);
		expect((await rpc(productionLatest.access_token)).status).toBe(401);
		expect((await rpc(newSandbox.access_token)).status).toBe(200);
		expect((await revoke(production.refresh_token)).status).toBe(200);
		expect((await revoke(newSandbox.access_token)).status).toBe(200);
		expect((await rpc(newSandbox.access_token)).status).toBe(401);
		expect((await revoke("unknown-token")).status).toBe(200);
	});
	it("requires PKCE and the authorized client/resource, and revokes on code reuse", async () => {
		const browser = await owner();
		const invalidRequests: Record<string, string>[] = [
			{ code_verifier: "invalid" },
			{ client_id: "quotum-cursor" },
			{ resource: "https://other.example/mcp" },
		];
		for (const invalid of invalidRequests) {
			const grant = await authorize(browser);
			const denied = await token({
				grant_type: "authorization_code",
				code: grant.code,
				code_verifier: grant.verifier,
				redirect_uri: redirect,
				...invalid,
			});
			expect([400, 401]).toContain(denied.status);
			expect((await denied.json()).access_token).toBeUndefined();
		}
		const grant = await authorize(browser);
		const body = {
			grant_type: "authorization_code",
			code: grant.code,
			code_verifier: grant.verifier,
			redirect_uri: redirect,
		};
		const issued = await token(body);
		expect(issued.status).toBe(200);
		const tokens = await issued.json();
		expect((await rpc(tokens.access_token)).status).toBe(200);
		expect((await token(body)).status).toBe(400);
		expect((await rpc(tokens.access_token)).status).toBe(401);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status,
		).toBe(400);
	});
	it("revokes a concurrent code redemption's JWT without touching a sibling grant", async () => {
		const browser = await owner();
		const sibling = await redeem(browser);
		const pending = await authorize(browser);
		const binding = new McpAuthorizations(f.store);
		const codeHash = binding.tokenHash(pending.code);
		const context = await f.auth.$context;
		const original = context.internalAdapter;
		const firstAtConsume = Promise.withResolvers<void>();
		const bothAtConsume = Promise.withResolvers<void>();
		const finishReplay = Promise.withResolvers<void>();
		let arrivals = 0;
		// Hold consumption until both requests passed the non-atomic precheck. Let the
		// first finish issuing its JWT before the losing request reaches atomic consume.
		const adapter = {
			...original,
			async consumeVerificationValue(identifier: string) {
				if (identifier === codeHash) {
					arrivals += 1;
					if (arrivals === 1) {
						firstAtConsume.resolve();
						await bothAtConsume.promise;
					} else {
						bothAtConsume.resolve();
						await finishReplay.promise;
					}
				}
				return original.consumeVerificationValue(identifier);
			},
		};
		context.internalAdapter = adapter;
		const request = {
			grant_type: "authorization_code",
			code: pending.code,
			code_verifier: pending.verifier,
			redirect_uri: redirect,
		};
		try {
			const first = token(request);
			await firstAtConsume.promise;
			const replay = token(request);
			const issued = await first;
			expect(issued.status).toBe(200);
			const tokens = await issued.json();
			expect((await rpc(tokens.access_token)).status).toBe(200);
			finishReplay.resolve();
			expect((await replay).status).toBe(400);
			expect(arrivals).toBe(2);
			expect(context.internalAdapter).toBe(adapter);
			expect((await rpc(tokens.access_token)).status).toBe(401);
			expect(
				(await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status,
			).toBe(400);
			expect((await rpc(sibling.access_token)).status).toBe(200);
			expect(
				(await token({ grant_type: "refresh_token", refresh_token: sibling.refresh_token })).status,
			).toBe(200);
		} finally {
			bothAtConsume.resolve();
			finishReplay.resolve();
			context.internalAdapter = original;
		}
	});
	it("serves older protocol messages and enforces body caps, live environment access and password reset", async () => {
		const browser = await owner();
		const tokens = await redeem(browser);
		const legacy = await rpc(tokens.access_token, "tools/list", {}, "2025-11-25");
		expect(legacy.status).toBe(200);
		expect(await legacy.text()).toContain("get_project_stats");
		const oversized = await remote.handle(
			new Request(resource, {
				method: "POST",
				headers: {
					authorization: `Bearer ${tokens.access_token}`,
					"content-type": "application/json",
				},
				body: "x".repeat(256 * 1024 + 1),
			}),
		);
		expect(oversized.status).toBe(413);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: "x".repeat(16 * 1024) })).status,
		).toBe(413);
		await f.sql`UPDATE projects SET lifecycle_status='suspended' WHERE environment='sandbox'`;
		expect((await rpc(tokens.access_token)).status).toBe(403);
		await f.sql`UPDATE projects SET lifecycle_status='active' WHERE environment='sandbox'`;
		await browser.json("/api/auth/request-password-reset", {
			email,
			redirectTo: `${testConfig.origin}/reset-password`,
		});
		await browser.json("/api/auth/reset-password", {
			token: f.mailer.link("reset", email),
			newPassword: `${password}-changed`,
		});
		expect((await rpc(tokens.access_token)).status).toBe(401);
		expect(
			(await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status,
		).toBe(400);
	});
});
