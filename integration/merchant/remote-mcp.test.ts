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
const f = merchantFixture({ mcp: { origin, writesEnabled: true } });
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

async function createBillingAccount(environment: "sandbox" | "production" = "sandbox") {
	expect(
		await f.sql`INSERT INTO customers(project_id,billing_account_id) SELECT id,'customer-a' FROM projects WHERE environment=${environment} RETURNING id`,
	).toHaveLength(1);
}

async function signIn(browser: OAuthBrowser, write = false) {
	// Exercise fresh authentication without waiting for the existing per-user OTP cooldown.
	await f.sql`DELETE FROM platform_rate_limits`;
	const verifier = randomBytes(32).toString("base64url");
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirect,
		scope: write ? "quotum.read offline_access quotum.billing.write" : "quotum.read offline_access",
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
	write = false,
	consentScope?: string,
) {
	const pending = await signIn(browser, write);
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
		...(consentScope === undefined ? {} : { scope: consentScope }),
	});
	const callback = new URL(accepted.redirect_uri ?? accepted.url);
	expect(callback.origin + callback.pathname).toBe(redirect);
	expect(callback.searchParams.get("state")).toBe(pending.state);
	expect(callback.searchParams.get("iss")).toBe(origin);
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
async function redeem(
	browser: OAuthBrowser,
	scope: MerchantScope = merchantTestScope,
	write = false,
	consentScope?: string,
) {
	const code = await authorize(browser, scope, undefined, write, consentScope);
	const response = await token({
		grant_type: "authorization_code",
		code: code.code,
		code_verifier: code.verifier,
		redirect_uri: redirect,
	});
	const result = await response.json();
	if (!response.ok) throw new Error(`Token failed: ${JSON.stringify(result)}`);
	return result as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		scope?: string;
	};
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
		expect(document.issuer).toBe(origin);
		expect(document.authorization_response_iss_parameter_supported).toBe(true);
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

describe("remote MCP protocol errors", () => {
	it("answers a wrong method with 405 and Allow, and an unknown path with 404, without a report", async () => {
		const reports: unknown[] = [];
		const quiet = createRemoteMcpApp({
			auth: f.auth,
			store: f.store,
			port: f.billingPort,
			onUnexpectedError: (error) => reports.push(error),
		});
		for (const [method, path, allow] of [
			["GET", "/oauth/token", "POST"],
			["PUT", "/oauth/token", "POST"],
			["GET", "/oauth/revoke", "POST"],
			["POST", "/oauth/jwks", "GET, HEAD"],
			["POST", "/.well-known/oauth-authorization-server", "GET, HEAD"],
			["DELETE", "/.well-known/oauth-protected-resource", "GET, HEAD"],
		] as const) {
			const response = await quiet.handle(new Request(`${origin}${path}`, { method }));
			expect(response.status, `${method} ${path}`).toBe(405);
			expect(response.headers.get("allow"), `${method} ${path}`).toBe(allow);
			expect(await response.json()).toEqual({
				error: "invalid_request",
				error_description: `This endpoint accepts ${allow}.`,
			});
		}
		const unknown = await quiet.handle(new Request(`${origin}/oauth/unknown`));
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({
			error: "not_found",
			error_description: "Route not found.",
		});
		expect(reports).toEqual([]);
	});

	it("answers Better Auth's own token rate limit in the OAuth error shape", async () => {
		let limited: Response | undefined;
		for (let attempt = 0; attempt < 150 && limited === undefined; attempt++) {
			const response = await token({
				grant_type: "refresh_token",
				refresh_token: `invalid-${attempt}`,
			});
			if (response.status === 429) limited = response;
		}
		expect(limited).toBeDefined();
		expect(limited?.headers.get("content-type")).toContain("application/json");
		expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(await limited?.json()).toEqual({
			error: "RATE_LIMITED",
			error_description: "Too many attempts. Please try again later.",
		});
	});

	it("limits each forwarded client on its own only when proxy headers are trusted", async () => {
		const proxied = createRemoteMcpApp({
			auth: f.auth,
			store: f.store,
			port: f.billingPort,
			trustProxyHeaders: true,
		});
		const post = (app: typeof remote, client: string, path: string, body: string) =>
			app.handle(
				new Request(`${origin}${path}`, {
					method: "POST",
					headers: {
						"content-type":
							path === "/mcp" ? "application/json" : "application/x-www-form-urlencoded",
						"x-forwarded-for": client,
					},
					body,
				}),
			);
		const garbage = (attempt: number) =>
			new URLSearchParams({
				client_id: clientId,
				resource,
				grant_type: "refresh_token",
				refresh_token: `invalid-${attempt}`,
			}).toString();
		// The sign-in library's token limit: one client's failures do not lock out the next.
		let limited = false;
		for (let attempt = 0; attempt < 150 && !limited; attempt++) {
			limited =
				(await post(proxied, "203.0.113.7", "/oauth/token", garbage(attempt))).status === 429;
		}
		expect(limited).toBe(true);
		expect((await post(proxied, "203.0.113.8", "/oauth/token", garbage(0))).status).not.toBe(429);
		// The endpoints' own limit of 300 requests a minute, which the token requests counted in.
		limited = false;
		for (let attempt = 0; attempt < 301 && !limited; attempt++) {
			limited = (await post(proxied, "203.0.113.7", "/mcp", "{}")).status === 429;
		}
		expect(limited).toBe(true);
		expect((await post(proxied, "203.0.113.8", "/mcp", "{}")).status).toBe(401);
		// Without the setting a forwarding header is the caller's own claim and is ignored: every
		// request counts against the connecting address, whatever the header names.
		const last = { status: 0 };
		for (let attempt = 0; attempt < 301; attempt++) {
			last.status = (await post(remote, `198.51.100.${attempt % 250}`, "/mcp", "{}")).status;
		}
		expect(last.status).toBe(429);
	}, 60_000);
});

describe("MCP browser-approved writes", () => {
	it("refuses proposal text Postgres cannot store as invalid input, not as an outage", async () => {
		const browser = await owner();
		const tokens = await redeem(browser, merchantTestScope, true);
		await createBillingAccount();
		const [grant] = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		const proposal = {
			requestKey: "entity-nul",
			reason: "Allocate credits to a team",
			change: {
				action: "entities.write",
				parameters: ["customer-a"],
				body: { externalId: "team-a", kind: "team" },
			},
		};
		const attempts = {
			requestKey: { ...proposal, requestKey: "entity\u0000nul" },
			reason: { ...proposal, reason: "Allocate\u0000credits" },
			parameter: { ...proposal, change: { ...proposal.change, parameters: ["customer\u0000a"] } },
			body: {
				...proposal,
				change: { ...proposal.change, body: { externalId: "team\u0000a", kind: "team" } },
			},
			surrogate: { ...proposal, reason: "Allocate \ud800 credits" },
		};
		for (const [name, args] of Object.entries(attempts)) {
			const reply = await (
				await rpc(tokens.access_token, "tools/call", {
					name: "prepare_billing_change",
					arguments: args,
				})
			).json();
			expect(reply.result.isError, name).toBe(true);
			expect(JSON.stringify(reply.result), name).not.toContain("BILLING_API_UNAVAILABLE");
		}
		await expect(
			f.mcpChanges.prepare(grant.id, {
				requestKey: "entity-nul",
				reason: "Allocate credits",
				action: "entities.write",
				parameters: ["customer-a"],
				body: { externalId: "team\u0000a", kind: "team" },
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		expect(await f.sql`SELECT id FROM platform_mcp_changes`).toHaveLength(0);
	});

	it("requires write consent and applies an immutable entity proposal only once", async () => {
		const browser = await owner();
		const tokens = await redeem(browser, merchantTestScope, true);
		const [grant] = await f.sql<
			{ id: string; scopes: string[] }[]
		>`SELECT * FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		expect(grant.scopes).toContain("quotum.billing.write");
		const input = {
			requestKey: "entity-a",
			reason: "Allocate credits to a team",
			action: "entities.write",
			parameters: ["customer-a"],
			body: { externalId: "team-a", kind: "team" },
		};
		await expect(f.mcpChanges.prepare(grant.id, input)).rejects.toMatchObject({
			code: "BILLING_CHANGE_PREVIEW_FAILED",
			status: 404,
		});
		expect(await f.sql`SELECT id FROM customers`).toHaveLength(0);
		expect(await f.sql`SELECT id FROM platform_mcp_changes`).toHaveLength(0);
		await createBillingAccount();
		const inventory = await (await rpc(tokens.access_token)).json();
		expect(
			inventory.result.tools.some(
				(tool: { name: string }) => tool.name === "prepare_billing_change",
			),
		).toBe(true);
		expect(
			inventory.result.tools.some((tool: { name: string }) => /execute|approve/.test(tool.name)),
		).toBe(false);
		const prepared = await (
			await rpc(tokens.access_token, "tools/call", {
				name: "prepare_billing_change",
				arguments: {
					requestKey: input.requestKey,
					reason: input.reason,
					change: { action: input.action, parameters: input.parameters, body: input.body },
				},
			})
		).json();
		expect(prepared.result.isError).toBeUndefined();
		// Stored as JSON, not as text that holds JSON: a prepared statement types a bound string by
		// its cast, and the driver would encode a string bound straight to jsonb a second time.
		const [stored] = await f.sql<Record<string, string>[]>`
			SELECT jsonb_typeof(c.parameters) AS parameters, jsonb_typeof(c.body) AS body,
				jsonb_typeof(c.preview) AS preview, jsonb_typeof(c.scope) AS scope,
				jsonb_typeof(g.scopes) AS scopes
			FROM platform_mcp_changes c
			JOIN platform_mcp_authorizations g ON g.id = c.authorization_id`;
		expect(stored).toEqual({
			parameters: "array",
			body: "object",
			preview: "object",
			scope: "object",
			scopes: "array",
		});
		const change = await f.mcpChanges.prepare(grant.id, input);
		expect(JSON.parse(prepared.result.content[0].text).id).toBe(change.id);
		expect(await f.sql`SELECT id FROM entities`).toHaveLength(0);
		expect(await f.sql`SELECT * FROM billing_administration_receipts`).toHaveLength(0);
		expect(change.status).toBe("pending");
		expect((await f.mcpChanges.prepare(grant.id, input)).id).toBe(change.id);
		await expect(f.mcpChanges.prepare(grant.id, { ...input, reason: "Changed" })).rejects.toThrow(
			"new request key",
		);
		const reviewed = await browser.json<{ status: string; body?: unknown }>(
			`/api/platform/mcp/changes/${change.id}`,
		);
		expect(reviewed.status).toBe("pending");
		// The approval page is told what the app asked for. The tool results are not: the agent that
		// wrote the request has it, and a long one would push a result past the size cap.
		expect(reviewed.body).toEqual(input.body);
		expect(change).not.toHaveProperty("body");
		expect(JSON.parse(prepared.result.content[0].text)).not.toHaveProperty("body");
		expect(await f.mcpChanges.get(grant.id, change.id)).not.toHaveProperty("body");
		expect(await f.mcpChanges.list(grant.id)).toEqual([
			expect.not.objectContaining({ body: expect.anything() }),
		]);
		const response = await browser.json<{ status: string; body?: unknown }>(
			`/api/platform/mcp/changes/${change.id}/approve`,
			{ requestHash: change.requestHash },
		);
		expect(response.status).toBe("completed");
		expect(response.body).toEqual(input.body);
		expect(
			(
				await browser.json<{ status: string }>(`/api/platform/mcp/changes/${change.id}/approve`, {
					requestHash: change.requestHash,
				})
			).status,
		).toBe("completed");
		const receipt =
			await f.sql`SELECT response FROM billing_administration_receipts WHERE operation_key=${`mcp:${change.id}`}`;
		expect(receipt).toHaveLength(1);
		expect(
			await f.sql`SELECT jsonb_typeof(result) AS result FROM platform_mcp_changes WHERE id=${change.id}`,
		).toEqual([{ result: "object" }]);
		await f.sql`UPDATE platform_mcp_changes SET status='applying',result=NULL WHERE id=${change.id}`;
		expect((await f.mcpChanges.get(grant.id, change.id)).status).toBe("completed");
		// The recovered result is stored the same way as an applied one.
		expect(
			await f.sql`SELECT jsonb_typeof(result) AS result FROM platform_mcp_changes WHERE id=${change.id}`,
		).toEqual([{ result: "object" }]);
	});
	async function until(condition: () => boolean | Promise<boolean>, what: string) {
		const deadline = Date.now() + 10_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`Expected ${what}`);
			await Bun.sleep(20);
		}
	}

	/** How many database sessions wait on a lock. */
	async function lockWaiters() {
		const [row] = await f.client<
			{ n: number }[]
		>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
		return row?.n ?? 0;
	}

	const waiters = (count: number) =>
		until(async () => (await lockWaiters()) >= count, `${count} sessions waiting on a lock`);

	/**
	 * Holds the grant row so a proposal and a browser approval of another queue behind it, then
	 * releases both at once: any lock order that differs between them deadlocks (SQLSTATE 40P01).
	 */
	async function proposalAndApprovalRace(replace: boolean) {
		const browser = await owner();
		await createBillingAccount();
		await redeem(browser, merchantTestScope, true);
		const [grant] = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_mcp_authorizations WHERE scopes ? 'quotum.billing.write' AND approved_at IS NOT NULL`;
		const input = {
			requestKey: "entity-a",
			reason: "Team setup",
			action: "entities.write",
			parameters: ["customer-a"],
			body: { externalId: "team-a", kind: "team" },
		};
		const change = await f.mcpChanges.prepare(grant.id, input);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = () => {};
		const holding = new Promise<void>((resolve) => {
			held = resolve;
		});
		const holder = f.client.begin(async (tx) => {
			await tx`SELECT id FROM platform_mcp_authorizations WHERE id = ${grant.id} FOR UPDATE`;
			held();
			await gate;
		});
		await holding;
		const settle = <T>(promise: Promise<T>) =>
			promise.then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
		const proposal = settle(
			f.mcpChanges.prepare(grant.id, {
				...input,
				requestKey: "entity-b",
				body: { externalId: "team-b", kind: "team" },
				...(replace ? { replacesChangeId: change.id } : {}),
			}),
		);
		await waiters(1);
		const approval = settle(
			browser.request(`/api/platform/mcp/changes/${change.id}/approve`, {
				requestHash: change.requestHash,
			}),
		);
		await waiters(2);
		release();
		await holder;
		const [proposed, approved] = await Promise.all([proposal, approval]);
		return { change, proposed, approved };
	}

	it("serializes a replacement and the approval of the proposal it replaces", async () => {
		const { change, proposed, approved } = await proposalAndApprovalRace(true);
		expect(proposed.ok).toBe(true);
		// Never a 503 from a deadlock: the approval either applied first or finds it cancelled.
		expect(approved.ok && approved.value.status).toBeLessThan(500);
		const [row] = await f.sql<
			{ status: string }[]
		>`SELECT status FROM platform_mcp_changes WHERE id = ${change.id}`;
		expect(["cancelled", "completed"]).toContain(row?.status as string);
		expect(await f.sql`SELECT id FROM platform_mcp_changes WHERE status = 'pending'`).toHaveLength(
			1,
		);
	});

	it("serializes a new proposal and the approval of another proposal on the same grant", async () => {
		const { change, proposed, approved } = await proposalAndApprovalRace(false);
		expect(proposed.ok).toBe(true);
		expect(approved.ok && approved.value.status).toBeLessThan(500);
		const [row] = await f.sql<
			{ status: string }[]
		>`SELECT status FROM platform_mcp_changes WHERE id = ${change.id}`;
		expect(row?.status).toBe("completed");
	});

	it("serializes a second approval behind one that is recording its result", async () => {
		const browser = await owner();
		await createBillingAccount();
		await redeem(browser, merchantTestScope, true);
		const [grant] = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_mcp_authorizations WHERE scopes ? 'quotum.billing.write' AND approved_at IS NOT NULL`;
		const change = await f.mcpChanges.prepare(grant.id, {
			requestKey: "entity-a",
			reason: "Team setup",
			action: "entities.write",
			parameters: ["customer-a"],
			body: { externalId: "team-a", kind: "team" },
		});
		const port = f.billingPort.changes;
		if (!port) throw new Error("Billing change port missing");
		/** A point where the first approval stops until the test lets it continue. */
		const stop = () => {
			let resume = () => {};
			const resumed = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const point = { reached: false, resume, resumed };
			return point;
		};
		const applying = stop();
		const recording = stop();
		const apply = port.apply.bind(port);
		const audit = f.store.audit.bind(f.store);
		const spies = [
			// Before the change is applied: the proposal is claimed, nothing is locked.
			spyOn(port, "apply").mockImplementationOnce(async (...args) => {
				applying.reached = true;
				await applying.resumed;
				return await apply(...args);
			}),
			// Inside the transaction that records the result, before its audit event, which needs
			// the organization row.
			spyOn(f.store, "audit").mockImplementation(async (...args) => {
				if (args[3] === "mcp.change_result") {
					recording.reached = true;
					await recording.resumed;
				}
				await audit(...args);
			}),
		];
		try {
			const approve = () =>
				browser.request(`/api/platform/mcp/changes/${change.id}/approve`, {
					requestHash: change.requestHash,
				});
			const first = approve();
			await until(() => applying.reached, "the first approval to apply the change");
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let held = false;
			const holder = f.client.begin(async (tx) => {
				await tx`SELECT id FROM platform_mcp_authorizations WHERE id = ${grant.id} FOR UPDATE`;
				held = true;
				await released;
			});
			await until(() => held, "the grant row to be held");
			// The second approval takes the session, organization and membership rows and waits
			// for the grant.
			let answered = false;
			const second = approve().finally(() => {
				answered = true;
			});
			await waiters(1);
			// The first one now records its result: it either queues behind the second, or, taking
			// the change row first, goes on to need the organization row the second holds.
			applying.resume();
			await until(
				async () => recording.reached || (await lockWaiters()) >= 2,
				"the first approval to record its result or wait",
			);
			release();
			await holder;
			await until(() => recording.reached, "the first approval to record its result");
			await until(
				async () => answered || (await lockWaiters()) >= 1,
				"the second approval to finish or wait",
			);
			recording.resume();
			const responses = await Promise.all([first, second]);
			// Never a 503 from a deadlock (SQLSTATE 40P01).
			expect(responses.map((response) => response.status)).toEqual([200, 200]);
			const [row] = await f.sql<
				{ status: string }[]
			>`SELECT status FROM platform_mcp_changes WHERE id = ${change.id}`;
			expect(row?.status).toBe("completed");
			expect(
				await f.sql`SELECT response FROM billing_administration_receipts WHERE operation_key=${`mcp:${change.id}`}`,
			).toHaveLength(1);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("denies read-only grants, cancelled proposals, and expired proposals", async () => {
		const browser = await owner();
		await createBillingAccount();
		await redeem(browser);
		const [read] = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		await expect(f.mcpChanges.capabilities(read.id)).rejects.toThrow("write consent");
		await redeem(browser, merchantTestScope, true);
		const [grant] = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_mcp_authorizations WHERE scopes ? 'quotum.billing.write' AND approved_at IS NOT NULL`;
		const input = {
			requestKey: "entity-a",
			reason: "Team setup",
			action: "entities.write",
			parameters: ["customer-a"],
			body: { externalId: "team-a", kind: "team" },
		};
		const cancelled = await f.mcpChanges.prepare(grant.id, input);
		expect((await f.mcpChanges.cancel(grant.id, cancelled.id)).status).toBe("cancelled");
		expect(
			(
				await browser.json<{ status: string }>(
					`/api/platform/mcp/changes/${cancelled.id}/approve`,
					{ requestHash: cancelled.requestHash },
				)
			).status,
		).toBe("cancelled");
		const expired = await f.mcpChanges.prepare(grant.id, { ...input, requestKey: "expiry" });
		f.advance(900001);
		expect((await f.mcpChanges.get(grant.id, expired.id)).status).toBe("expired");
		const receipts = await f.sql`SELECT * FROM billing_administration_receipts`;
		expect(receipts).toHaveLength(0);
	});
	it("rejects stale state and immediately stops revoked or disabled write access", async () => {
		const browser = await owner();
		await createBillingAccount();
		await redeem(browser, merchantTestScope, true);
		const [grant] = await f.sql<
			{ id: string; project_instance_id: string; principal_id: string }[]
		>`SELECT * FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		const input = {
			requestKey: "stale",
			reason: "Add a team",
			action: "entities.write",
			parameters: ["customer-a"],
			body: { externalId: "team-a", kind: "team" },
		};
		const change = await f.mcpChanges.prepare(grant.id, input);
		await f.billingPort.dispatch({
			operation: "entities.write",
			parameters: ["customer-a"],
			body: { externalId: "team-b", kind: "team" },
			projectInstanceId: grant.project_instance_id,
			actor: `merchant:${grant.principal_id}`,
			query: {},
			idempotencyKey: "other",
		});
		expect(
			(
				await browser.json<{ status: string }>(`/api/platform/mcp/changes/${change.id}/approve`, {
					requestHash: change.requestHash,
				})
			).status,
		).toBe("stale");
		const config = f.store.config.mcp;
		if (!config) throw new Error("MCP configuration missing");
		config.writesEnabled = false;
		try {
			await expect(
				f.mcpChanges.prepare(grant.id, { ...input, requestKey: "disabled" }),
			).rejects.toThrow("disabled");
		} finally {
			config.writesEnabled = true;
		}
		await new McpAuthorizations(f.store).revoke(grant.id, grant.principal_id);
		await expect(f.mcpChanges.get(grant.id, change.id)).rejects.toThrow();
	});
	it("requires step-up in production and keeps approval bound to the connected person", async () => {
		const browser = await owner();
		await f.sql`UPDATE projects SET lifecycle_status='active' WHERE environment='production'`;
		await createBillingAccount("production");
		await redeem(browser, { ...merchantTestScope, environment: "production" }, true);
		const [grant] = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		const change = await f.mcpChanges.prepare(grant.id, {
			requestKey: "production",
			reason: "Team setup",
			action: "entities.write",
			parameters: ["customer-a"],
			body: { externalId: "team-a", kind: "team" },
		});
		expect(change.stepUp?.action).toBe("operations.write");
		const denied = await browser.request(`/api/platform/mcp/changes/${change.id}/approve`, {
			requestHash: change.requestHash,
		});
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe("STEP_UP_REQUIRED");
		expect((await f.mcpChanges.get(grant.id, change.id)).status).toBe("pending");
		const other = new MerchantBrowser(f);
		await other.signup("other@example.com");
		expect((await other.request(`/api/platform/mcp/changes/${change.id}`)).status).toBe(404);
		expect(await f.sql`SELECT * FROM billing_administration_receipts`).toHaveLength(0);
	});
	it("reads fixed target snapshots without crossing project or customer scope", async () => {
		const browser = await owner();
		await redeem(browser, merchantTestScope, true);
		const [grant] = await f.sql<
			{ project_instance_id: string }[]
		>`SELECT project_instance_id FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		const uuid = "11111111-1111-4111-8111-111111111111";
		for (const [action, parameters, body] of [
			["debits.create", ["missing"], { allocations: [{ allocationId: "1", quantity: "1" }] }],
			["topups.reset", ["missing", "1"], {}],
			["licenses.release", ["missing", "1"], {}],
			["promotions.redemptions.revoke", [uuid], {}],
			["promotions.codes.deactivate", ["missing", uuid], {}],
			["usage.correct", ["missing", uuid], {}],
			["projections.retry", [uuid], {}],
		] as const)
			expect(
				await f.repository.administrationTarget(
					grant.project_instance_id,
					action,
					[...parameters],
					body,
				),
			).toEqual([]);
	});
});

const WRITE_SCOPE = "quotum.billing.write";
const claimsOf = (accessToken: string) =>
	JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
async function toolNames(accessToken: string) {
	const reply = await (await rpc(accessToken)).json();
	return (reply.result.tools as { name: string }[]).map((tool) => tool.name);
}

describe("MCP consent scopes", () => {
	it("lets a consent decline change proposals and keeps that through a refresh", async () => {
		const browser = await owner();
		const tokens = await redeem(browser, merchantTestScope, true, "quotum.read offline_access");
		expect(tokens.scope?.split(" ")).toEqual(["quotum.read", "offline_access"]);
		expect(claimsOf(tokens.access_token).scope.split(" ")).not.toContain(WRITE_SCOPE);
		const [grant] = await f.sql<
			{ id: string; scopes: string[] }[]
		>`SELECT id,scopes FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		expect(grant.scopes).toEqual(["quotum.read", "offline_access"]);
		expect(await toolNames(tokens.access_token)).not.toContain("prepare_billing_change");
		await expect(f.mcpChanges.capabilities(grant.id)).rejects.toThrow("write consent");
		const listed = await browser.json<{ connections: { scopes: string[] }[] }>(
			"/api/platform/mcp/connections/list",
			{ scope: merchantTestScope },
		);
		expect(listed.connections.map((connection) => connection.scopes)).toEqual([
			["quotum.read", "offline_access"],
		]);
		const refreshed = await (
			await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })
		).json();
		expect(claimsOf(refreshed.access_token).scope.split(" ")).not.toContain(WRITE_SCOPE);
		expect(await toolNames(refreshed.access_token)).not.toContain("prepare_billing_change");
	});

	it("keeps change proposals when the consent submits everything that was requested", async () => {
		const browser = await owner();
		const tokens = await redeem(
			browser,
			merchantTestScope,
			true,
			`quotum.read offline_access ${WRITE_SCOPE}`,
		);
		expect(claimsOf(tokens.access_token).scope.split(" ")).toContain(WRITE_SCOPE);
		expect(await toolNames(tokens.access_token)).toContain("prepare_billing_change");
		const [grant] = await f.sql<
			{ scopes: string[] }[]
		>`SELECT scopes FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		expect(grant.scopes).toEqual(["quotum.read", "offline_access", WRITE_SCOPE]);
	});

	it("refuses a consent that drops read or refresh access, or adds a scope", async () => {
		const browser = await owner();
		for (const consentScope of [
			`quotum.read ${WRITE_SCOPE}`,
			`offline_access ${WRITE_SCOPE}`,
			`quotum.read offline_access ${WRITE_SCOPE} openid`,
		])
			await expect(
				authorize(browser, merchantTestScope, undefined, true, consentScope),
			).rejects.toThrow("Only change proposals can be left out");
		expect(
			await f.sql`SELECT id FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL OR code_hash IS NOT NULL`,
		).toHaveLength(0);
	});

	it("connects a viewer read-only and refuses it change proposals", async () => {
		const browser = await owner();
		const pending = await signIn(browser, true);
		const context = () =>
			browser.json<{ environments: { canPropose: boolean }[] }>("/api/platform/oauth/context", {
				oauth_query: pending.query,
			});
		const asOwner = await context();
		expect(asOwner.environments.length).toBeGreaterThan(0);
		expect(asOwner.environments.every((environment) => environment.canPropose)).toBe(true);
		await f.sql`UPDATE platform_memberships SET role='Viewer'`;
		const asViewer = await context();
		expect(asViewer.environments.length).toBeGreaterThan(0);
		expect(asViewer.environments.some((environment) => environment.canPropose)).toBe(false);
		await expect(authorize(browser, merchantTestScope, undefined, true)).rejects.toThrow(
			"Your role cannot connect with change proposals",
		);
		expect(
			await f.sql`SELECT id FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL OR code_hash IS NOT NULL`,
		).toHaveLength(0);
		const tokens = await redeem(browser, merchantTestScope, true, "quotum.read offline_access");
		expect(await toolNames(tokens.access_token)).not.toContain("prepare_billing_change");
	});

	it("stops a write grant from proposing once its owner loses the role", async () => {
		const browser = await owner();
		await createBillingAccount();
		await redeem(browser, merchantTestScope, true);
		const [grant] = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_mcp_authorizations WHERE approved_at IS NOT NULL`;
		await f.sql`UPDATE platform_memberships SET role='Viewer'`;
		await expect(
			f.mcpChanges.prepare(grant.id, {
				requestKey: "entity-a",
				reason: "Team setup",
				action: "entities.write",
				parameters: ["customer-a"],
				body: { externalId: "team-a", kind: "team" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
		const actions = await f.mcpChanges.capabilities(grant.id);
		expect(actions.length).toBeGreaterThan(0);
		expect(actions.some((action) => action.available)).toBe(false);
		expect(await f.sql`SELECT id FROM platform_mcp_changes`).toHaveLength(0);
	});
});
