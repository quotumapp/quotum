import type { Elysia } from "elysia";
import { z } from "zod";
import { operationDetail } from "../../shared/http";
import type { MerchantAuth } from "../auth";
import { MerchantScopeSchema } from "../schemas";
import { MERCHANT_JSON_PARSE, MerchantError } from "../security";
import type { MerchantStore } from "../store";
import { McpAuthorizations } from "./authorization";

const queryBody = z.strictObject({ oauth_query: z.string().min(1).max(8192) });
const selectionBody = queryBody.extend({ scope: MerchantScopeSchema });
const scopeBody = z.strictObject({ scope: MerchantScopeSchema });
const revokeBody = scopeBody.extend({ id: z.uuid() });
const success = (data: z.ZodType) => z.object({ success: z.literal(true), data });
const route = (operationId: string, path: string, body: z.ZodType, response: z.ZodType) => ({
	parse: [MERCHANT_JSON_PARSE],
	body,
	detail: operationDetail({
		operationId,
		tags: ["platform"],
		path,
		responses: { 200: success(response) },
	}),
});

export function registerMcpRoutes(app: Elysia, store: MerchantStore, auth: MerchantAuth) {
	const grants = new McpAuthorizations(store);
	const proof = async (request: Request) => {
		if (!store.config.mcp) throw new MerchantError("NOT_FOUND", "Remote MCP is not enabled.", 404);
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session)
			throw new MerchantError(
				"AUTHENTICATION_INCOMPLETE",
				"Sign in again to authorize access.",
				401,
			);
		return session.session.id;
	};
	app.post(
		"/api/platform/oauth/context",
		async ({ request, body }) => {
			const input = queryBody.parse(body);
			return { success: true, data: await grants.context(await proof(request), input.oauth_query) };
		},
		route(
			"getMcpAuthorizationContext",
			"/api/platform/oauth/context",
			queryBody,
			z.object({
				principal: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
				client: z.object({ id: z.string(), name: z.string() }),
				environments: z.array(
					z.object({
						scope: MerchantScopeSchema,
						organizationName: z.string(),
						projectName: z.string(),
					}),
				),
				selection: MerchantScopeSchema.nullable(),
			}),
		),
	);
	app.post(
		"/api/platform/oauth/selection",
		async ({ request, body }) => {
			const input = selectionBody.parse(body);
			return {
				success: true,
				data: await grants.select(await proof(request), input.oauth_query, input.scope),
			};
		},
		route(
			"selectMcpEnvironment",
			"/api/platform/oauth/selection",
			selectionBody,
			z.object({ projectInstanceId: z.uuid() }),
		),
	);
	app.post(
		"/api/platform/mcp/connections/list",
		async ({ request, body }) => {
			const identity = await store.authenticate(request);
			return {
				success: true,
				data: await grants.list(identity.principalId, scopeBody.parse(body).scope),
			};
		},
		route(
			"listMcpConnections",
			"/api/platform/mcp/connections/list",
			scopeBody,
			z.object({
				mcpUrl: z.string().nullable(),
				connections: z.array(
					z.object({
						id: z.uuid(),
						clientId: z.string(),
						clientName: z.string(),
						createdAt: z.string(),
						expiresAt: z.string(),
					}),
				),
			}),
		),
	);
	app.post(
		"/api/platform/mcp/connections/revoke",
		async ({ request, body }) => {
			const identity = await store.authenticate(request);
			const input = revokeBody.parse(body);
			const access = await grants.authorizeScope(identity.principalId, input.scope);
			// A replay only ever affects this immutable grant, including after reconnecting.
			return {
				success: true,
				data: await grants.revoke(input.id, identity.principalId, access.projectInstanceId),
			};
		},
		route(
			"revokeMcpConnection",
			"/api/platform/mcp/connections/revoke",
			revokeBody,
			z.object({ revoked: z.boolean() }),
		),
	);
}
