/** Consumer-owned operation boundary. It carries no credentials, HTTP requests, or database handles. */
const operations = [
	["GET", "/admin/stats/summary", "stats"],
	["GET", "/admin/customers/search", "customers.search"],
	["GET", "/admin/customers/by-billing-account/([^/]+)", "customers.account"],
	["GET", "/admin/customers/([^/]+)", "customers.detail"],
	["GET", "/admin/customers/([^/]+)/purchases", "customers.purchases"],
	["GET", "/admin/customers/([^/]+)/subscriptions", "customers.subscriptions"],
	["GET", "/admin/customers/([^/]+)/store-events", "customers.events"],
	["GET", "/admin/customers/([^/]+)/projection-jobs", "customers.projections"],
	["GET", "/admin/purchases", "purchases"],
	["GET", "/admin/subscriptions", "subscriptions"],
	["GET", "/admin/store-events", "events"],
	["GET", "/admin/store-events/([^/]+)", "events.detail"],
	["GET", "/admin/projection-jobs", "projections"],
	["GET", "/admin/catalog", "catalog"],
	["GET", "/admin/catalog/products", "catalog.products"],
	["GET", "/admin/catalog/store-products", "catalog.store-products"],
	["GET", "/billing-accounts/([^/]+)/billing-summary", "account.summary"],
	["GET", "/billing-accounts/([^/]+)/billing-account", "account.billing"],
	["GET", "/billing-accounts/([^/]+)/controls", "controls"],
	["PUT", "/billing-accounts/([^/]+)/controls", "controls.write"],
	["GET", "/billing-accounts/([^/]+)/usage/events", "usage.events"],
	["GET", "/billing-accounts/([^/]+)/usage/series", "usage.series"],
	["POST", "/admin/catalog/preview", "catalog.preview"],
	["POST", "/admin/catalog/publish", "catalog.publish"],
	["POST", "/admin/store-events/([^/]+)/replay", "events.replay"],
	["POST", "/admin/projection-jobs/([^/]+)/retry", "projections.retry"],
	["POST", "/admin/contracts/preview", "contracts.preview"],
	["POST", "/admin/contracts/publish", "contracts.publish"],
	["POST", "/admin/catalog-migrations/preview", "migrations.preview"],
	["POST", "/admin/catalog-migrations/publish", "migrations.publish"],
	["POST", "/billing-accounts/([^/]+)/commercial-actions/preview", "commercial.preview"],
	["POST", "/billing-accounts/([^/]+)/commercial-actions", "commercial.execute"],
	["POST", "/billing-accounts/([^/]+)/usage/events/([^/]+)/corrections", "usage.correct"],
] as const;

export type MerchantBillingOperation = (typeof operations)[number][2];
export interface MerchantBillingCommand {
	operation: MerchantBillingOperation;
	parameters: string[];
	projectInstanceId: string;
	actor: string;
	query: Record<string, string>;
	body: unknown;
	idempotencyKey: string | null;
}
export interface MerchantBillingPort {
	dispatch(command: MerchantBillingCommand): Promise<{ status: number; body: unknown }>;
}

export function billingOperation(method: string, path: string) {
	for (const [verb, pattern, operation] of operations) {
		if (method !== verb) continue;
		const match = new RegExp(`^/v1${pattern}$`, "u").exec(path);
		if (match) return { operation, parameters: match.slice(1).map(decodeURIComponent) };
	}
	return null;
}
