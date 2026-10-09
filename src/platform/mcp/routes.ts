import type { Elysia } from "elysia";
import { z } from "zod";
import { operationDetail } from "../../shared/http";
import type { MerchantAuth } from "../auth";
import { MerchantScopeSchema } from "../schemas";
import { MERCHANT_JSON_PARSE, MerchantError } from "../security";
import type { MerchantStore } from "../store";
import { McpAuthorizations } from "./authorization";
import type { McpChanges } from "./changes";

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

export function registerMcpRoutes(
	app: Elysia,
	store: MerchantStore,
	auth: MerchantAuth,
	changes?: McpChanges,
) {
	{
		const enabled = () => {
			if (!changes) throw new MerchantError("NOT_FOUND", "MCP changes are unavailable.", 404);
			return changes;
		};
		const params = z.object({ id: z.uuid() });
		const view = z.object({
			id: z.uuid(),
			action: z.string(),
			parameters: z.array(z.string()),
			reason: z.string(),
			requestHash: z.string(),
			scope: MerchantScopeSchema,
			status: z.string(),
			before: z.unknown(),
			after: z.unknown(),
			// What the app asked for, as the action's request body: `after` is the preview for an action
			// that has one, which says what it would do and not what it was asked to do.
			body: z.unknown().optional(),
			result: z.unknown(),
			expiresAt: z.string(),
			createdAt: z.string(),
			approvalUrl: z.string(),
			stepUp: z.object({ action: z.string(), target: z.string() }).nullable(),
		});
		app.get(
			"/api/platform/mcp/changes/:id",
			async ({ request, params }) => ({
				success: true,
				data: await enabled().browserGet(await store.authenticate(request), params.id),
			}),
			{
				params,
				detail: operationDetail({
					operationId: "getMcpBillingChange",
					tags: ["platform"],
					path: "/api/platform/mcp/changes/:id",
					responses: { 200: success(view) },
				}),
			},
		);
		for (const decision of ["approve", "reject"] as const) {
			const path = `/api/platform/mcp/changes/:id/${decision}`;
			const body = z.object({ requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
			app.post(
				path,
				async ({ request, params, body: raw }) => {
					const identity = await store.authenticate(request);
					const input = body.parse(raw);
					const current = await enabled().browserGet(identity, params.id);
					if (current.requestHash !== input.requestHash)
						throw new MerchantError("ACTION_MISMATCH", "The proposal changed.", 409);
					return {
						success: true,
						data: await enabled().decide(
							identity,
							params.id,
							decision === "approve",
							request.headers.get("x-quotum-step-up-grant"),
						),
					};
				},
				{
					...route(
						decision === "approve" ? "approveMcpBillingChange" : "rejectMcpBillingChange",
						path,
						body,
						view,
					),
					params,
				},
			);
		}
	}

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
				scopes: z.array(z.string()),
				environments: z.array(
					z.object({
						scope: MerchantScopeSchema,
						organizationName: z.string(),
						projectName: z.string(),
						/** `inactive` is a production not yet activated: only its catalog is reachable. */
						status: z.enum(["active", "inactive"]),
						canPropose: z.boolean(),
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
						scopes: z.array(z.string()),
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
