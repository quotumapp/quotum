import { BillingError } from "../billing/errors";
import type { CredentialAccess } from "../shared/credential-access";
import { CREDENTIAL_ACCESS_EXTENSION } from "../shared/http";

interface RegisteredRoute {
	method: string;
	path: string;
	hooks: unknown;
}

/**
 * Whether a credential may call the matched route. Anything other than exactly `full` is gated, and
 * a gated credential reaches only routes that opted in through `operationDetail`. The lookup is by
 * the registered route pattern, never by matching the request path against patterns: several `/v1`
 * patterns overlap (`customers/:customerId` and `customers/search`), and only the router knows
 * which handler will run. An unknown route fails closed.
 */
export function createCredentialAccessGate(routes: () => readonly RegisteredRoute[]) {
	let readOnlyRoutes: ReadonlySet<string> | undefined;
	const optedIn = (): ReadonlySet<string> => {
		readOnlyRoutes ??= new Set(
			routes()
				.filter(
					(route) =>
						(route.hooks as { detail?: Record<string, unknown> } | undefined)?.detail?.[
							CREDENTIAL_ACCESS_EXTENSION
						] === "read_only",
				)
				.map((route) => routeKey(route.method, route.path)),
		);
		return readOnlyRoutes;
	};

	return (input: { access: CredentialAccess; method: string; route: string | undefined }): void => {
		if (input.access === "full") return;
		if (input.route !== undefined && optedIn().has(routeKey(input.method, input.route))) return;
		throw readOnlyCredentialError();
	};
}

export function readOnlyCredentialError(): BillingError {
	return new BillingError(
		"This operation is not available to a read-only project credential",
		"READ_ONLY_CREDENTIAL",
		403,
	);
}

// The router answers HEAD from the GET handler, so both share the GET declaration.
function routeKey(method: string, route: string): string {
	const normalized = method.toUpperCase();
	return `${normalized === "HEAD" ? "GET" : normalized} ${route}`;
}
