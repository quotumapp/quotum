// The `/v1` paths that need `X-Billing-Operator-Key` on top of a project credential, grouped by
// the route module that owns them. The staff app's operator guards (`src/app/*-routes.ts`) match
// with these predicates and the documented security (`defaultSecurity` in `src/shared/http.ts`)
// is their union, so a route cannot be guarded at runtime without the contract saying so. Add a
// new operator-only path here; `tests/app/operator-auth.test.ts` probes every `/v1` route and
// fails when the runtime and the contract disagree.
//
// Predicates receive either the routed path (guards) or the route pattern with `:param`
// placeholders (the contract), so each one accepts both spellings.

const ADMIN_OPERATOR_PATH_PATTERN =
	/^\/v1\/admin\/(billing-accounts\/[^/]+\/provider-operations\/[^/]+\/reconcile|store-events\/[^/]+\/replay|projection-jobs\/[^/]+\/retry|subscription-changes\/[^/]+\/retry|usage-invoice-periods\/[^/]+\/retry|usage-invoice-adjustments\/[^/]+\/retry|reconciliation\/subscriptions\/run|metrics)$/;

const CONTROLS_OPERATOR_PATH_PATTERN = /^\/v1\/admin\/(contracts|catalog-migrations|auto-topups)\//;

export const operatorKeyPaths = {
	/** Recovery and reconciliation actions in `src/app/admin-routes.ts`. */
	admin: (path: string): boolean => ADMIN_OPERATOR_PATH_PATTERN.test(path),
	/** Every catalog route, reads included; only the published catalog read stays project-keyed. */
	catalog: (path: string): boolean => path.startsWith("/v1/admin/catalog/"),
	/** Contracts, catalog migrations and auto top-ups. */
	controls: (path: string): boolean => CONTROLS_OPERATOR_PATH_PATTERN.test(path),
	/** Promotion administration and redemption review. */
	promotions: (path: string): boolean => path.startsWith("/v1/admin/promotion"),
	/** Operator grants and administrative debits change balances. */
	balanceAdjustments: (path: string): boolean =>
		path.startsWith("/v1/admin/operator-grants/") ||
		path.startsWith("/v1/admin/administrative-debits/"),
} as const satisfies Record<string, (path: string) => boolean>;

/** Whether a `/v1` path needs the operator key, as the contract documents it. */
export function isOperatorKeyPath(path: string): boolean {
	return Object.values(operatorKeyPaths).some((matches) => matches(path));
}
