import { merchantJson } from "./app";
import { billingOperation, type MerchantBillingPort } from "./application/billing-port";
import type { MerchantCapability, MerchantScope } from "./contracts";
import type { MerchantSql } from "./database";
import { idempotencyKey, MerchantError, requireCapability } from "./security";
import { actionCapability, consumeStepUpGrant, mutationTarget } from "./step-up";
import type { MerchantIdentity, MerchantStore, StoredDispatchResponse } from "./store";

interface BillingRoute {
	readOnly: boolean;
	path: string;
	capability: MerchantCapability;
	action: "catalog.publish" | "operations.recover" | "operations.write" | "webhooks.manage" | null;
	sensitive: boolean;
	/** The response discloses a secret, once: a repeat of the request answers without it. */
	disclosesSecret?: true;
}
const id = "[0-9a-fA-F-]{36}";
const account = "[^/]+";
const readPatterns = [
	"catalog",
	`admin/billing-accounts/${account}/balances/[^/]+`,
	`admin/billing-accounts/${account}/usage/operations/[^/]+/[^/]+`,
	`admin/billing-accounts/${account}/provider-operations/${id}`,
	"admin/stats/summary",
	"admin/customers/search",
	`admin/customers/by-billing-account/${account}`,
	`admin/customers/${id}(?:/(?:purchases|subscriptions|store-events|projection-jobs))?`,
	"admin/purchases",
	"admin/subscriptions",
	`admin/store-events(?:/${id})?`,
	"admin/projection-jobs",
	"admin/usage-events",
	"admin/catalog(?:/(?:products|store-products))?",
	"admin/providers/capabilities",
	`admin/billing-accounts/${account}/(?:billing-summary|billing-account|available-actions|controls|usage/(?:events|series)|promotion-redemptions|refunds|invoices(?:/${id})?)`,
	`admin/promotions(?:/${account}(?:/(?:codes|redemptions))?)?`,
	`admin/webhook-endpoints(?:/${id})?`,
	"admin/webhook-deliveries",
	"admin/webhook-event-types",
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
	// The setup session read hands back an actionable hosted link, so it is a write-level action.
	if (
		method === "GET" &&
		new RegExp(`^admin/billing-accounts/${account}/payment-setup-sessions/[^/]+$`).test(suffix)
	)
		return {
			path,
			readOnly: false,
			capability: "operations.write",
			action: null,
			sensitive: false,
		};
	if (method === "GET" && readPatterns.some((pattern) => new RegExp(`^${pattern}$`).test(suffix)))
		return { path, readOnly: true, capability: "billing.read", action: null, sensitive: false };
	if (method === "POST" && /^admin\/billing-accounts\/[^/]+\/usage\/check$/.test(suffix))
		return { path, readOnly: true, capability: "billing.read", action: null, sensitive: false };
	if (method === "POST" && suffix === "admin/catalog/preview")
		return { path, readOnly: false, capability: "catalog.author", action: null, sensitive: false };
	if (method === "POST" && suffix === "admin/catalog/publish")
		return {
			path,
			readOnly: false,
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
			readOnly: false,
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
		return {
			path,
			readOnly: false,
			capability: "operations.write",
			action: null,
			sensitive: false,
		};
	if (
		(method === "POST" &&
			/^(?:admin\/(?:contracts|catalog-migrations)\/publish|admin\/billing-accounts\/[^/]+\/(?:commercial-actions|usage\/events\/[^/]+\/corrections)|admin\/promotions(?:\/[^/]+\/(?:archive|terms|provider-sync|apple-offers|apple-offers\/[^/]+\/retire|codes|codes\/[^/]+\/deactivate))?|admin\/promotion-redemptions\/[^/]+\/revoke)$/.test(
				suffix,
			)) ||
		(method === "PUT" && /^admin\/billing-accounts\/[^/]+\/controls$/.test(suffix))
	)
		return {
			path,
			readOnly: false,
			capability: "operations.write",
			action: "operations.write",
			sensitive: environment === "production" || suffix.endsWith("/corrections"),
		};
	// Endpoints are managed like the projection connection: Developers in sandbox, and Owners and
	// Admins in production after a step-up.
	if (
		(method === "POST" &&
			new RegExp(
				`^admin/(?:webhook-endpoints(?:/${id}/(?:rotate-secret|test|replay))?|webhook-deliveries/${id}/retry)$`,
			).test(suffix)) ||
		((method === "PATCH" || method === "DELETE") &&
			new RegExp(`^admin/webhook-endpoints/${id}$`).test(suffix))
	)
		return {
			path,
			readOnly: false,
			capability: actionCapability("webhooks.manage", environment),
			action: "webhooks.manage",
			sensitive: environment === "production",
			...(method === "POST" &&
			new RegExp(`^admin/webhook-endpoints(?:/${id}/rotate-secret)?$`).test(suffix)
				? { disclosesSecret: true as const }
				: {}),
		};
	return null;
}

/**
 * What a repeat of a request that disclosed a webhook signing secret answers: the answer `/v1` gives
 * a repeat, without the secret. Stored responses are kept for days, so the secret never reaches one.
 */
export function withheldSecret(response: StoredDispatchResponse): StoredDispatchResponse {
	const body = response.body as { data?: unknown } | null;
	if (response.status >= 300 || typeof body?.data !== "object" || body.data === null)
		return response;
	return {
		status: 200,
		body: {
			...body,
			data: { ...body.data, duplicate: true, secret: null, secretDisclosed: false },
		},
	};
}
export function createMerchantBilling(store: MerchantStore, billing: MerchantBillingPort) {
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
		// Resolved before authorization, so an unmapped or malformed path never consumes a step-up
		// grant or writes an audit row.
		const operation = billingOperation(request.method, route.path);
		if (!operation) throw new MerchantError("NOT_FOUND", "Route not found.", 404);
		const member = await store.membership(store.sql, identity.principalId, scope.organizationSlug);
		requireCapability(member.role, route.capability);
		const [logicalProject] = await store.sql<
			{ id: string }[]
		>`SELECT id FROM platform_projects WHERE organization_id=${member.organization_id} AND key=${scope.projectKey}`;
		const instance = logicalProject
			? (await store.sql.instances.forProject(logicalProject.id)).find(
					(i) =>
						i.environment === scope.environment &&
						i.lifecycleStatus === "active" &&
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
		const dispatch = () =>
			billing.dispatch({
				...operation,
				projectInstanceId: instance.id,
				actor: `merchant:${identity.principalId}`,
				query: Object.fromEntries(url.searchParams),
				body,
				idempotencyKey: request.headers.get("idempotency-key"),
			});
		// Actionable GETs still require write capability, but do not require mutation idempotency.
		if (route.readOnly || request.method === "GET") {
			const result = await dispatch();
			return billingResultResponse(result);
		}
		const authorize = async (tx: MerchantSql) => {
			const latest = await store.membership(tx, identity.principalId, scope.organizationSlug, true);
			requireCapability(latest.role, route.capability);
			if (route.sensitive && route.action)
				await consumeStepUpGrant(
					store,
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
		};
		// A repeat of this key answers with the stored response: the action, and the step-up grant
		// it consumed, run once.
		const result = await store.idempotentDispatch(
			identity,
			idempotencyKey(request),
			[
				"billing.dispatch",
				scope,
				request.method,
				url.pathname,
				body,
				route.sensitive ? identity.sessionId : null,
			],
			authorize,
			dispatch,
			route.disclosesSecret ? withheldSecret : undefined,
		);
		return billingResultResponse(result);
	};
}

/** The billing answer as the console proxy returns it: a provider outage keeps its wait in `retry-after`. */
export function billingResultResponse(result: { status: number; body: unknown }): Response {
	const seconds = providerRetryAfterSeconds(result);
	return Response.json(result.body, {
		status: result.status,
		...(seconds === null ? {} : { headers: { "retry-after": String(seconds) } }),
	});
}

function providerRetryAfterSeconds(result: { status: number; body: unknown }): number | null {
	if (result.status !== 503 || typeof result.body !== "object" || result.body === null) return null;
	const error = (
		result.body as { error?: { code?: unknown; details?: { retryAfterSeconds?: unknown } } }
	).error;
	const seconds = error?.details?.retryAfterSeconds;
	return error?.code === "BILLING_PROVIDER_UNAVAILABLE" &&
		typeof seconds === "number" &&
		Number.isInteger(seconds) &&
		seconds > 0
		? seconds
		: null;
}
