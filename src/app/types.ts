import type { Context, MiddlewareHandler } from "hono";
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
	UsageEventListInput,
	UsageEventPage,
	UsageSeriesInput,
	UsageSeriesPoint,
} from "../billing/insights";
import type { MeteringServiceLike } from "../billing/metering";
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

export type BillingHonoEnv = { Variables: { project: ProjectInstanceContext; requestId: string } };
export type BillingContext = Context<BillingHonoEnv>;

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
	projectAuthentication?: MiddlewareHandler<BillingHonoEnv>;
	entitlementService?: EntitlementService;
	meteringService?: MeteringServiceLike;
	controlsEnterpriseService?: ControlsEnterpriseRepositoryLike;
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
	requestObservabilityMiddleware?: MiddlewareHandler<BillingHonoEnv>;
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
