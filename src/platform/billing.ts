import { merchantJson } from "./app";
import { billingOperation, type MerchantBillingPort } from "./application/billing-port";
import type { MerchantCapability, MerchantScope } from "./contracts";
import { idempotencyKey, MerchantError, requireCapability } from "./security";
import { actionCapability, MerchantStepUp, mutationTarget } from "./step-up";
import type { MerchantIdentity, MerchantStore } from "./store";

interface BillingRoute {
	path: string;
	capability: MerchantCapability;
	action: "catalog.publish" | "operations.recover" | "operations.write" | null;
	sensitive: boolean;
}
const id = "[0-9a-fA-F-]{36}";
const account = "[^/]+";
const readPatterns = [
	"admin/stats/summary",
	"admin/customers/search",
	`admin/customers/by-billing-account/${account}`,
	`admin/customers/${id}(?:/(?:purchases|subscriptions|store-events|projection-jobs))?`,
	"admin/purchases",
	"admin/subscriptions",
	`admin/store-events(?:/${id})?`,
	"admin/projection-jobs",
	"admin/catalog(?:/(?:products|store-products))?",
	`admin/billing-accounts/${account}/(?:billing-summary|billing-account|controls|usage/(?:events|series))`,
];
export function merchantBillingRoute(
	method: string,
	pathname: string,
	environment: MerchantScope["environment"],
): BillingRoute | null {
	if (
		!pathname.startsWith("/api/billing/") ||
		/[\\\0]/.test(pathname) ||
		/%(?:2f|5c|2e)/i.test(pathname)
	)
		return null;
	const suffix = pathname.slice("/api/billing/".length);
	const path = `/v1/${suffix.replace(/^admin\/billing-accounts\//, "billing-accounts/")}`;
	if (method === "GET" && readPatterns.some((pattern) => new RegExp(`^${pattern}$`).test(suffix)))
		return { path, capability: "billing.read", action: null, sensitive: false };
	if (method === "POST" && suffix === "admin/catalog/preview")
		return { path, capability: "catalog.author", action: null, sensitive: false };
	if (method === "POST" && suffix === "admin/catalog/publish")
		return {
			path,
			capability: actionCapability("catalog.publish", environment),
			action: "catalog.publish",
			sensitive: environment === "production",
		};
	if (
		method === "POST" &&
		new RegExp(`^admin/(?:store-events/${id}/replay|projection-jobs/${id}/retry)$`).test(suffix)
	)
		return {
			path,
			capability: "operations.recover",
			action: "operations.recover",
			sensitive: true,
		};
	// Global reconciliation is intentionally absent: the existing operation is not project-scoped.
	if (
		method === "POST" &&
		/^(?:admin\/(?:contracts|catalog-migrations)\/preview|admin\/billing-accounts\/[^/]+\/commercial-actions\/preview)$/.test(
			suffix,
		)
	)
		return { path, capability: "operations.write", action: null, sensitive: false };
	if (
		(method === "POST" &&
			/^(?:admin\/(?:contracts|catalog-migrations)\/publish|admin\/billing-accounts\/[^/]+\/(?:commercial-actions|usage\/events\/[^/]+\/corrections))$/.test(
				suffix,
			)) ||
		(method === "PUT" && /^admin\/billing-accounts\/[^/]+\/controls$/.test(suffix))
	)
		return {
			path,
			capability: "operations.write",
			action: "operations.write",
			sensitive: environment === "production" || suffix.endsWith("/corrections"),
		};
	return null;
}
export function createMerchantBilling(store: MerchantStore, billing: MerchantBillingPort) {
	const steps = new MerchantStepUp(store);
	return async (request: Request, identity: MerchantIdentity): Promise<Response> => {
		const scope: MerchantScope = {
			kind: "merchant",
			organizationSlug: request.headers.get("x-quotum-organization") ?? "",
			projectKey: request.headers.get("x-quotum-project") ?? "",
			environment:
				request.headers.get("x-quotum-environment") === "production" ? "production" : "sandbox",
		};
		if (!["sandbox", "production"].includes(request.headers.get("x-quotum-environment") ?? ""))
			throw new MerchantError(
				"CONTEXT_REQUIRED",
				"Select an organization, project, and environment.",
				400,
			);
		const url = new URL(request.url);
		const route = merchantBillingRoute(request.method, url.pathname, scope.environment);
		if (!route) throw new MerchantError("NOT_FOUND", "Route not found.", 404);
		const member = await store.membership(store.sql, identity.principalId, scope.organizationSlug);
		requireCapability(member.role, route.capability);
		const [logicalProject] = await store.sql<
			{ id: string }[]
		>`SELECT id FROM platform_projects WHERE organization_id=${member.organization_id} AND key=${scope.projectKey}`;
		const instance = logicalProject
			? (await store.sql.instances.forProject(logicalProject.id)).find(
					(i) =>
						i.environment === scope.environment &&
						(i.lifecycleStatus === "active" ||
							(i.lifecycleStatus === "inactive" && route.path.startsWith("/v1/admin/catalog"))) &&
						!i.internalProject,
				)
			: undefined;
		if (!instance)
			throw new MerchantError(
				"CONTEXT_UNAVAILABLE",
				"The selected environment is not active or does not exist.",
				404,
			);
		const body = request.method === "GET" ? undefined : await merchantJson(request);
		if (request.method !== "GET") {
			await store.idempotent(
				identity,
				idempotencyKey(request),
				[
					"billing.authorize",
					scope,
					request.method,
					url.pathname,
					body,
					route.sensitive ? identity.sessionId : null,
				],
				async (tx) => {
					const latest = await store.membership(
						tx,
						identity.principalId,
						scope.organizationSlug,
						true,
					);
					requireCapability(latest.role, route.capability);
					if (route.sensitive && route.action)
						await steps.consume(
							tx,
							identity,
							scope,
							route.action,
							mutationTarget(request.method, url.pathname, body),
							request.headers.get("x-quotum-step-up-grant"),
						);
					await store.audit(
						tx,
						identity.principalId,
						latest.organization_id,
						"billing.action_accepted",
						instance.id,
						{ action: route.action, method: request.method, environment: scope.environment },
					);
					return { authorized: true };
				},
			);
		}
		const operation = billingOperation(request.method, route.path);
		if (!operation) throw new MerchantError("NOT_FOUND", "Route not found.", 404);
		const result = await billing.dispatch({
			...operation,
			projectInstanceId: instance.id,
			actor: `merchant:${identity.principalId}`,
			query: Object.fromEntries(url.searchParams),
			body,
			idempotencyKey: request.headers.get("idempotency-key"),
		});
		return Response.json(result.body, { status: result.status });
	};
}
