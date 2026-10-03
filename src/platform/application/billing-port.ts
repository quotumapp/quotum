import { MerchantError } from "../security";
import type { BillingChangesPort } from "./billing-changes";

/** Consumer-owned operation boundary. It carries no credentials, HTTP requests, or database handles. */
export const mcpBillingOperations = [
	["POST", "/billing-accounts/:billingAccountId/entities", "entities.write"],
	["GET", "/billing-accounts/:billingAccountId/entities", "entities"],
	["POST", "/admin/operator-grants/:billingAccountId", "grants.create"],
	["POST", "/admin/operator-grants/:billingAccountId/:grantId/revoke", "grants.revoke"],
	["GET", "/admin/operator-grants/:billingAccountId", "grants"],
	["POST", "/admin/administrative-debits/:billingAccountId", "debits.create"],
	["GET", "/admin/administrative-debits/:billingAccountId", "debits"],
	["POST", "/billing-accounts/:billingAccountId/trials", "trials.start"],
	["POST", "/billing-accounts/:billingAccountId/trials/:trialId/end", "trials.end"],
	["GET", "/billing-accounts/:billingAccountId/trials", "trials"],
	["POST", "/billing-accounts/:billingAccountId/usage-alerts", "alerts.create"],
	["GET", "/billing-accounts/:billingAccountId/usage-alerts", "alerts"],
	["PUT", "/billing-accounts/:billingAccountId/auto-topup", "topups.write"],
	["GET", "/billing-accounts/:billingAccountId/auto-topup", "topups"],
	["POST", "/admin/auto-topups/:billingAccountId/:policyId/reset", "topups.reset"],
	["POST", "/billing-accounts/:billingAccountId/license-assignments", "licenses.assign"],
	[
		"DELETE",
		"/billing-accounts/:billingAccountId/license-assignments/:assignmentId",
		"licenses.release",
	],
	["GET", "/billing-accounts/:billingAccountId/license-pools", "licenses"],
	["DELETE", "/admin/contracts/:billingAccountId/:contractId", "contracts.terminate"],
	["GET", "/admin/contracts/:billingAccountId", "contracts"],
	["POST", "/billing-accounts/:billingAccountId/promotion-redemptions", "promotions.redeem"],
] as const;

export const merchantBillingOperations = [
	["GET", "/catalog", "stripe.catalog"],
	["GET", "/billing-accounts/:billingAccountId/balances/:featureKey", "usage.balance"],
	[
		"GET",
		"/billing-accounts/:billingAccountId/usage/operations/:operation/:operationId",
		"usage.operation",
	],
	["POST", "/billing-accounts/:billingAccountId/usage/check", "usage.check"],
	["GET", "/admin/stats/summary", "stats"],
	["GET", "/admin/customers/search", "customers.search"],
	["GET", "/admin/customers/by-billing-account/:billingAccountId", "customers.account"],
	["GET", "/admin/customers/:customerId", "customers.detail"],
	["GET", "/admin/customers/:customerId/purchases", "customers.purchases"],
	["GET", "/admin/customers/:customerId/subscriptions", "customers.subscriptions"],
	["GET", "/admin/customers/:customerId/store-events", "customers.events"],
	["GET", "/admin/customers/:customerId/projection-jobs", "customers.projections"],
	["GET", "/admin/purchases", "purchases"],
	["GET", "/admin/subscriptions", "subscriptions"],
	["GET", "/admin/store-events", "events"],
	["GET", "/admin/store-events/:eventId", "events.detail"],
	["GET", "/admin/projection-jobs", "projections"],
	["GET", "/admin/usage-events", "usage-events"],
	["GET", "/admin/catalog", "catalog"],
	["GET", "/admin/catalog/products", "catalog.products"],
	["GET", "/admin/catalog/store-products", "catalog.store-products"],
	["GET", "/admin/providers/capabilities", "providers.capabilities"],
	["GET", "/billing-accounts/:billingAccountId/billing-summary", "account.summary"],
	["GET", "/billing-accounts/:billingAccountId/billing-account", "account.billing"],
	["GET", "/billing-accounts/:billingAccountId/available-actions", "account.actions"],
	[
		"GET",
		"/billing-accounts/:billingAccountId/provider-operations/:operationId",
		"commercial.operation",
	],
	[
		"GET",
		"/billing-accounts/:billingAccountId/payment-setup-sessions/:sessionId",
		"account.payment-setup",
	],
	["GET", "/billing-accounts/:billingAccountId/controls", "controls"],
	["PUT", "/billing-accounts/:billingAccountId/controls", "controls.write"],
	["GET", "/billing-accounts/:billingAccountId/usage/events", "usage.events"],
	["GET", "/billing-accounts/:billingAccountId/usage/series", "usage.series"],
	["GET", "/admin/promotions", "promotions"],
	["GET", "/admin/promotions/:promotionKey", "promotions.detail"],
	["GET", "/admin/promotions/:promotionKey/codes", "promotions.codes"],
	["GET", "/admin/promotions/:promotionKey/redemptions", "promotions.redemptions"],
	[
		"GET",
		"/billing-accounts/:billingAccountId/promotion-redemptions",
		"account.promotion-redemptions",
	],
	["POST", "/admin/catalog/preview", "catalog.preview"],
	["POST", "/admin/catalog/publish", "catalog.publish"],
	["POST", "/admin/store-events/:eventId/replay", "events.replay"],
	["POST", "/admin/projection-jobs/:jobId/retry", "projections.retry"],
	["POST", "/admin/contracts/preview", "contracts.preview"],
	["POST", "/admin/contracts/publish", "contracts.publish"],
	["POST", "/admin/catalog-migrations/preview", "migrations.preview"],
	["POST", "/admin/catalog-migrations/publish", "migrations.publish"],
	["POST", "/admin/promotions", "promotions.create"],
	["POST", "/admin/promotions/:promotionKey/apple-offers", "promotions.apple-offers.link"],
	[
		"POST",
		"/admin/promotions/:promotionKey/apple-offers/:offerId/retire",
		"promotions.apple-offers.retire",
	],
	["POST", "/admin/promotions/:promotionKey/archive", "promotions.archive"],
	["POST", "/admin/promotions/:promotionKey/provider-sync", "promotions.sync"],
	["POST", "/admin/promotion-redemptions/:redemptionId/revoke", "promotions.redemptions.revoke"],
	["POST", "/admin/promotions/:promotionKey/codes", "promotions.codes.add"],
	[
		"POST",
		"/admin/promotions/:promotionKey/codes/:codeId/deactivate",
		"promotions.codes.deactivate",
	],
	["POST", "/billing-accounts/:billingAccountId/commercial-actions/preview", "commercial.preview"],
	["POST", "/billing-accounts/:billingAccountId/commercial-actions", "commercial.execute"],
	[
		"POST",
		"/billing-accounts/:billingAccountId/usage/events/:usageEventId/corrections",
		"usage.correct",
	],
] as const;

export type MerchantBillingOperation = (
	| typeof merchantBillingOperations
	| typeof mcpBillingOperations
)[number][2];
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
	changes?: BillingChangesPort;
	dispatch(command: MerchantBillingCommand): Promise<{ status: number; body: unknown }>;
}

export function billingOperation(method: string, path: string) {
	for (const [verb, pattern, operation] of [
		...merchantBillingOperations,
		...mcpBillingOperations,
	]) {
		if (method !== verb) continue;
		const match = new RegExp(
			`^/v1${pattern.replace(/:[A-Za-z][A-Za-z0-9]*/g, "([^/]+)")}$`,
			"u",
		).exec(path);
		if (match) return { operation, parameters: match.slice(1).map(decodePathParameter) };
	}
	return null;
}

/** A malformed percent-escape is the caller's error, answered as /v1 answers it. */
function decodePathParameter(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new MerchantError("INVALID_REQUEST", "Request validation failed.");
	}
}
