import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type DocumentDecoration, Elysia } from "elysia";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createContractStore } from "../mcp/contracts";
import { createGuardedFetch } from "../mcp/guarded-fetch";
import { createQuotumMcpServer } from "../mcp/server";
import type { MerchantBillingPort } from "../platform/application/billing-port";
import type { MerchantAuth } from "../platform/auth";
import {
	MCP_GRANT_CLAIM,
	MCP_INSTANCE_CLAIM,
	MCP_SCOPES,
	McpAuthorizations,
} from "../platform/mcp/authorization";
import { MerchantError } from "../platform/security";
import type { MerchantStore } from "../platform/store";
import { BillingClient } from "../sdk/client";
import { readCappedText } from "../shared/body-limit";
import { type ElysiaPluginLike, HTTP_APP_CONFIG } from "../shared/http";
import { createMcpPortFetch } from "./mcp-port-fetch";
import { remoteMcpOpenApi } from "./remote-mcp-openapi";

export interface McpUnexpectedErrorReport {
	request: Request;
	requestId: string;
	route: string;
	status: number;
	code: string;
}

export function createRemoteMcpApp(options: {
	auth: MerchantAuth;
	store: MerchantStore;
	port: MerchantBillingPort;
	requestObservabilityMiddleware?: ElysiaPluginLike;
	onUnexpectedError?: (error: unknown, report: McpUnexpectedErrorReport) => void;
}) {
	const { auth, store, port } = options;
	const origin = store.config.mcp?.origin;
	if (!origin) throw new Error("Remote MCP is not enabled");
	const resource = `${origin}/mcp`;
	const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
	const authBase = `${store.config.origin}/api/auth`;
	const verifiedClaims = async (token: string) => {
		const keys = await auth.handler(new Request(`${authBase}/jwks`));
		if (!keys.ok) throw new Error("MCP signing keys unavailable");
		const keySet = createLocalJWKSet(await keys.json());
		try {
			return (await jwtVerify(token, keySet, { issuer: origin, audience: resource })).payload;
		} catch {
			return null;
		}
	};
	const grants = new McpAuthorizations(store);
	const directory = resolve(import.meta.dir, "../../contracts/v1");
	const contracts = existsSync(resolve(directory, "openapi.json"))
		? createContractStore(directory)
		: undefined;
	const app = new Elysia(HTTP_APP_CONFIG);
	if (options.requestObservabilityMiddleware) app.use(options.requestObservabilityMiddleware);
	const requestIds = new WeakMap<Request, string>();
	const report = (
		error: unknown,
		request: Request,
		route: string,
		status: number,
		code: string,
	) => {
		try {
			options.onUnexpectedError?.(error, {
				request,
				route,
				status,
				code,
				requestId: requestIds.get(request) ?? crypto.randomUUID(),
			});
		} catch {
			// Reporting must not change the response or expose diagnostics to clients.
		}
	};
	// Elysia types metadata as OpenAPI 3.0; our exporter owns the same JSON as OpenAPI 3.1.
	const docs = remoteMcpOpenApi() as unknown as Record<
		string,
		{ get?: DocumentDecoration; post?: DocumentDecoration }
	>;
	app.onError(({ error, request, route, set }) => {
		const known = error instanceof MerchantError;
		set.status = known ? error.status : 503;
		if (!known) report(error, request, route, 503, "temporarily_unavailable");
		return {
			error: known ? error.code : "temporarily_unavailable",
			error_description: known ? error.message : "Quotum is temporarily unavailable.",
		};
	});
	const challenge = (status = 401, error = "invalid_token") =>
		Response.json(
			{ error },
			{
				status,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="quotum.read", error="${error}"`,
					"cache-control": "no-store",
				},
			},
		);
	app.onRequest(async ({ request, server, set }) => {
		const requestId = crypto.randomUUID();
		requestIds.set(request, requestId);
		set.headers["x-request-id"] = requestId;
		set.headers["cache-control"] = "no-store";
		set.headers["referrer-policy"] = "no-referrer";
		set.headers["x-content-type-options"] = "nosniff";
		const host = request.headers.get("host") ?? new URL(request.url).host;
		if (host !== new URL(origin).host) return new Response("Invalid Host", { status: 403 });
		const requestOrigin = request.headers.get("origin");
		if (requestOrigin && requestOrigin !== origin && requestOrigin !== store.config.origin)
			return new Response("Invalid Origin", { status: 403 });
		await store.rateLimit(
			`mcp:ip:${server?.requestIP(request)?.address ?? "unknown"}`,
			300,
			60_000,
		);
	});
	app.all(
		"/mcp",
		async ({ request }) => {
			if (request.headers.has("dpop")) return challenge();
			const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
			if (!bearer) return challenge();
			const claims = await verifiedClaims(bearer);
			if (
				!claims ||
				claims.cnf ||
				typeof claims.sub !== "string" ||
				typeof claims[MCP_GRANT_CLAIM] !== "string"
			)
				return challenge();
			if (
				!String(claims.scope ?? "")
					.split(" ")
					.includes("quotum.read")
			)
				return challenge(403, "insufficient_scope");
			let grant: Awaited<ReturnType<McpAuthorizations["byId"]>>;
			try {
				grant = await grants.byId(String(claims[MCP_GRANT_CLAIM]));
			} catch (error) {
				if (error instanceof MerchantError) return challenge(error.status === 401 ? 401 : 403);
				throw error;
			}
			if (
				grant.userId !== claims.sub ||
				grant.project_instance_id !== claims[MCP_INSTANCE_CLAIM] ||
				grant.client_id !== (claims.client_id ?? claims.azp)
			)
				return challenge();
			await store.rateLimit(`mcp:principal:${grant.principal_id}`, 120, 60_000);
			const body =
				request.method === "GET" || request.method === "HEAD"
					? undefined
					: await readCappedText(
							request,
							256 * 1024,
							() => new MerchantError("REQUEST_TOO_LARGE", "The request is too large.", 413),
						);
			const client = new BillingClient({
				baseUrl: "http://billing.internal",
				fetch: createGuardedFetch({
					baseUrl: "http://billing.internal",
					fetch: createMcpPortFetch({
						port,
						projectInstanceId: grant.project_instance_id,
						principalId: grant.principal_id,
					}),
				}),
			});
			const handler = createMcpHandler(() =>
				createQuotumMcpServer({
					client,
					contracts,
					version: process.env.BUILD_VERSION ?? "0.0.0-dev",
					log: (_line, error) => report(error, request, "/mcp", 200, "tool_failure"),
				}),
			);
			return handler.fetch(
				new Request(resource, { method: request.method, headers: request.headers, body }),
			);
		},
		{ parse: "none", detail: docs["/mcp"]?.post },
	);

	app.get("/oauth/jwks", () => auth.handler(new Request(`${authBase}/jwks`)), {
		detail: docs["/oauth/jwks"]?.get,
	});
	for (const endpoint of ["token", "revoke"] as const)
		app.post(
			`/oauth/${endpoint}`,
			async ({ request, server }) => {
				if (
					!(request.headers.get("content-type") ?? "").startsWith(
						"application/x-www-form-urlencoded",
					)
				)
					return Response.json({ error: "invalid_request" }, { status: 415 });
				const body = await readCappedText(
					request,
					16 * 1024,
					() => new MerchantError("REQUEST_TOO_LARGE", "The request is too large.", 413),
				);
				if (endpoint === "revoke") {
					const form = new URLSearchParams(body);
					const token = form.get("token"),
						clientId = form.get("client_id");
					if (
						!token ||
						!clientId ||
						form.getAll("token").length !== 1 ||
						form.getAll("client_id").length !== 1 ||
						request.headers.has("authorization") ||
						request.headers.has("dpop") ||
						form.has("client_assertion") ||
						form.has("client_secret")
					)
						return Response.json({ error: "invalid_request" }, { status: 400 });
					// Provider family revocation is user/client-wide. Keep revocation tied to one grant.
					await grants.revokeToken(token, clientId);
					if (token.split(".").length === 3) {
						const claims = await verifiedClaims(token);
						if (
							claims &&
							!claims.cnf &&
							claims.client_id === clientId &&
							typeof claims[MCP_GRANT_CLAIM] === "string"
						) {
							try {
								const grant = await grants.byId(String(claims[MCP_GRANT_CLAIM]));
								if (
									grant.client_id === clientId &&
									grant.userId === claims.sub &&
									grant.project_instance_id === claims[MCP_INSTANCE_CLAIM]
								)
									await grants.revoke(grant.id, grant.principal_id);
							} catch (error) {
								if (!(error instanceof MerchantError)) throw error;
							}
						}
					}
					return new Response(null, { status: 200 });
				}
				const headers = new Headers({
					"content-type": "application/x-www-form-urlencoded",
					"x-quotum-client-ip": server?.requestIP(request)?.address ?? "unknown",
				});
				for (const name of ["authorization", "dpop"]) {
					const value = request.headers.get(name);
					if (value) headers.set(name, value);
				}
				const response = await auth.handler(
					new Request(`${authBase}/oauth2/${endpoint}`, { method: "POST", headers, body }),
				);
				const safe = new Headers(response.headers);
				safe.delete("set-cookie");
				safe.set("cache-control", "no-store");
				return new Response(response.body, { status: response.status, headers: safe });
			},
			{ parse: "none", detail: docs[`/oauth/${endpoint}`]?.post },
		);
	app.get(
		"/.well-known/oauth-authorization-server",
		() =>
			Response.json({
				issuer: origin,
				authorization_endpoint: `${store.config.origin}/oauth/authorize`,
				token_endpoint: `${origin}/oauth/token`,
				revocation_endpoint: `${origin}/oauth/revoke`,
				jwks_uri: `${origin}/oauth/jwks`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
				revocation_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
				scopes_supported: MCP_SCOPES,
				client_id_metadata_document_supported: true,
			}),
		{ detail: docs["/.well-known/oauth-authorization-server"]?.get },
	);
	for (const path of [
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-protected-resource/mcp",
	])
		app.get(
			path,
			() =>
				Response.json({
					resource,
					authorization_servers: [origin],
					scopes_supported: ["quotum.read"],
					bearer_methods_supported: ["header"],
				}),
			{ detail: docs[path]?.get },
		);
	return app;
}
