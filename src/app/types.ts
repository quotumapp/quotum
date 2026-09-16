import type { AdminBillingReader } from "../admin/types";
import type {
	CommercialActionExecutionResult,
	CommercialActionIntent,
	CommercialActionPreview,
} from "../billing/commercial";
import type { ControlsEnterpriseRepositoryLike } from "../billing/controls";
import type { EntitlementService } from "../billing/entitlements";
import type {
	CustomerBillingSummary,
	ProjectUsageEventListInput,
	ProjectUsageEventPage,
	UsageEventListInput,
	UsageEventPage,
	UsageSeriesInput,
	UsageSeriesPoint,
} from "../billing/insights";
import type { MeteringServiceLike } from "../billing/metering";
import type { PromotionServiceLike } from "../billing/promotions";
import type { CatalogControlPlaneLike } from "../catalog/types";
import type { BillingEnv } from "../env";
import type { BillingLogger } from "../observability/logger";
import type { BillingMetrics } from "../observability/metrics";
import type { BillingAdminOperations } from "../operations/admin";
import type { RuntimeConnectionResolver } from "../projects/connections";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";
import type {
	ProjectProviderServiceOverrides,
	ProjectProviderServices,
} from "../projects/providers";
import type { StripeCheckoutSessionStatus } from "../providers/stripe/service";
import type { StripeCatalog } from "../providers/stripe/types";
import type { AppElysia, ElysiaPluginLike } from "../shared/http";

/** The staff /v1 application instance; per-route schemas keep handler typing local. */
export type BillingElysia = AppElysia;

/** Structural subset of Bun's server used for client IP resolution in rate limiting. */
export type GuardServer = { requestIP(request: Request): { address: string } | null } | null;

export interface PreAuthGateInput {
	request: Request;
	/** The path the router matched; see `routedPath`. */
	path: string;
	server: GuardServer;
	set: { headers: Record<string, unknown> };
}

/**
 * Gate executed from the shell's `onRequest` hook, before authentication and request validation.
 * Returns a Response to reject the request, or undefined to continue. `matches` receives the
 * routed path, never a path re-parsed from `request.url`.
 */
export interface PreAuthGate {
	matches(path: string): boolean;
	gate(input: PreAuthGateInput): Response | undefined;
}

export interface PostAuthGuardInput {
	request: Request;
	/** The path the router matched; see `routedPath`. */
	path: string;
	server: GuardServer;
	projectKey: string;
	set: { headers: Record<string, string> };
}

/**
 * Guard executed inside the authentication derive, after project resolution but before request
 * validation, the position the operator-key and path-group limiters have always held. `matches`
 * receives the routed path so a guard can never disagree with the handler that will run.
 */
export interface PostAuthGuard {
	matches(path: string): boolean;
	guard(input: PostAuthGuardInput): void | Promise<void>;
}

/**
 * Observes authenticated requests on a path group, e.g. to time them. It starts inside the
 * authentication derive, before the path-group limiters, and finishes exactly once: "failed" when
 * the request ends in an error response (validation, rate limiting or a handler error).
 */
export interface RequestObserver {
	matches(path: string): boolean;
	finish(input: { path: string; durationMs: number; result: "completed" | "failed" }): void;
}

export interface AppleStoreKitServiceLike {
	getOrCreateAppAccountToken(billingAccountId: string): Promise<string>;
	verifyPurchase(input: { billingAccountId: string; transactionId: string }): Promise<unknown>;
	handleNotification(input: {
		signedPayload: string;
	}): Promise<{ status: "processed" | "skipped" | "ignored"; entitlements: unknown }>;
}

export interface GooglePlayBillingServiceLike {
	getAccountLink(billingAccountId: string): Promise<{ obfuscatedAccountId: string }>;
	verifyPurchase(input: {
		billingAccountId: string;
		purchaseKind: "subscription" | "consumable" | "non_consumable";
		purchaseToken: string;
		productId?: string;
	}): Promise<unknown>;
	handleRtdn(input: { authorizationHeader: string | null; body: unknown }): Promise<unknown>;
	verifyRtdnAuthorization?(authorizationHeader: string | null): Promise<void>;
}

export interface StripeBillingServiceLike {
	expireCheckoutSession?(input: {
		billingAccountId: string;
		sessionId: string;
	}): Promise<StripeCheckoutSessionStatus>;
	getCatalog?(): Promise<StripeCatalog>;
	getBillingAccount?(billingAccountId: string): Promise<{
		schemaVersion: 1;
		customerExists: boolean;
		subscriptions: unknown[];
		recentInvoices: unknown[];
	}>;
	createCheckoutSession(input: {
		billingAccountId: string;
		productKey: string;
		email?: string | null;
		idempotencyKey?: string | null;
		successUrl?: string | null;
		cancelUrl?: string | null;
		expiresAt?: number;
	}): Promise<{
		sessionId: string;
		url: string;
		duplicate?: boolean;
	}>;
	createRecurringCheckoutSession?(input: {
		billingAccountId: string;
		planKey: string;
		quantities?: Record<string, number>;
		email?: string | null;
		idempotencyKey?: string | null;
		successUrl?: string | null;
		cancelUrl?: string | null;
		expiresAt?: number;
	}): Promise<{ sessionId: string; url: string; duplicate?: boolean }>;
	requestSubscriptionChange?(input: {
		billingAccountId: string;
		externalSubscriptionId: string;
		targetPlanKey: string;
		quantities: Record<string, number>;
		effectiveMode?: "immediate" | "period_end";
		prorationBehavior?: "always_invoice" | "create_prorations" | "none";
		idempotencyKey: string;
	}): Promise<unknown>;
	previewCommercialAction?(input: {
		billingAccountId: string;
		intent: CommercialActionIntent;
	}): Promise<CommercialActionPreview>;
	executeCommercialAction?(input: {
		billingAccountId: string;
		previewToken: string;
		idempotencyKey: string;
	}): Promise<CommercialActionExecutionResult>;
	createPortalSession(input: {
		billingAccountId: string;
		returnUrl?: string | null;
	}): Promise<{ url: string }>;
	getCheckoutSessionStatus(input: { billingAccountId: string; sessionId: string }): Promise<{
		sessionId: string;
		status: string | null;
		paymentStatus: string | null;
		customerEmail: string | null;
		productKey: string | null;
	}>;
	handleWebhook(input: { rawBody: string; signatureHeader: string | null }): Promise<unknown>;
}

export interface BillingInsightsServiceLike {
	listUsageEvents(
		project: ProjectInstanceContext,
		input: UsageEventListInput,
	): Promise<UsageEventPage>;
	listProjectUsageEvents(
		project: ProjectInstanceContext,
		input: ProjectUsageEventListInput,
	): Promise<ProjectUsageEventPage>;
	getUsageSeries(
		project: ProjectInstanceContext,
		input: UsageSeriesInput,
	): Promise<UsageSeriesPoint[]>;
	getCustomerBillingSummary(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<CustomerBillingSummary>;
}

export interface AppDependencies {
	connections?: RuntimeConnectionResolver;
	env: BillingEnv;
	/** Internal in-process adapters may supply already-authorized project context. */
	projectAuthentication?: ElysiaPluginLike;
	entitlementService?: EntitlementService;
	meteringService?: MeteringServiceLike;
	controlsEnterpriseService?: ControlsEnterpriseRepositoryLike;
	promotionService?: PromotionServiceLike;
	catalogControlPlane?: CatalogControlPlaneLike;
	billingInsightsService?: BillingInsightsServiceLike;
	appleStoreKitService?: AppleStoreKitServiceLike | null;
	googlePlayBillingService?: GooglePlayBillingServiceLike | null;
	stripeBillingService?: StripeBillingServiceLike | null;
	projectProviderServices?: ProjectProviderServiceOverrides<
		AppleStoreKitServiceLike,
		GooglePlayBillingServiceLike,
		StripeBillingServiceLike
	>;
	adminBillingReader?: AdminBillingReader | null;
	adminOperations?: BillingAdminOperations | null;
	logger?: BillingLogger;
	metrics?: BillingMetrics;
	readinessCheck?: () => boolean | Promise<boolean>;
	requestObservabilityMiddleware?: ElysiaPluginLike;
	projectContextResolver?: ProjectInstanceContextResolver;
}

export interface ProjectProviderServiceResolver {
	appleStoreKitService(
		project: ProjectInstanceContext,
		purpose?: "new" | "recovery",
	): Promise<AppleStoreKitServiceLike | null>;
	googlePlayBillingService(
		project: ProjectInstanceContext,
		purpose?: "new" | "recovery",
	): Promise<GooglePlayBillingServiceLike | null>;
	stripeBillingService(
		project: ProjectInstanceContext,
		purpose?: "new" | "recovery",
	): Promise<StripeBillingServiceLike | null>;
}

export type ProjectProviderServiceSet = ProjectProviderServices<
	AppleStoreKitServiceLike,
	GooglePlayBillingServiceLike,
	StripeBillingServiceLike
>;
