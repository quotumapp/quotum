import { describe, expect, it } from "bun:test";
import { createCredentialAccessGate } from "../../src/app/credential-access";
import { buildDocumentedApps } from "../../src/composition/openapi";
import { CREDENTIAL_ACCESS_EXTENSION } from "../../src/shared/http";

interface DocumentedRoute {
	method: string;
	path: string;
	operationId: string;
	readOnly: boolean;
	operatorKey: boolean;
}

function documentedRoutes(): DocumentedRoute[] {
	return buildDocumentedApps().flatMap((app) =>
		app.routes.flatMap((route) => {
			const detail = (route.hooks as { detail?: Record<string, unknown> }).detail;
			if (detail === undefined) return [];
			const security = (detail.security ?? []) as Record<string, string[]>[];
			return [
				{
					method: route.method,
					path: route.path,
					operationId: String(detail.operationId),
					readOnly: detail[CREDENTIAL_ACCESS_EXTENSION] === "read_only",
					operatorKey: security.some((scheme) => "operatorKey" in scheme),
				},
			];
		}),
	);
}

// Reviewed list. A read-only credential reaches exactly these operations; adding one is a decision
// that the route writes nothing, calls no provider and returns nothing bearer-like.
const readOnlyOperations = [
	"getV1AdminCatalog",
	"getV1AdminCustomersByBillingAccountByBillingAccountId",
	"getV1AdminCustomersByCustomerId",
	"getV1AdminCustomersByCustomerIdProjectionJobs",
	"getV1AdminCustomersByCustomerIdPurchases",
	"getV1AdminCustomersByCustomerIdStoreEvents",
	"getV1AdminCustomersByCustomerIdSubscriptions",
	"getV1AdminCustomersSearch",
	"getV1AdminProjectionJobs",
	"getV1AdminProvidersCapabilities",
	"getV1AdminPurchases",
	"getV1AdminStatsSummary",
	"getV1AdminStoreEvents",
	"getV1AdminStoreEventsByEventId",
	"getV1AdminSubscriptions",
	"getV1AdminUsageEvents",
	"getV1BillingAccountsByBillingAccountIdAutoTopup",
	"getV1BillingAccountsByBillingAccountIdAvailableActions",
	"getV1BillingAccountsByBillingAccountIdBalancesByFeatureKey",
	"getV1BillingAccountsByBillingAccountIdBillingAccount",
	"getV1BillingAccountsByBillingAccountIdBillingSummary",
	"getV1BillingAccountsByBillingAccountIdControls",
	"getV1BillingAccountsByBillingAccountIdEntities",
	"getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKey",
	"getV1BillingAccountsByBillingAccountIdEntitlements",
	"getV1BillingAccountsByBillingAccountIdLicensePools",
	"getV1BillingAccountsByBillingAccountIdUsageAlertEvents",
	"getV1BillingAccountsByBillingAccountIdUsageAlerts",
	"getV1BillingAccountsByBillingAccountIdUsageEvents",
	"getV1BillingAccountsByBillingAccountIdUsageOperationsByOperationByOperationId",
	"getV1BillingAccountsByBillingAccountIdUsageSeries",
	"getV1Catalog",
	"postV1BillingAccountsByBillingAccountIdUsageCheck",
];

// GETs that write, call a provider or return bearer-like values; they must never be opted in.
const neverReadOnly = [
	"/v1/billing-accounts/:billingAccountId/providers/apple/account-token",
	"/v1/billing-accounts/:billingAccountId/providers/google/account-link",
	"/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId",
	"/v1/billing-accounts/:billingAccountId/promotion-redemptions",
	"/v1/billing-accounts/:billingAccountId/promotion-redemptions/:redemptionId",
];

describe("read-only credential route inventory", () => {
	const routes = documentedRoutes();

	it("opts in exactly the reviewed operations", () => {
		expect(routes.length).toBeGreaterThan(100);
		expect(
			routes
				.filter((route) => route.readOnly)
				.map((route) => route.operationId)
				.sort(),
		).toEqual([...readOnlyOperations].sort());
	});

	it("opts in only /v1 reads that need no operator key", () => {
		const violations = routes
			.filter((route) => route.readOnly)
			.filter(
				(route) =>
					!route.path.startsWith("/v1/") ||
					route.operatorKey ||
					neverReadOnly.includes(route.path) ||
					!(
						route.method === "GET" ||
						(route.method === "POST" && route.path.endsWith("/usage/check"))
					),
			)
			.map((route) => `${route.method} ${route.path}`);
		expect(violations).toEqual([]);
	});

	it("keeps every other catalog route behind the operator key", () => {
		const catalog = routes.filter((route) => route.path.startsWith("/v1/admin/catalog"));
		expect(
			catalog.filter((route) => !route.operatorKey).map((route) => `${route.method} ${route.path}`),
		).toEqual(["GET /v1/admin/catalog"]);
		expect(catalog.length).toBeGreaterThan(4);
	});
});

describe("credential access gate", () => {
	const gate = createCredentialAccessGate(() => [
		{
			method: "GET",
			path: "/v1/things/:id",
			hooks: { detail: { [CREDENTIAL_ACCESS_EXTENSION]: "read_only" } },
		},
		{ method: "POST", path: "/v1/things/:id", hooks: { detail: {} } },
		{ method: "GET", path: "/v1/things/search", hooks: { detail: {} } },
	]);
	const refused = (input: Parameters<typeof gate>[0]) => {
		try {
			gate(input);
			return null;
		} catch (error) {
			return (error as { code?: string; status?: number }).code;
		}
	};

	it("never gates a full credential", () => {
		expect(refused({ access: "full", method: "POST", route: "/v1/things/:id" })).toBeNull();
		expect(refused({ access: "full", method: "DELETE", route: undefined })).toBeNull();
	});

	it("lets a read-only credential reach opted-in routes only, by registered pattern", () => {
		expect(refused({ access: "read_only", method: "GET", route: "/v1/things/:id" })).toBeNull();
		expect(refused({ access: "read_only", method: "HEAD", route: "/v1/things/:id" })).toBeNull();
		for (const input of [
			{ method: "POST", route: "/v1/things/:id" },
			// The concrete path would match the opted-in pattern; the registered route does not.
			{ method: "GET", route: "/v1/things/search" },
			{ method: "GET", route: "/v1/things/42" },
			{ method: "GET", route: undefined },
		]) {
			expect(refused({ access: "read_only", ...input })).toBe("READ_ONLY_CREDENTIAL");
		}
	});

	it("fails closed for any access value that is not exactly full", () => {
		expect(refused({ access: "admin" as never, method: "POST", route: "/v1/things/:id" })).toBe(
			"READ_ONLY_CREDENTIAL",
		);
	});
});
