import { Elysia } from "elysia";
import type { AdminBillingReader } from "./admin/types";
import { registerAdminRoutes } from "./app/admin-routes";
import { registerBalanceAdjustmentRoutes } from "./app/balance-adjustment-routes";
import { registerCapabilityRoutes } from "./app/capability-routes";
import { registerCatalogRoutes } from "./app/catalog-routes";
import { registerControlsRoutes } from "./app/controls-routes";
import { createCredentialAccessGate } from "./app/credential-access";
import { registerCustomerRoutes } from "./app/customer-routes";
import { registerInsightsRoutes } from "./app/insights-routes";
import { registerMeteringRoutes } from "./app/metering-routes";
import { registerPromotionRoutes } from "./app/promotion-routes";
import { registerProviderOperationRoutes } from "./app/provider-operation-routes";
import {
	projectProviderServiceResolver,
	requireApplePromotionSigner,
} from "./app/provider-services";
import {
	projectSelectorRejectedError,
	queryHasCallerProjectSelector,
	urlHasEncodedNul,
} from "./app/request-context";
import { registerTrialRoutes } from "./app/trial-routes";
import type {
	AppDependencies as CreateAppDependencies,
	PostAuthGuard,
	PreAuthGate,
	PreAuthGateInput,
	RequestObserver,
} from "./app/types";
import { registerUsageReceiptRoutes } from "./app/usage-receipt-routes";
import { registerWebhookRoutes } from "./app/webhook-routes";
import { EntitlementService } from "./billing/entitlements";
import {
	BillingError,
	classifyBillingError,
	InvalidRequestError,
	isBillingError,
} from "./billing/errors";
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
	rateLimitedBody,
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
import { routeMethodIndex } from "./shared/route-methods";

export type { AppDependencies } from "./app/types";

const WEBHOOK_PATH_PATTERN = /^\/v1\/projects\/[^/]+\/webhooks\/(apple|google|stripe|paddle)$/;

/** Webhook requests one client IP may send per window, as a multiple of the per-project limit. */
const WEBHOOK_CLIENT_LIMIT_MULTIPLIER = 10;

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
	usageApiService,
	controlsEnterpriseService,
	promotionService,
	trialService,
	balanceAdjustmentService,
	catalogControlPlane,
	billingInsightsService,
	appleStoreKitService,
	googlePlayBillingService,
	stripeBillingService,
	projectProviderServices,
	providerRegistry: sharedProviderRegistry,
	providerCapabilityReads,
	commercialPreviewReader,
	providerOperationStore,
	providerOperationReconciler,
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
		if (guard.stage === "authorize") {
			postAuthGuards.push(guard);
			return;
		}
		// Limiters go ahead of every credential check registered so far.
		const firstAuthorizer = postAuthGuards.findIndex((existing) => existing.stage === "authorize");
		postAuthGuards.splice(
			firstAuthorizer === -1 ? postAuthGuards.length : firstAuthorizer,
			0,
			guard,
		);
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
	const routeMethods = routeMethodIndex(() => app.routes);

	if (requestObservabilityMiddleware !== undefined) {
		app.use(requestObservabilityMiddleware);
	}

	app.onRequest((context) => {
		const { request, set, server } = context;
		const requestId =
			requestIdFromHeader(request.headers.get("x-request-id")) ?? crypto.randomUUID();
		requestIds.set(request, requestId);
		set.headers["x-request-id"] = requestId;
		// Billing state is per caller and changes with every write: no shared or browser cache may
		// keep a response, and JSON must never be sniffed as another type.
		set.headers["cache-control"] = "no-store";
		set.headers["x-content-type-options"] = "nosniff";

		const path = routedPath(context);
		// Without a usable Host, Bun hands over a relative URL that `new URL()` cannot parse, and
		// every later step would fail on it. Health checks stay open: some probes send no Host.
		if (path.startsWith("/v1/") && !URL.canParse(request.url)) {
			return billingJsonResponse(request, 400, {
				success: false,
				error: { code: "INVALID_REQUEST", message: "Request must carry a valid Host header" },
			});
		}
		// Bodies are read as the bytes sent; a compressed body would only fail validation later.
		if (
			path.startsWith("/v1/") &&
			request.method !== "GET" &&
			request.method !== "HEAD" &&
			encodedBody(request.headers.get("content-encoding"))
		) {
			return billingJsonResponse(request, 415, {
				success: false,
				error: {
					code: "UNSUPPORTED_CONTENT_ENCODING",
					message: "Send the request body without a Content-Encoding",
				},
			});
		}
		if (
			path.startsWith("/v1/") &&
			request.method !== "GET" &&
			request.method !== "HEAD" &&
			oversizedContentLength(request.headers.get("content-length"))
		) {
			return billingJsonResponse(request, 413, {
				success: false,
				error: { code: "REQUEST_BODY_TOO_LARGE", message: "Request body is too large" },
			});
		}
		// A path segment or query value decoding to NUL would reach SQL, which cannot store it.
		if (path.startsWith("/v1/") && urlHasEncodedNul(request.url)) {
			return billingJsonResponse(request, 400, {
				success: false,
				error: { code: "INVALID_REQUEST", message: "Request URL must not contain NUL characters" },
			});
		}

		const rateLimitServer = (server ?? null) as RateLimitServer | null;
		for (const gate of preAuthGates) {
			if (!gate.matches(path)) {
				continue;
			}
			const rejection = gate.gate({ request, path, server: rateLimitServer, set });
			if (rejection !== undefined) {
				return gateRejection(request, rejection);
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
				request,
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
				request,
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
			return billingJsonResponse(request, 429, rateLimitedBody(error.result), headers);
		}

		if (code === "NOT_FOUND" && !isBillingError(error)) {
			const allowed = routeMethods.allowed(
				URL.parse(request.url, "http://unknown.invalid")?.pathname ?? "/",
			);
			if (allowed.length > 0) {
				return billingJsonResponse(
					request,
					405,
					{
						success: false,
						error: {
							code: "METHOD_NOT_ALLOWED",
							message: `This route accepts ${allowed.join(", ")}`,
						},
					},
					{ ...headers, allow: allowed.join(", ") },
				);
			}
			return billingJsonResponse(
				request,
				404,
				{ success: false, error: { code: "NOT_FOUND", message: "Route not found" } },
				headers,
			);
		}

		const classified = classifyBillingError(error);
		// The error handler must never throw itself, whatever URL the request carried.
		const pathname = URL.parse(request.url, "http://unknown.invalid")?.pathname ?? "/";
		const routeGroup = routeGroupForPath(pathname);
		if (
			classified.code === "METERING_CONFIGURATION_ERROR" &&
			classified.details?.reason === "mixed_scope"
		) {
			// A declared-scope mix reached metering despite the publication and purchase guards: the
			// operator has to migrate or cancel one of the account's subscriptions.
			safelyIncrementBillingMetric(billingMetrics, "billing_metering_mixed_scope_total", {
				route_group: routeGroup,
			});
			safelyLogError(billingLogger, "Meter limits mix declared scopes", error, {
				requestId,
				method: request.method,
				path: pathname,
				routeGroup,
				featureKey: String(classified.details.featureKey ?? ""),
				sources: JSON.stringify(classified.details.sources ?? []),
			});
		}
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
				path: pathname,
				routeGroup,
				status: String(classified.status),
				code: classified.code,
				classification: classified.classification,
			});
		}
		if (classified.status === 401) {
			// RFC 9110 requires a challenge on 401; project credentials are bearer tokens.
			headers["www-authenticate"] = 'Bearer realm="quotum"';
		}
		return billingJsonResponse(
			request,
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
		webhookIpLimiter: createWebhookIpLimiter(),
		providerServices,
		billingMetrics,
		billingLogger,
	});

	registerPreAuthGate(
		aggregateV1RateLimitGate(createAggregateLimiter(), env.rateLimit.trustProxyHeaders),
	);

	const credentialAccessGate = createCredentialAccessGate(() => app.routes);

	app.derive(async ({ request, path, route, server, set }) => {
		// Gateway mode reads no credential: the trusted gateway states the access it granted, or
		// nothing, which means full.
		const { project, credentialAccess } =
			env.authMode === "api_key"
				? await resolveProjectFromApiKey(request, contextResolver)
				: await resolveGatewayProject(request, contextResolver);
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
				source: env.authMode === "api_key" ? "credential" : "gateway",
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
		// Path-group limiters, then operator-key guards, run here: after authentication, before request
		// validation. They match the routed path so they always describe the handler that will run.
		const rateLimitServer = (server ?? null) as RateLimitServer | null;
		for (const guard of postAuthGuards) {
			if (!guard.matches(path)) {
				continue;
			}
			await guard.guard({
				request,
				path,
				route,
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
		commercialPreviewReader: commercialPreviewReader ?? {
			getCommercialActionPreview: (...args) => getRepository().getCommercialActionPreview(...args),
		},
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
	registerProviderOperationRoutes({
		app,
		reconcile: providerOperationReconciler,
		store: providerOperationStore ?? {
			get: (...args) => getRepository().providerOperations.get(...args),
		},
	});
	const usageApi = usageApiService ?? getRepository().usageApi;
	registerUsageReceiptRoutes(app, usageApi);
	registerMeteringRoutes({
		app,
		meteringLimiter: createMeteringLimiter(),
		usageApi,
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
		apple: {
			repository: () => getRepository().applePromotions,
			signer: async (project) =>
				requireApplePromotionSigner(await providerServices.appleStoreKitService(project)),
		},
		operatorApiKey: env.operatorApiKey,
		service: promotionService ?? getRepository().promotions,
		validationLimiter: createVerifyLimiter(),
		rateLimitKeyOptions,
		registerPostAuthGuard,
	});
	registerTrialRoutes({ app, service: trialService ?? getRepository().planGrants });
	registerBalanceAdjustmentRoutes({
		app,
		operatorApiKey: env.operatorApiKey,
		service: balanceAdjustmentService ?? getRepository().balanceAdjustments,
		registerPostAuthGuard,
	});

	return app;

	function createWebhookLimiter() {
		return createFixedWindowRateLimiter({
			windowMs: env.rateLimit.windowMs,
			limit: env.rateLimit.webhookLimit,
		});
	}
	function createWebhookIpLimiter() {
		return createFixedWindowRateLimiter({
			windowMs: env.rateLimit.windowMs,
			// One provider address delivers for every project, so this per-client ceiling is looser
			// than any one project's webhook budget.
			limit: Math.min(
				Number.MAX_SAFE_INTEGER,
				env.rateLimit.webhookLimit * WEBHOOK_CLIENT_LIMIT_MULTIPLIER,
			),
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

/**
 * What the trusted gateway granted the caller. Read only in gateway mode, under the same trust as
 * `x-billing-project-key`: the gateway must strip any copy a client sends. An unknown value is
 * refused, never read as full.
 */
function gatewayCredentialAccess(request: Request): CredentialAccess {
	const header = request.headers.get("x-billing-credential-access");
	if (header === null) return "full";
	const value = header.trim();
	if (value === "full" || value === "read_only") return value;
	throw new InvalidRequestError("X-Billing-Credential-Access must be full or read_only");
}

function resolveGatewayProject(
	request: Request,
	resolver: ProjectInstanceContextResolver,
): Promise<{ project: ProjectInstanceContext; credentialAccess: CredentialAccess }> {
	return (async () => {
		// Before the lookup, so a malformed header costs no database call.
		const credentialAccess = gatewayCredentialAccess(request);
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
		return { project: resolution.context, credentialAccess };
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

/** A request body sent with any coding other than `identity`. */
function encodedBody(contentEncoding: string | null): boolean {
	if (contentEncoding === null) return false;
	return contentEncoding
		.split(",")
		.map((coding) => coding.trim().toLowerCase())
		.some((coding) => coding !== "" && coding !== "identity");
}

/** The error envelope, carrying the request's ID so a caller can quote it from the body alone. */
function billingJsonResponse(
	request: Request,
	status: number,
	body: ErrorEnvelopeBody,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(withRequestId(request, body)), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

function withRequestId(request: Request, body: ErrorEnvelopeBody): ErrorEnvelopeBody {
	const requestId = requestIds.get(request);
	return requestId === undefined ? body : { ...body, error: { ...body.error, requestId } };
}

/**
 * A pre-authentication gate builds its refusal without the request's ID; add it to the error
 * envelope. Anything that is not the envelope passes through unchanged.
 */
async function gateRejection(request: Request, rejection: Response): Promise<Response> {
	const body: unknown = await rejection
		.clone()
		.json()
		.catch(() => null);
	if (!isErrorEnvelope(body)) return rejection;
	return new Response(JSON.stringify(withRequestId(request, body)), {
		status: rejection.status,
		headers: rejection.headers,
	});
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelopeBody {
	if (typeof value !== "object" || value === null) return false;
	const { success, error } = value as { success?: unknown; error?: unknown };
	return success === false && typeof error === "object" && error !== null;
}

/**
 * A caller's request ID is kept only when it is a short token that is safe to echo and log; any
 * other value is replaced with a generated one and never repeated back or written to a log.
 */
const CALLER_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdFromHeader(value: string | null): string | null {
	const requestId = value?.trim();
	return requestId !== undefined && CALLER_REQUEST_ID.test(requestId) ? requestId : null;
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
