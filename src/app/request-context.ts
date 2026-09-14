import { BillingError, InvalidRequestError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";

const forbiddenProjectSelectorKeys = new Set(["projectId", "project_id"]);

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
	if (hasCallerProjectSelector(context.body)) {
		throw projectSelectorRejectedError();
	}
}

export function queryHasCallerProjectSelector(params: URLSearchParams): boolean {
	for (const key of forbiddenProjectSelectorKeys) {
		if (params.has(key)) {
			return true;
		}
	}

	return false;
}

export function projectSelectorRejectedError(): BillingError {
	return new BillingError("Project is resolved from billing credentials", "INVALID_REQUEST", 400);
}

function hasCallerProjectSelector(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	if (seen.has(value)) {
		return false;
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value.some((item) => hasCallerProjectSelector(item, seen));
	}

	for (const [key, child] of Object.entries(value)) {
		if (forbiddenProjectSelectorKeys.has(key) || hasCallerProjectSelector(child, seen)) {
			return true;
		}
	}

	return false;
}
