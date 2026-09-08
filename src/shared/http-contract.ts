import { createRoute, z } from "@hono/zod-openapi";
import type { Env, Handler, Hono } from "hono";

export const errorSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: z.string(),
			message: z.string(),
			retryAfter: z.number().optional(),
			requestId: z.string().optional(),
		}),
	})
	.openapi("QuotumError");

export interface ContractInput {
	operationId: string;
	tags: string[];
	body?: z.ZodType;
	params?: z.ZodObject;
	query?: z.ZodObject;
	headers?: z.ZodObject;
	responses: Record<string, z.ZodType>;
	contentType?: string;
	requestContentType?: string;
	security?: Record<string, string[]>[];
	description?: string;
}

/** Schema metadata shares the handler's exact input validators without reading its body twice. */
export function defineContract<const P extends string>(
	method: "get" | "post" | "put" | "delete" | "patch",
	path: P,
	input: ContractInput,
) {
	const contentType = input.contentType ?? "application/json";
	const responses: Record<
		string,
		{ description: string; content: Record<string, { schema: z.ZodType }> }
	> = {};
	if (path.startsWith("/v1/") || path.startsWith("/api/")) {
		for (const status of [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 501, 503]) {
			responses[status] = {
				description: `Request failed (${status}); see the error code and request ID.`,
				content: { "application/json": { schema: errorSchema } },
			};
		}
	}
	for (const [status, schema] of Object.entries(input.responses))
		responses[status] = {
			description: Number(status) < 400 ? "Successful response" : "Error response",
			content: { [contentType]: { schema } },
		};
	const security =
		input.security ??
		(path.startsWith("/api/")
			? [{ merchantSession: [], serviceToken: [] }]
			: path.startsWith("/v1/")
				? [{ projectKey: [] }, { gatewayProject: [] }]
				: []);
	if (
		path.startsWith("/api/") &&
		[
			"/api/platform/config",
			"/api/platform/signup-intent",
			"/api/platform/session/exchange",
			"/api/platform/verify-email",
			"/api/platform/invitations/preview",
			"/api/platform/invitations/request",
		].includes(path)
	)
		security.splice(0, security.length, { serviceToken: [] });
	const operatorRequired =
		path.startsWith("/v1/admin/catalog") ||
		path.startsWith("/v1/admin/contracts/") ||
		path.startsWith("/v1/admin/catalog-migrations/") ||
		path.startsWith("/v1/admin/auto-topups/") ||
		/^\/v1\/admin\/(store-events\/[^/]+\/replay|projection-jobs\/[^/]+\/retry|reconciliation\/subscriptions\/run|metrics)$/.test(
			path,
		);
	if (operatorRequired && !input.security)
		for (const scheme of security) Object.assign(scheme, { operatorKey: [] });
	let headers = input.headers;
	if (path.startsWith("/api/") && method !== "get")
		headers = (headers ?? z.object({})).extend({ Origin: z.string() });
	if (path.startsWith("/v1/") && method !== "get") {
		const actor =
			((input.tags.includes("catalog") || input.tags.includes("controls")) &&
				!path.endsWith("/entities")) ||
			path.endsWith("/corrections");
		const idempotent =
			(input.tags.includes("metering") && !path.endsWith("/check")) ||
			path.endsWith("/commercial-actions") ||
			path.endsWith("/changes");
		if (actor || idempotent)
			headers = (headers ?? z.object({})).extend({
				...(actor ? { "X-Billing-Actor": z.string().trim().min(1).max(200) } : {}),
				...(idempotent ? { "Idempotency-Key": z.string().min(1) } : {}),
			});
	}
	const route = createRoute({
		method,
		path: path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}"),
		operationId: input.operationId,
		tags: input.tags,
		description: input.description,
		security,
		request: {
			...(input.params ? { params: input.params } : {}),
			...(input.query ? { query: input.query } : {}),
			...(headers ? { headers } : {}),
			...(input.body
				? {
						body: {
							required: true,
							content: { [input.requestContentType ?? "application/json"]: { schema: input.body } },
						},
					}
				: {}),
		},
		responses,
	});
	return { method, path, route, input };
}

export type HttpContract = ReturnType<typeof defineContract>;
const registered = new WeakMap<object, HttpContract[]>();
/** Keep current parsing/error semantics: registration deliberately adds no second validator. */
export function registerRoute<E extends Env, P extends string>(
	app: Hono<E>,
	contract: ReturnType<typeof defineContract<P>>,
	handler: Handler<E, P>,
) {
	const entries = registered.get(app) ?? [];
	entries.push(contract);
	registered.set(app, entries);
	app.on(contract.method.toUpperCase(), contract.path, handler);
}
export function registeredContracts(app: object): readonly HttpContract[] {
	return registered.get(app) ?? [];
}
