import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AdminBillingReader } from "./admin/types";
import { registerAdminRoutes } from "./app/admin-routes";
import { registerCatalogRoutes } from "./app/catalog-routes";
import { registerControlsRoutes } from "./app/controls-routes";
import { registerCustomerRoutes } from "./app/customer-routes";
import { registerInsightsRoutes } from "./app/insights-routes";
import { registerMeteringRoutes } from "./app/metering-routes";
import { createProjectProviderServiceResolver } from "./app/provider-services";
import type { BillingHonoEnv, AppDependencies as CreateAppDependencies } from "./app/types";
import { registerWebhookRoutes } from "./app/webhook-routes";
import { EntitlementService } from "./billing/entitlements";
import { BillingError, classifyBillingError, isBillingError } from "./billing/errors";
import { MeteringService } from "./billing/metering";
import { PostgresProjectInstanceContextResolver } from "./composition/project-instance-persistence";
import { AdminBillingRepository } from "./db/admin-repository";
import { checkPostgresHealth } from "./db/client";
import { BillingRepository } from "./db/repository";
import { requireApiKey } from "./http/api-key";
import {
	createFixedWindowRateLimiter,
	rateLimitMiddleware,
	requestIp,
	requestProjectIpAndPath,
} from "./http/rate-limit";
import { createNoopBillingLogger, safelyLogError } from "./observability/logger";
import {
	createInMemoryBillingMetrics,
	safelyIncrementBillingMetric,
} from "./observability/metrics";
import { isTenantTrafficEligible, type ProjectInstanceContextResolver } from "./projects/context";

const privateApiMaxBodyBytes = 256 * 1024;

const forbiddenProjectSelectorKeys = new Set(["projectId", "project_id"]);

export type { AppDependencies } from "./app/types";

const rejectCallerProjectSelectors: MiddlewareHandler = async (c, next) => {
	const url = new URL(c.req.url);
	if (queryHasCallerProjectSelector(url.searchParams)) {
		return projectSelectorRejectedResponse(c);
	}

	await next();
};

export function createApp({
	env,
	entitlementService,
	meteringService,
	controlsEnterpriseService,
	catalogControlPlane,
	billingInsightsService,
	appleStoreKitService,
	googlePlayBillingService,
	stripeBillingService,
	projectProviderServices,
	adminBillingReader,
	adminOperations,
	logger,
	metrics,
	readinessCheck,
	requestObservabilityMiddleware,
	projectContextResolver,
}: CreateAppDependencies): Hono<BillingHonoEnv> {
	const app = new Hono<BillingHonoEnv>();
	const billingLogger = logger ?? createNoopBillingLogger();
	const billingMetrics = metrics ?? createInMemoryBillingMetrics();
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
	const providerServices = createProjectProviderServiceResolver({
		env,
		getRepository,
		projectProviderServices,
		legacyServices: {
			appleStoreKitService,
			googlePlayBillingService,
			stripeBillingService,
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
	const webhookLimiter = createFixedWindowRateLimiter({
		windowMs: env.rateLimit.windowMs,
		limit: env.rateLimit.webhookLimit,
	});
	const verifyLimiter = createFixedWindowRateLimiter({
		windowMs: env.rateLimit.windowMs,
		limit: env.rateLimit.verifyLimit,
	});
	const adminLimiter = createFixedWindowRateLimiter({
		windowMs: env.rateLimit.windowMs,
		limit: env.rateLimit.adminLimit,
	});
	const meteringLimiter = createFixedWindowRateLimiter({
		windowMs: env.rateLimit.windowMs,
		limit: env.rateLimit.meteringLimit,
	});
	const projectResolutionLimiter = createFixedWindowRateLimiter({
		windowMs: env.rateLimit.windowMs,
		// This aggregate guard is intentionally looser than any individual downstream policy.
		limit: Math.min(
			Number.MAX_SAFE_INTEGER,
			env.rateLimit.verifyLimit + env.rateLimit.adminLimit + env.rateLimit.meteringLimit,
		),
	});
	const rateLimitKeyOptions = {
		trustProxyHeaders: env.rateLimit.trustProxyHeaders,
		knownProjectKeys: new Set(
			env.projectRuntime.map(({ projectInstanceKey }) => projectInstanceKey),
		),
	};
	const rateLimitKey = (c: Context): string => requestProjectIpAndPath(c, rateLimitKeyOptions);
	app.onError((error, c) => {
		const classified = classifyBillingError(error);
		const requestId = c.get("requestId");
		const routeGroup = routeGroupForPath(new URL(c.req.url).pathname);
		if (classified.status >= 500) {
			safelyIncrementBillingMetric(billingMetrics, "billing_http_errors_total", {
				route_group: routeGroup,
				status: String(classified.status),
				code: classified.code,
				classification: classified.classification,
			});
			safelyLogError(billingLogger, "Billing request failed", error, {
				requestId,
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				routeGroup,
				status: String(classified.status),
				code: classified.code,
				classification: classified.classification,
			});
		}
		c.header("x-request-id", requestId);
		return c.json(
			{
				success: false,
				error: { code: classified.code, message: classified.message },
			},
			classified.status as ContentfulStatusCode,
		);
	});

	app.use("*", async (c, next) => {
		const requestId = requestIdFromHeader(c.req.header("x-request-id")) ?? crypto.randomUUID();
		c.set("requestId", requestId);
		c.header("x-request-id", requestId);
		await next();
	});

	if (requestObservabilityMiddleware !== undefined) {
		app.use("*", requestObservabilityMiddleware);
	}

	app.get("/health", (c) => c.json({ status: "ok" }));
	app.get("/livez", (c) => c.json({ status: "ok" }));
	app.get("/ready", async (c) => {
		if (await checkReady()) {
			return c.json({ status: "ok" });
		}

		return c.json({ status: "unavailable" }, 503);
	});
	app.get("/metrics", (c) => {
		c.header("content-type", "text/plain; version=0.0.4");
		return c.body(billingMetrics.renderPrometheus());
	});

	registerWebhookRoutes({
		app,
		contextResolver,
		webhookLimiter,
		rateLimitKey,
		providerServices,
		billingMetrics,
		billingLogger,
		parseJson,
		readRequestText,
	});

	// Provider webhooks terminate in the routes registered above and retain their own
	// pre-resolution limiter. This guard bounds database-backed resolution for the ordinary API.
	app.use(
		"/v1/*",
		rateLimitMiddleware({
			limiter: projectResolutionLimiter,
			key: (c) => requestIp(c, rateLimitKeyOptions),
			headers: "rejected_only",
		}),
	);

	if (env.authMode === "api_key") {
		app.use("/v1/*", requireApiKey(contextResolver));
	} else {
		app.use("/v1/*", requireGatewayProjectContext(contextResolver));
	}

	app.use("/v1/*", rejectCallerProjectSelectors);

	registerCustomerRoutes({
		app,
		verifyLimiter,
		rateLimitKey,
		entitlementService: service,
		providerServices,
		billingMetrics,
		billingLogger,
		parsePrivateJson,
	});
	registerInsightsRoutes({
		app,
		service: billingInsightsService ?? {
			listUsageEvents: (...args) => getRepository().listUsageEvents(...args),
			getUsageSeries: (...args) => getRepository().getUsageSeries(...args),
			getCustomerBillingSummary: (...args) => getRepository().getCustomerBillingSummary(...args),
		},
	});
	registerMeteringRoutes({
		app,
		meteringLimiter,
		rateLimitKey,
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
		parsePrivateJson,
	});
	registerControlsRoutes({
		app,
		operatorApiKey: env.operatorApiKey,
		service: controlsService,
		parsePrivateJson,
	});
	registerAdminRoutes({
		app,
		adminLimiter,
		rateLimitKey,
		operatorApiKey: env.operatorApiKey,
		billingMetrics,
		billingLogger,
		getAdminBillingReader,
		adminOperations: adminOperations ?? null,
	});
	registerCatalogRoutes({
		app,
		operatorApiKey: env.operatorApiKey,
		catalogControlPlane: catalogService,
		parsePrivateJson,
	});

	app.notFound((c) =>
		c.json(
			{
				success: false,
				error: { code: "NOT_FOUND", message: "Route not found" },
			},
			404,
		),
	);

	return app;
}

function requireGatewayProjectContext(
	resolver: ProjectInstanceContextResolver,
): MiddlewareHandler<BillingHonoEnv> {
	return async (c, next) => {
		const projectKey = c.req.header("x-billing-project-key")?.trim();
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

		c.set("project", resolution.context);
		await next();
	};
}

function requestIdFromHeader(value: string | undefined): string | null {
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

function queryHasCallerProjectSelector(params: URLSearchParams): boolean {
	for (const key of forbiddenProjectSelectorKeys) {
		if (params.has(key)) {
			return true;
		}
	}

	return false;
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

function projectSelectorRejectedError(): BillingError {
	return new BillingError("Project is resolved from billing credentials", "INVALID_REQUEST", 400);
}

function projectSelectorRejectedResponse(c: Parameters<MiddlewareHandler>[0]) {
	return c.json(
		{
			success: false,
			error: {
				code: "INVALID_REQUEST",
				message: "Project is resolved from billing credentials",
			},
		},
		400,
	);
}

async function parseJson(request: Request, maxBytes?: number): Promise<unknown> {
	try {
		const text = await readRequestText(request, maxBytes);
		return JSON.parse(text);
	} catch (error) {
		if (isBillingError(error)) {
			throw error;
		}

		return null;
	}
}

async function parsePrivateJson(request: Request): Promise<unknown> {
	const body = await parseJson(request, privateApiMaxBodyBytes);
	if (hasCallerProjectSelector(body)) {
		throw projectSelectorRejectedError();
	}
	return body;
}

async function readRequestText(request: Request, maxBytes?: number): Promise<string> {
	if (maxBytes !== undefined) {
		const contentLength = request.headers.get("content-length");
		if (contentLength !== null) {
			const parsedContentLength = Number.parseInt(contentLength, 10);
			if (String(parsedContentLength) === contentLength && parsedContentLength > maxBytes) {
				throw new BillingError("Request body is too large", "REQUEST_BODY_TOO_LARGE", 413);
			}
		}
	}

	if (request.body === null) {
		return "";
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		totalBytes += value.byteLength;
		if (maxBytes !== undefined && totalBytes > maxBytes) {
			await reader.cancel();
			throw new BillingError("Request body is too large", "REQUEST_BODY_TOO_LARGE", 413);
		}

		chunks.push(value);
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return new TextDecoder().decode(body);
}
