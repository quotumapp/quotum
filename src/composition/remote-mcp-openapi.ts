import type { PathsObject, SchemaObject } from "openapi3-ts/oas31";

const string: SchemaObject = { type: "string" };
const strings: SchemaObject = { type: "array", items: string };
const object: SchemaObject = { type: "object", additionalProperties: true };
const json = (schema: SchemaObject) => ({ "application/json": { schema } });
const error = {
	description: "OAuth or MCP authorization error",
	content: json({
		type: "object",
		required: ["error"],
		properties: { error: { anyOf: [string, object] }, error_description: string },
	}),
};
const discovery = (operationId: string, schema: SchemaObject) => ({
	get: {
		operationId,
		tags: ["mcp"],
		security: [],
		description: "Available when QUOTUM_MCP_ENABLED=true. Served directly on the API origin.",
		responses: {
			200: { description: "Discovery metadata", content: json(schema) },
			default: error,
		},
	},
});
const resource: SchemaObject = {
	type: "object",
	required: ["resource", "authorization_servers", "scopes_supported", "bearer_methods_supported"],
	properties: {
		resource: string,
		authorization_servers: strings,
		scopes_supported: strings,
		bearer_methods_supported: strings,
	},
};

/** Protocol ingresses use library validation and are mounted only by the enabled runtime. */
export function remoteMcpOpenApi(): PathsObject {
	return {
		"/.well-known/oauth-authorization-server": discovery("getMcpAuthorizationServer", {
			type: "object",
			required: [
				"issuer",
				"authorization_endpoint",
				"token_endpoint",
				"revocation_endpoint",
				"jwks_uri",
			],
			properties: {
				issuer: string,
				authorization_endpoint: string,
				token_endpoint: string,
				revocation_endpoint: string,
				jwks_uri: string,
				response_types_supported: strings,
				grant_types_supported: strings,
				token_endpoint_auth_methods_supported: strings,
				revocation_endpoint_auth_methods_supported: strings,
				code_challenge_methods_supported: strings,
				scopes_supported: strings,
				client_id_metadata_document_supported: { const: true },
			},
		}),
		"/.well-known/oauth-protected-resource": discovery("getMcpProtectedResource", resource),
		"/.well-known/oauth-protected-resource/mcp": discovery(
			"getMcpProtectedResourceForPath",
			resource,
		),
		"/oauth/jwks": discovery("getMcpSigningKeys", {
			type: "object",
			required: ["keys"],
			properties: { keys: { type: "array", items: object } },
		}),
		"/oauth/token": {
			post: {
				operationId: "exchangeMcpToken",
				tags: ["mcp"],
				security: [],
				description:
					"Public-client authorization code with PKCE S256, or refresh-token rotation. Cookie-free; 16 KiB form limit.",
				requestBody: {
					required: true,
					content: {
						"application/x-www-form-urlencoded": {
							schema: {
								type: "object",
								required: ["grant_type", "client_id"],
								properties: {
									grant_type: { enum: ["authorization_code", "refresh_token"] },
									client_id: string,
									code: string,
									code_verifier: string,
									redirect_uri: string,
									refresh_token: string,
									resource: string,
									scope: string,
								},
							},
						},
					},
				},
				responses: {
					200: {
						description: "Short-lived bearer token and rotating refresh token",
						content: json({
							type: "object",
							required: ["access_token", "token_type", "expires_in"],
							properties: {
								access_token: string,
								token_type: { const: "Bearer" },
								expires_in: { type: "number" },
								refresh_token: string,
								scope: string,
							},
						}),
					},
					default: error,
				},
			},
		},
		"/oauth/revoke": {
			post: {
				operationId: "revokeMcpToken",
				tags: ["mcp"],
				security: [],
				description:
					"Revoke one immutable authorization using its refresh or unexpired access token. Unknown tokens return 200. Cookie-free; 16 KiB form limit.",
				requestBody: {
					required: true,
					content: {
						"application/x-www-form-urlencoded": {
							schema: {
								type: "object",
								required: ["token", "client_id"],
								properties: { token: string, client_id: string, token_type_hint: string },
							},
						},
					},
				},
				responses: { 200: { description: "Revoked or unknown token" }, default: error },
			},
		},
		"/mcp": {
			post: {
				operationId: "callRemoteMcp",
				tags: ["mcp"],
				security: [{ mcpBearer: [] }],
				description:
					"Stateless Streamable HTTP MCP. Existing read-only tools run for the authorization's fixed project environment. 256 KiB body limit. No persistent session or server event stream.",
				requestBody: { required: true, content: json(object) },
				parameters: [
					{ in: "header", name: "MCP-Protocol-Version", schema: string },
					{
						in: "header",
						name: "Accept",
						required: true,
						schema: { const: "application/json, text/event-stream" },
					},
				],
				responses: {
					200: {
						description: "MCP JSON-RPC result",
						content: { ...json(object), "text/event-stream": { schema: string } },
					},
					202: { description: "MCP notification accepted" },
					401: { ...error, headers: { "WWW-Authenticate": { schema: string } } },
					403: error,
					default: error,
				},
			},
		},
	};
}
