import { Elysia } from "elysia";
import type { AdminBillingReader } from "./admin/types";
import { registerAdminRoutes } from "./app/admin-routes";
import { registerCapabilityRoutes } from "./app/capability-routes";
import { registerCatalogRoutes } from "./app/catalog-routes";
import { registerControlsRoutes } from "./app/controls-routes";
import { createCredentialAccessGate } from "./app/credential-access";
import { registerCustomerRoutes } from "./app/customer-routes";
import { registerInsightsRoutes } from "./app/insights-routes";
import { registerMeteringRoutes } from "./app/metering-routes";
import { registerPromotionRoutes } from "./app/promotion-routes";
import { projectProviderServiceResolver } from "./app/provider-services";
import { projectSelectorRejectedError, queryHasCallerProjectSelector } from "./app/request-context";
import type {
	AppDependencies as CreateAppDependencies,
	PostAuthGuard,
	PreAuthGate,
	PreAuthGateInput,
	RequestObserver,
} from "./app/types";
import { registerWebhookRoutes } from "./app/webhook-routes";
import { EntitlementService } from "./billing/entitlements";
import { BillingError, classifyBillingError, isBillingError } from "./billing/errors";
import { MeteringService } from "./billing/metering";
import { PostgresProjectInstanceContextResolver } from "./composition/project-instance-persistence";
import { AdminBillingRepository } from "./db/admin-repository";
import { checkPostgresHealth } from "./db/client";
import { BillingRepository } from "./db/repository";
import { registerOperationalRoutes } from "./http/operational-routes";
import {
	createFixedWindowRateLimiter,
	RateLimitExceeded,
	type RateLimitServer,
	rateLimitHeaders,
	rateLimitResponse,
	requestIp,
} from "./http/rate-limit";
import { createNoopBillingLogger, safelyLogError, safelyLogWarn } from "./observability/logger";
import {
	createInMemoryBillingMetrics,
	safelyIncrementBillingMetric,
} from "./observability/metrics";
import { createPrometheusMetricsRenderer } from "./observability/prometheus-metrics";
import {
	isTenantTrafficEligible,
	type ProjectInstanceContext,
	type ProjectInstanceContextResolver,
} from "./projects/context";
import { createProviderCapabilityReads } from "./providers/capability-reads";
import { createProviderRegistry } from "./providers/registry";
import { DEFAULT_BODY_LIMIT_BYTES, isBodyTooLarge } from "./shared/body-limit";
import type { CredentialAccess } from "./shared/credential-access";
import {
	type ErrorEnvelopeBody,
	HTTP_APP_CONFIG,
	LENIENT_JSON_PARSE,
	lenientJsonParser,
	routedPath,
} from "./shared/http";

export type { AppDependencies } from "./app/types";

const WEBHOOK_PATH_PATTERN = /^\/v1\/projects\/[^/]+\/webhooks\/(apple|google|stripe)$/;

const requestIds = new WeakMap<Request, string>();

function aggregateV1RateLimitGate(
	limiter: {
		check(key: string): { allowed: boolean; remaining: number; resetAt: Date };
	},
	trustProxyHeaders?: boolean,
): PreAuthGate {
	return {
		matches: (path) => path.startsWith("/v1/") && !WEBHOOK_PATH_PATTERN.test(path),
		gate({ request, server }: PreAuthGateInput) {
			// This aggregate guard is intentionally looser than any individual downstream policy.
			const result = limiter.check(requestIp({ request, server }, { trustProxyHeaders }));
			if (!result.allowed) {
				return rateLimitResponse(result);
			}
			return undefined;
		},
	};
}

export function createApp({
	env,
	connections,
	entitlementService,
	meteringService,
	controlsEnterpriseService,
	promotionService,
	catalogControlPlane,
	billingInsightsService,
	appleStoreKitService,
	googlePlayBillingService,
	stripeBillingService,
	projectProviderServices,
	providerRegistry: sharedProviderRegistry,
	providerCapabilityReads,
	adminBillingReader,
	adminOperations,
	logger,
	metrics,
	readinessCheck,
	requestObservabilityMiddleware,
	projectContextResolver,
}: CreateAppDependencies) {
	if (
		sharedProviderRegistry !== undefined &&
		(appleStoreKitService !== undefined ||
			googlePlayBillingService !== undefined ||
			stripeBillingService !== undefined ||
			projectProviderServices !== undefined)
	) {
		throw new Error("createApp accepts either a provider registry or provider services, not both");
	}
	const app = new Elysia(HTTP_APP_CONFIG);
	const billingLogger = logger ?? createNoopBillingLogger();
	const billingMetrics = metrics ?? createInMemoryBillingMetrics();
	const renderMetrics = createPrometheusMetricsRenderer(billingMetrics);
	let repository: BillingRepository | null = null;
	const getRepository = () => {
		repository ??= new BillingRepository();
		return repository;
	};
	const service = entitlementService ?? new EntitlementService(getRepository());
	let defaultMeteringService: MeteringService | null = null;
	const getMeteringService = () => {
		if (meteringService !== undefined) {
			return meteringService;
		}
		defaultMeteringService ??= new MeteringService(getRepository());
		return defaultMeteringService;
	};
	const catalogService = catalogControlPlane ?? {
		getPublished: (...args: Parameters<BillingRepository["getPublishedCatalog"]>) =>
			getRepository().getPublishedCatalog(...args),
		preview: (...args: Parameters<BillingRepository["previewCatalog"]>) =>
			getRepository().previewCatalog(...args),
		publish: (...args: Parameters<BillingRepository["publishCatalog"]>) =>
			getRepository().publishCatalog(...args),
	};
	const controlsService = controlsEnterpriseService ?? getRepository().controlsEnterprise;
	const providerRegistry =
		sharedProviderRegistry ??
		createProviderRegistry({
			connections,
			getRepository,
			overrides: projectProviderServices,
			legacyServices: {
				appleStoreKitService,
				googlePlayBillingService,
				stripeBillingService,
			},
		});
	const providerServices = projectProviderServiceResolver(providerRegistry);
	const capabilityReads =
		providerCapabilityReads ??
		createProviderCapabilityReads({
			registry: providerRegistry,
			facts: {
				getAvailableActionFacts: (...args) => getRepository().getAvailableActionFacts(...args),
			},
		});
	let adminRepository: AdminBillingRepository | null = null;
	const getAdminBillingReader = (): AdminBillingReader | null => {
		if (adminBillingReader !== undefined) {
			return adminBillingReader;
		}

		adminRepository ??= new AdminBillingRepository({
			providerReconciliationStaleAfterMs: env.providerReconciliationStaleAfterMs,
		});
		return adminRepository;
	};
	const contextResolver = projectContextResolver ?? new PostgresProjectInstanceContextResolver();
	const checkReady = readinessCheck ?? checkPostgresHealth;
	const rateLimitKeyOptions = { trustProxyHeaders: env.rateLimit.trustProxyHeaders };

	const preAuthGates: PreAuthGate[] = [];
	const registerPreAuthGate = (gate: PreAuthGate): void => {
		preAuthGates.push(gate);
	};
	const postAuthGuards: PostAuthGuard[] = [];
	const registerPostAuthGuard = (guard: PostAuthGuard): void => {
		postAuthGuards.push(guard);
	};
	const requestObservers: RequestObserver[] = [];
	const registerRequestObserver = (observer: RequestObserver): void => {
		requestObservers.push(observer);
	};
	const observedRequests = new WeakMap<
		Request,
		{ observers: RequestObserver[]; path: string; startedAt: number }
	>();
	const finishObservedRequest = (request: Request, result: "completed" | "failed"): void => {
		const observed = observedRequests.get(request);
		if (observed === undefined) return;
		observedRequests.delete(request);
		const durationMs = performance.now() - observed.startedAt;
		for (const observer of observed.observers) {
			try {
				observer.finish({ path: observed.path, durationMs, result });
			} catch {
				// Observers are telemetry; they must never change the response.
			}
		}
	};

	app.parser(LENIENT_JSON_PARSE, lenientJsonParser);

	if (requestObservabilityMiddleware !== undefined) {
		app.use(requestObservabilityMiddleware);
	}

	app.onRequest((context) => {
		const { request, set, server } = context;
		const requestId =
			requestIdFromHeader(request.headers.get("x-request-id")) ?? crypto.randomUUID();
		requestIds.set(request, requestId);
		set.headers["x-request-id"] = requestId;

		const path = routedPath(context);
		if (
			path.startsWith("/v1/") &&
			request.method !== "GET" &&
			request.method !== "HEAD" &&
			oversizedContentLength(request.headers.get("content-length"))
		) {
			return billingJsonResponse(413, {
				success: false,
				error: { code: "REQUEST_BODY_TOO_LARGE", message: "Request body is too large" },
			});
		}

		const rateLimitServer = (server ?? null) as RateLimitServer | null;
		for (const gate of preAuthGates) {
			if (!gate.matches(path)) {
				continue;
			}
			const rejection = gate.gate({ request, path, server: rateLimitServer, set });
			if (rejection !== undefined) {
				return rejection;
			}
		}
		return undefined;
	});

	app.onError(({ request, error, set, code }) => {
		finishObservedRequest(request, "failed");
		const requestId = requestIds.get(request) ?? "";
		const headers: Record<string, string> = {};
		if (requestId !== "") {
			headers["x-request-id"] = requestId;
		}

		if (isBodyTooLarge(error) || isBodyTooLarge((error as { cause?: unknown })?.cause)) {
			return billingJsonResponse(
				413,
				{
					success: false,
					error: { code: "REQUEST_BODY_TOO_LARGE", message: "Request body is too large" },
				},
				headers,
			);
		}

		if (code === "VALIDATION" || (typeof code === "string" && code === "PARSE")) {
			set.status = 400;
			return billingJsonResponse(
				400,
				{
					success: false,
					error: { code: "INVALID_REQUEST", message: "Request validation failed" },
				},
				headers,
			);
		}

		if (error instanceof RateLimitExceeded) {
			Object.assign(set.headers, rateLimitHeaders(error.result));
			return billingJsonResponse(
				429,
				{ success: false, error: { code: "RATE_LIMITED", message: "Too many requests" } },
				headers,
			);
		}

		if (code === "NOT_FOUND" && !isBillingError(error)) {
			return billingJsonResponse(
				404,
				{ success: false, error: { code: "NOT_FOUND", message: "Route not found" } },
				headers,
			);
		}

		const classified = classifyBillingError(error);
		const url = new URL(request.url);
		const routeGroup = routeGroupForPath(url.pathname);
		if (classified.status >= 500) {
			safelyIncrementBillingMetric(billingMetrics, "billing_http_errors_total", {
				route_group: routeGroup,
				status: String(classified.status),
				code: classified.code,
				classification: classified.classification,
			});
			safelyLogError(billingLogger, "Billing request failed", error, {
				requestId,
				method: request.method,
				path: url.pathname,
				routeGroup,
				status: String(classified.status),
				code: classified.code,
				classification: classified.classification,
			});
		}
		return billingJsonResponse(
			classified.status,
			{
				success: false,
				error: {
					code: classified.code,
					message: classified.message,
					...(classified.details === undefined ? {} : { details: classified.details }),
				},
			},
			headers,
		);
	});

	registerOperationalRoutes({
		app,
		readinessCheck: checkReady,
		renderMetrics,
	});

	registerWebhookRoutes({
		app,
		contextResolver,
		registerPreAuthGate,
		rateLimitKeyOptions,
		webhookLimiter: createWebhookLimiter(),
		providerServices,
		billingMetrics,
		billingLogger,
	});

	registerPreAuthGate(
		aggregateV1RateLimitGate(createAggregateLimiter(), env.rateLimit.trustProxyHeaders),
	);

	const credentialAccessGate = createCredentialAccessGate(() => app.routes);

	app.derive(async ({ request, path, route, server, set }) => {
		// Gateway mode reads no credential, so the trusted gateway owns any read-only restriction.
		const { project, credentialAccess } =
			env.authMode === "api_key"
				? await resolveProjectFromApiKey(request, contextResolver)
				: {
						...(await resolveGatewayProject(request, contextResolver)),
						credentialAccess: "full" as const,
					};
		if (queryHasCallerProjectSelector(new URL(request.url).searchParams)) {
			throw projectSelectorRejectedError();
		}
		// Before observers and limiters: a refused read-only credential is neither a failed metering
		// operation nor a charge against the project's rate-limit budget.
		try {
			credentialAccessGate({ access: credentialAccess, method: request.method, route });
		} catch (error) {
			// A read-only key used for a write is a misconfigured tool or a leaked key being probed.
			safelyLogWarn(billingLogger, "Read-only project credential refused", {
				projectKey: project.projectInstanceKey,
				method: request.method,
				route: route ?? null,
			});
			throw error;
		}
		const observers = requestObservers.filter((observer) => observer.matches(path));
		if (observers.length > 0) {
			observedRequests.set(request, { observers, path, startedAt: performance.now() });
		}
		// Path-group limiters and operator-key guards run here: after authentication, before request
		// validation. They match the routed path so they always describe the handler that will run.
		const rateLimitServer = (server ?? null) as RateLimitServer | null;
		for (const guard of postAuthGuards) {
			if (!guard.matches(path)) {
				continue;
			}
			await guard.guard({
				request,
				path,
				server: rateLimitServer,
				projectKey: project.projectInstanceKey,
				set: set as unknown as { headers: Record<string, string> },
			});
		}
		return { project, credentialAccess };
	});
	app.onAfterHandle(({ request }) => {
		finishObservedRequest(request, "completed");
	});

	registerCustomerRoutes({
		app,
		verifyLimiter: createVerifyLimiter(),
		rateLimitKeyOptions,
		entitlementService: service,
		providerServices,
		billingMetrics,
		billingLogger,
		registerPostAuthGuard,
	});
	registerInsightsRoutes({
		app,
		service: billingInsightsService ?? {
			listUsageEvents: (...args) => getRepository().listUsageEvents(...args),
			listProjectUsageEvents: (...args) => getRepository().listProjectUsageEvents(...args),
			getUsageSeries: (...args) => getRepository().getUsageSeries(...args),
			getCustomerBillingSummary: (...args) => getRepository().getCustomerBillingSummary(...args),
		},
	});
	registerCapabilityRoutes({ app, reads: capabilityReads });
	registerMeteringRoutes({
		app,
		meteringLimiter: createMeteringLimiter(),
		rateLimitKeyOptions,
		meteringService: {
			getOperation: (...args) => getMeteringService().getOperation(...args),
			getBalance: (...args) => getMeteringService().getBalance(...args),
			check: (...args) => getMeteringService().check(...args),
			consume: (...args) => getMeteringService().consume(...args),
			reserve: (...args) => getMeteringService().reserve(...args),
			confirm: (...args) => getMeteringService().confirm(...args),
			release: (...args) => getMeteringService().release(...args),
			correct: (...args) => getMeteringService().correct(...args),
		},
		billingMetrics,
		registerPostAuthGuard,
		registerRequestObserver,
	});
	registerControlsRoutes({
		app,
		operatorApiKey: env.operatorApiKey,
		service: controlsService,
		registerPostAuthGuard,
	});
	registerAdminRoutes({
		app,
		adminLimiter: createAdminLimiter(),
		rateLimitKeyOptions,
		operatorApiKey: env.operatorApiKey,
		renderMetrics,
		billingLogger,
		getAdminBillingReader,
		adminOperations: adminOperations ?? null,
		registerPostAuthGuard,
	});
	registerCatalogRoutes({
		app,
		operatorApiKey: env.operatorApiKey,
		catalogControlPlane: catalogService,
		registerPostAuthGuard,
	});
	registerPromotionRoutes({
		app,
		operatorApiKey: env.operatorApiKey,
		service: promotionService ?? getRepository().promotions,
		validationLimiter: createVerifyLimiter(),
		rateLimitKeyOptions,
		registerPostAuthGuard,
	});

	return app;

	function createWebhookLimiter() {
		return createFixedWindowRateLimiter({
			windowMs: env.rateLimit.windowMs,
			limit: env.rateLimit.webhookLimit,
		});
	}
	function createVerifyLimiter() {
		return createFixedWindowRateLimiter({
			windowMs: env.rateLimit.windowMs,
			limit: env.rateLimit.verifyLimit,
		});
	}
	function createAdminLimiter() {
		return createFixedWindowRateLimiter({
			windowMs: env.rateLimit.windowMs,
			limit: env.rateLimit.adminLimit,
		});
	}
	function createMeteringLimiter() {
		return createFixedWindowRateLimiter({
			windowMs: env.rateLimit.windowMs,
			limit: env.rateLimit.meteringLimit,
		});
	}
	function createAggregateLimiter() {
		return createFixedWindowRateLimiter({
			windowMs: env.rateLimit.windowMs,
			// This aggregate guard is intentionally looser than any individual downstream policy.
			limit: Math.min(
				Number.MAX_SAFE_INTEGER,
				env.rateLimit.verifyLimit + env.rateLimit.adminLimit + env.rateLimit.meteringLimit,
			),
		});
	}
}

function resolveProjectFromApiKey(
	request: Request,
	resolver: ProjectInstanceContextResolver,
): Promise<{ project: ProjectInstanceContext; credentialAccess: CredentialAccess }> {
	return (async () => {
		const token = parseBearerToken(request.headers.get("authorization"));
		const resolution =
			token === null ? { kind: "not_found" as const } : await resolver.resolveCredential(token);
		if (resolution.kind === "unavailable") {
			throw new BillingError(
				"Billing project context is unavailable",
				"BILLING_PROJECT_CONTEXT_UNAVAILABLE",
				503,
			);
		}
		if (resolution.kind !== "resolved" || !isTenantTrafficEligible(resolution.context)) {
			throw new BillingError("Invalid billing API key", "UNAUTHORIZED", 401);
		}
		return { project: resolution.context, credentialAccess: resolution.access };
	})();
}

function resolveGatewayProject(
	request: Request,
	resolver: ProjectInstanceContextResolver,
): Promise<{ project: ProjectInstanceContext }> {
	return (async () => {
		const projectKey = request.headers.get("x-billing-project-key")?.trim();
		if (projectKey === undefined || projectKey === "") {
			throw new BillingError(
				"Billing project context is required",
				"BILLING_PROJECT_REQUIRED",
				401,
			);
		}
		const resolution = await resolver.resolveInstanceKey(projectKey);
		if (resolution.kind === "unavailable") {
			throw new BillingError(
				"Billing project context is unavailable",
				"BILLING_PROJECT_CONTEXT_UNAVAILABLE",
				503,
			);
		}
		if (resolution.kind !== "resolved" || !isTenantTrafficEligible(resolution.context)) {
			throw new BillingError(
				"Billing project is not configured",
				"BILLING_PROJECT_NOT_CONFIGURED",
				404,
			);
		}
		return { project: resolution.context };
	})();
}

function parseBearerToken(authorization: string | null): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
	return match?.[1] ?? null;
}

function oversizedContentLength(contentLength: string | null): boolean {
	if (contentLength === null) {
		return false;
	}
	const parsedContentLength = Number.parseInt(contentLength, 10);
	return (
		String(parsedContentLength) === contentLength && parsedContentLength > DEFAULT_BODY_LIMIT_BYTES
	);
}

function billingJsonResponse(
	status: number,
	body: ErrorEnvelopeBody,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

function requestIdFromHeader(value: string | null): string | null {
	const requestId = value?.trim();
	return requestId === undefined || requestId === "" ? null : requestId;
}

function routeGroupForPath(path: string): string {
	if (path === "/health" || path === "/livez" || path === "/ready" || path === "/metrics") {
		return "health";
	}
	if (path.includes("/webhooks/")) {
		return "webhook";
	}
	if (path.startsWith("/v1/admin/")) {
		return "admin";
	}
	if (path.includes("/usage/") || path.includes("/balances/")) {
		return "metering";
	}
	if (path.startsWith("/v1/billing-accounts/")) {
		return "customer";
	}
	if (path.startsWith("/v1/purchases/")) {
		return "purchase";
	}
	return "unknown";
}
