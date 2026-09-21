import type { Elysia } from "elysia";
import { z } from "zod";
import { bodyTooLargeError, DEFAULT_BODY_LIMIT_BYTES, readCappedText } from "./body-limit";

/**
 * Domain-neutral HTTP plumbing shared by the /v1 staff surface and the /api merchant surface.
 * Must stay free of billing and platform imports; error types are injected by the callers.
 */

export const errorSchema = z.object({
	success: z.literal(false),
	error: z.object({
		code: z.string(),
		message: z.string(),
		retryAfter: z.number().optional(),
		requestId: z.string().optional(),
		/** Structured context for the code; opaque here so the envelope names no domain schema. */
		details: z.record(z.string(), z.unknown()).optional(),
	}),
});

/** Name under which the shared error envelope is registered in the OpenAPI document. */
export const ERROR_SCHEMA_REF = "#/components/schemas/QuotumError";

export interface ErrorEnvelopeBody {
	success: false;
	error: {
		code: string;
		message: string;
		retryAfter?: number;
		requestId?: string;
		details?: Record<string, unknown>;
	};
}

/**
 * Options for every Elysia instance that serves or composes Quotum routes. Elysia matches `/x/`
 * as `/x` unless `strictPath` is set; Quotum's operator-key guards and limiters match exact paths,
 * so a loose router would let a trailing slash reach a handler its guard never inspected.
 */
export const HTTP_APP_CONFIG = { strictPath: true } as const;

/**
 * The path Elysia routed the request by. Elysia derives it from `request.url` with a
 * hostname-length heuristic, so it can differ from `new URL(request.url).pathname` (for example
 * with a one-character Host header). Gates, guards and limiter keys must use this value so they
 * always describe the handler that will run.
 */
export function routedPath(context: { path?: unknown; request: Request }): string {
	return typeof context.path === "string" ? context.path : new URL(context.request.url).pathname;
}

/** Loose app type used by route registration helpers; per-route schemas keep handler typing local. */
// biome-ignore lint/suspicious/noExplicitAny: route helpers must accept any composition state.
export type AppElysia = Elysia<any, any>;

/** An Elysia plugin: receives the app and returns it with hooks or routes attached. */
export type ElysiaPluginLike = (app: AppElysia) => AppElysia;

/**
 * Named parser selecting lenient JSON parsing for routes that declare `parse: ["flexJson"]`.
 * Typed as never because Elysia's parse-name union only knows its built-in parsers; the runtime
 * value is registered through `app.parser`.
 */
export const LENIENT_JSON_PARSE = "flexJson" as never;

/**
 * Private /v1 body parser. Every content type is read as text under the 256 KB cap and parsed as
 * JSON, as the pre-Elysia handlers did. Elysia runs parsers before the authentication derive, so
 * the cap is what bounds unauthenticated reads.
 *
 * The parser must never return `undefined` for a request that has a body: Elysia treats that as
 * "not handled" and falls through to its built-in form, multipart and binary parsers, which read
 * the whole body without a cap. Malformed or empty JSON therefore resolves to `null`, which every
 * body schema rejects. Only a request without a body (Bun reports `request.body === null` for
 * zero-length requests) resolves to `undefined`, so optional bodies stay optional and there is
 * nothing left for another parser to read.
 */
export async function lenientJsonParser({ request }: { request: Request }): Promise<unknown> {
	if (request.body === null) return undefined;
	const text = await readCappedText(request, DEFAULT_BODY_LIMIT_BYTES, bodyTooLargeError);
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

const operatorRequiredPathPattern =
	/^\/v1\/admin\/(store-events\/[^/]+\/replay|projection-jobs\/[^/]+\/retry|reconciliation\/subscriptions\/run|metrics)$/;

function operatorRequiredPath(path: string): boolean {
	return (
		path.startsWith("/v1/admin/catalog/") ||
		path.startsWith("/v1/admin/contracts/") ||
		path.startsWith("/v1/admin/catalog-migrations/") ||
		path.startsWith("/v1/admin/auto-topups/") ||
		path.startsWith("/v1/admin/promotion") ||
		operatorRequiredPathPattern.test(path)
	);
}

const SERVICE_TOKEN_ONLY_API_PATHS = new Set([
	"/api/platform/config",
	"/api/platform/signup-intent",
	"/api/platform/session/exchange",
	"/api/platform/verify-email",
	"/api/platform/invitations/preview",
	"/api/platform/invitations/request",
]);

/** Security schemes documented for an operation, derived from its path prefix. */
export function defaultSecurity(
	path: string,
	explicit?: Record<string, string[]>[],
): Record<string, string[]>[] {
	if (explicit !== undefined) return explicit;
	if (path.startsWith("/api/")) {
		if (SERVICE_TOKEN_ONLY_API_PATHS.has(path)) return [{ serviceToken: [] }];
		return [{ merchantSession: [], serviceToken: [] }];
	}
	if (path.startsWith("/v1/")) {
		const security: Record<string, string[]>[] = [{ projectKey: [] }, { gatewayProject: [] }];
		if (operatorRequiredPath(path))
			for (const scheme of security) Object.assign(scheme, { operatorKey: [] });
		return security;
	}
	return [];
}

/** Key under which `operationDetail` keeps an operation's Zod metadata for the OpenAPI generator. */
export const OPERATION_DOC = "x-quotum-operation";

/**
 * Published on an operation that a read-only project credential may call. The `/v1` shell enforces
 * exactly this field, so the contract and the gate cannot disagree. Absent means full access only.
 */
export const CREDENTIAL_ACCESS_EXTENSION = "x-quotum-credential-access";

/** Request inputs a handler validates itself; Elysia `body`, `query` and `params` validators are read directly. */
export interface OperationRequestDoc {
	body?: z.ZodType;
	query?: z.ZodObject;
	params?: z.ZodObject;
}

export interface OperationDoc {
	path: string;
	responses: Record<string, z.ZodType>;
	contentType?: string;
	request?: OperationRequestDoc;
}

/**
 * Assemble the Elysia `detail` object for one operation. Schemas stay as Zod values: the
 * OpenAPI generator (`src/composition/openapi.ts`) renders them, names shared schemas and derives
 * the standard error responses and required headers from the path.
 */
export function operationDetail(input: {
	operationId: string;
	tags: readonly string[];
	path: string;
	description?: string;
	security?: Record<string, string[]>[];
	/** Opt the route in for read-only credentials. Only for `/v1` reads that write nothing. */
	credentialAccess?: "read_only";
	responses: Record<string, z.ZodType>;
	contentType?: string;
	request?: OperationRequestDoc;
}): Record<string, unknown> {
	const doc: OperationDoc = {
		path: input.path,
		responses: input.responses,
		...(input.contentType === undefined ? {} : { contentType: input.contentType }),
		...(input.request === undefined ? {} : { request: input.request }),
	};
	return {
		operationId: input.operationId,
		tags: [...input.tags],
		...(input.description === undefined ? {} : { description: input.description }),
		security: defaultSecurity(input.path, input.security),
		...(input.credentialAccess === undefined
			? {}
			: { [CREDENTIAL_ACCESS_EXTENSION]: input.credentialAccess }),
		[OPERATION_DOC]: doc,
	};
}
