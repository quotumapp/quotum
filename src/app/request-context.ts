import { BillingError, InvalidRequestError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";
import { isStorableText } from "../shared/input-bounds";

const forbiddenProjectSelectorKeys = new Set(["projectId", "project_id"]);
/** Deeper than any intent or metadata a caller needs; deeper still would exhaust the stack later. */
const maxRequestBodyDepth = 64;

export function privateProject(
	project: ProjectInstanceContext | undefined,
): ProjectInstanceContext {
	if (project === undefined) {
		throw new BillingError("Billing project context is required", "BILLING_PROJECT_REQUIRED", 401);
	}
	return project;
}

export function requireActor(headers: Headers): string {
	const actor = headers.get("x-billing-actor")?.trim();
	if (actor === undefined || actor === "" || actor.length > 200) {
		throw new InvalidRequestError(
			"X-Billing-Actor header must contain between 1 and 200 characters",
		);
	}
	return actor;
}

/**
 * Route-level `transform` hook for /v1 request bodies: callers may never name a project selector
 * because tenancy is resolved from credentials. It must run as a transform, after the
 * authentication derive and before validation: by `beforeHandle`, Elysia has already replaced
 * `body` with the schema output, and non-strict schemas strip `projectId` silently.
 */
export function rejectCallerProjectSelectorBody(
	// biome-ignore lint/suspicious/noExplicitAny: Elysia infers hook context per route; a shared hook cannot name it.
	context: any,
): void {
	inspectRequestBody(context.body);
}

export function queryHasCallerProjectSelector(params: URLSearchParams): boolean {
	for (const key of forbiddenProjectSelectorKeys) {
		if (params.has(key)) {
			return true;
		}
	}

	return false;
}

export { urlHasEncodedNul } from "../shared/input-bounds";

export function projectSelectorRejectedError(): BillingError {
	return new BillingError("Project is resolved from billing credentials", "INVALID_REQUEST", 400);
}

/**
 * One iterative pass over a parsed body: it refuses a project selector key, nesting deeper than
 * the limit, and any key or string Postgres cannot store (NUL, unpaired surrogates), before any
 * of them reach validation, a handler or SQL.
 */
function inspectRequestBody(body: unknown): void {
	const pending: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];
	const seen = new Set<object>();
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const { value, depth } = next;
		if (typeof value === "string") {
			if (!isStorableText(value)) throw unstorableTextError();
			continue;
		}
		if (typeof value !== "object" || value === null || seen.has(value)) continue;
		if (depth >= maxRequestBodyDepth) {
			throw new InvalidRequestError(
				`Request body must not nest more than ${maxRequestBodyDepth} levels`,
			);
		}
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) pending.push({ value: item, depth: depth + 1 });
			continue;
		}
		for (const [key, child] of Object.entries(value)) {
			if (forbiddenProjectSelectorKeys.has(key)) throw projectSelectorRejectedError();
			if (!isStorableText(key)) throw unstorableTextError();
			pending.push({ value: child, depth: depth + 1 });
		}
	}
}

function unstorableTextError(): InvalidRequestError {
	return new InvalidRequestError(
		"Request text must not contain NUL characters or unpaired surrogates",
	);
}
