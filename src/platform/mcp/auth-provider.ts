import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { OAuthOptions, Scope } from "@better-auth/oauth-provider";
import type { GenericEndpointContext } from "better-auth";
import { APIError, getOAuthState, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { MerchantError } from "../security";
import type { MerchantStore } from "../store";
import {
	authorizationFingerprint,
	MCP_GRANT_CLAIM,
	MCP_INSTANCE_CLAIM,
	MCP_SCOPES,
	McpAuthorizations,
} from "./authorization";
import { containMcpCodeReplay } from "./code-replay";
import { isMcpRedirectUri, withMcpRedirectPolicy } from "./redirect-policy";
import { containMcpRefreshInvalidation } from "./refresh-invalidation";

const invalid = (message = "Reconnect Quotum to authorize access.") =>
	new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: message });

export function createMcpAuthProvider(store: MerchantStore) {
	const binding = new McpAuthorizations(store);
	const config = store.config.mcp;
	const resource = config ? `${config.origin}/mcp` : "";
	const options: OAuthOptions<Scope[]> = {
		loginPage: "/sign-in",
		consentPage: "/oauth/consent",
		scopes: MCP_SCOPES,
		grantTypes: ["authorization_code", "refresh_token"],
		accessTokenExpiresIn: 900,
		refreshTokenExpiresIn: 30 * 24 * 60 * 60,
		codeExpiresIn: 300,
		allowDynamicClientRegistration: false,
		allowUnauthenticatedClientRegistration: false,
		enforcePerClientResources: false,
		storeTokens: { hash: (token) => binding.tokenHash(token) },
		dpop: { signingAlgorithms: [] },
		postLogin: {
			page: "/oauth/select",
			shouldRedirect: async ({ session }) => (await binding.selection(session.id)) === null,
			consentReferenceId: async ({ session }) => {
				const selected = await binding.selection(session.id);
				if (!selected) throw invalid("Choose an environment before approving access.");
				return selected.project_instance_id;
			},
		},
		extensions: [
			{
				claims: {
					accessToken: async ({ ctx, client, user, referenceId, grantType }) => {
						try {
							const grant =
								grantType === "authorization_code" && typeof ctx.body?.code === "string"
									? await binding.forCode(ctx.body.code)
									: grantType === "refresh_token" && typeof ctx.body?.refresh_token === "string"
										? await binding.forRefresh(ctx.body.refresh_token)
										: null;
							if (
								!grant ||
								grant.client_id !== client.clientId ||
								grant.userId !== user?.id ||
								grant.project_instance_id !== referenceId
							)
								throw invalid();
							return {
								[MCP_INSTANCE_CLAIM]: grant.project_instance_id,
								[MCP_GRANT_CLAIM]: grant.id,
							};
						} catch (error) {
							if (error instanceof MerchantError) throw invalid(error.message);
							throw error;
						}
					},
				},
			},
		],
	};

	return {
		plugins: config
			? [
					jwt({ jwt: { issuer: config.origin } }),
					mcp({ ...options, resource }),
					cimd({
						fetchClientMetadataResource: withMcpRedirectPolicy(fetchClientMetadataResource),
						metadataProfile: "mcp-2026-07-28",
					}),
				]
			: [],
		async before(ctx: GenericEndpointContext) {
			if (!config || !ctx.path?.startsWith("/oauth2/")) return;
			try {
				if (ctx.headers?.has("dpop") || ctx.body?.dpop_jkt || ctx.query?.dpop_jkt)
					throw new APIError("BAD_REQUEST", {
						error: "invalid_request",
						error_description: "Only bearer authorization is supported.",
					});
				if (ctx.path === "/oauth2/authorize") {
					if (!isMcpRedirectUri(ctx.query?.redirect_uri))
						throw new APIError("BAD_REQUEST", {
							error: "invalid_request",
							error_description: "MCP redirect URIs must use HTTPS or HTTP loopback.",
						});
					if (ctx.query?.resource !== resource || ctx.query?.code_challenge_method !== "S256")
						throw new APIError("BAD_REQUEST", {
							error: "invalid_request",
							error_description: "Use the MCP resource and PKCE S256.",
						});
					// The provider re-enters this endpoint after login/consent with server-only
					// authorizeSettings. Requiring login again there restarts the completed step.
					if (!("authorizeSettings" in ctx)) ctx.query.prompt = "login consent";
				}
				if (["/oauth2/continue", "/oauth2/consent"].includes(ctx.path)) {
					const session = await getSessionFromCtx(ctx);
					if (!session || typeof ctx.body?.oauth_query !== "string") throw invalid();
					await store.sql.begin((tx) =>
						binding.proof(session.session.id, ctx.body.oauth_query, tx),
					);
				}
				if (ctx.path === "/oauth2/token") {
					if (
						ctx.headers?.has("authorization") ||
						ctx.body?.client_secret !== undefined ||
						ctx.body?.client_assertion !== undefined ||
						ctx.body?.client_assertion_type !== undefined
					)
						throw new APIError("UNAUTHORIZED", {
							error: "invalid_client",
							error_description: "Use a public client with PKCE and no client credentials.",
						});
					if (ctx.body?.grant_type === "authorization_code" && typeof ctx.body.code === "string") {
						if (typeof ctx.body.client_id !== "string") throw invalid();
						const hash = binding.tokenHash(ctx.body.code);
						const verification = await ctx.context.internalAdapter.findVerificationValue(hash);
						if (!verification || verification.expiresAt <= store.now()) {
							// Code replay must also invalidate already-issued JWTs, not just provider rows.
							await binding.revokeCode(ctx.body.code, ctx.body.client_id);
							throw invalid();
						}
						const value = JSON.parse(verification.value) as {
							sessionId?: string;
							query?: Record<string, string>;
						};
						if (!value.sessionId || !value.query) throw invalid();
						const grant = await binding.forCode(ctx.body.code);
						if (
							grant.client_id !== ctx.body.client_id ||
							grant.proof_session_id !== value.sessionId
						)
							throw invalid();
						containMcpCodeReplay(
							ctx,
							hash,
							() => binding.revoke(grant.id, grant.principal_id),
							store.now,
						);
					} else if (
						ctx.body?.grant_type === "refresh_token" &&
						typeof ctx.body.refresh_token === "string"
					) {
						// This runs before Better Auth's refresh-response replay grace path.
						if (typeof ctx.body.client_id !== "string") throw invalid();
						const grant = await binding.checkRefresh(ctx.body.refresh_token, ctx.body.client_id);
						containMcpRefreshInvalidation(ctx, grant, () =>
							binding.revoke(grant.id, grant.principal_id),
						);
					} else throw new APIError("BAD_REQUEST", { error: "unsupported_grant_type" });
				}
			} catch (error) {
				if (error instanceof MerchantError) throw invalid(error.message);
				throw error;
			}
		},
		async after(
			ctx: GenericEndpointContext & { context: { returned?: unknown; responseHeaders?: Headers } },
		) {
			if (!config) return;
			if (ctx.context.newSession) {
				const googleCallback =
					ctx.path === "/callback/google" ||
					(ctx.path === "/callback/:id" && ctx.params?.id === "google");
				// Social callbacks carry no request body. Only the provider's verified,
				// server-owned state can bind this fresh proof to its MCP authorization.
				const query = googleCallback
					? (await getOAuthState())?.serverContext?.query
					: ctx.body?.oauth_query;
				if (typeof query === "string")
					await store.sql`UPDATE platform_auth_sessions SET mcp_request_hash=${authorizationFingerprint(query)} WHERE id=${ctx.context.newSession.session.id}`;
			}
			if (["/oauth2/authorize", "/oauth2/continue", "/oauth2/consent"].includes(ctx.path ?? "")) {
				const returned = ctx.context.returned;
				const payload =
					returned instanceof Response
						? await returned
								.clone()
								.json()
								.catch(() => null)
						: returned;
				const location =
					(payload && typeof payload === "object"
						? "redirect_uri" in payload
							? payload.redirect_uri
							: "url" in payload
								? payload.url
								: null
						: null) ?? ctx.context.responseHeaders?.get("location");
				if (typeof location === "string") {
					const code = new URL(location, store.config.origin).searchParams.get("code");
					if (code) {
						const verification = await ctx.context.internalAdapter.findVerificationValue(
							binding.tokenHash(code),
						);
						if (!verification) throw invalid();
						const value = JSON.parse(verification.value) as {
							sessionId?: string;
							query?: Record<string, string>;
						};
						if (!value.sessionId || !value.query) throw invalid();
						try {
							await binding.issueCode(
								code,
								value.sessionId,
								new URLSearchParams(value.query).toString(),
								verification.expiresAt,
							);
						} catch (error) {
							if (error instanceof MerchantError) throw invalid(error.message);
							throw error;
						}
					}
				}
			}
			if (ctx.path === "/oauth2/token" && ctx.body?.grant_type === "authorization_code") {
				const returned = ctx.context.returned;
				const payload =
					returned instanceof Response
						? await returned
								.clone()
								.json()
								.catch(() => null)
						: returned;
				if (typeof ctx.body.code !== "string") return;
				const issued = !!payload && typeof payload === "object" && "access_token" in payload;
				try {
					// Only a successful issuance becomes a listed/audited connection.
					await binding.completeCode(ctx.body.code, issued);
				} catch (error) {
					if (error instanceof MerchantError) throw invalid(error.message);
					throw error;
				}
			}
		},
	};
}
