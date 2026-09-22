import type {
	AppleStoreKitServiceLike,
	GooglePlayBillingServiceLike,
	StripeBillingServiceLike,
} from "../app/types";
import type { AutoTopupChargeResult, AutoTopupJob } from "../billing/auto-topup";
import type { PromotionStripeSyncJob, PromotionStripeSyncOutcome } from "../billing/promotions";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../billing/recurring";
import type { ProjectScopedBillingRepository } from "../db/repository";
import type { RuntimeConnectionConfigs } from "../projects/connections";
import type { ProjectInstanceContext } from "../projects/context";
import {
	type BillingProvider,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	providerOperations,
} from "../shared/provider-capabilities";
import type { AutoTopupWorkerProvider } from "../workers/auto-topup";
import type { PromotionStripeProvider } from "../workers/promotion-maintenance";
import type { RecurringBillingWorkerProvider } from "../workers/recurring-billing";
import type { StoreEventReplayProvider } from "../workers/store-event-replay";
import type { SubscriptionReconciliationProvider } from "../workers/subscription-reconciliation";
import type { AppleStoreKitConfig } from "./apple/client";
import type { AppleStoreKitServiceDependencies } from "./apple/service";
import type { GooglePlayConfig } from "./google/config";
import type { GooglePlayBillingServiceDependencies } from "./google/service";
import type { StripeBillingConfig } from "./stripe/client";
import type { StripeBillingClientDependency } from "./stripe/service";

/**
 * When the customer pays for a write and when its entitlement changes are kept apart, so an
 * adapter can never report a change as paid and effective when only one of them happened.
 */
export interface OperationTiming {
	payment: {
		kind:
			| "collected"
			| "scheduled_next_renewal"
			| "not_required"
			| "pending_customer"
			| "uncertain";
		at?: string | null;
		externalRef?: string | null;
	};
	entitlement: {
		kind: "effective_now" | "effective_at" | "awaiting_provider_event" | "unchanged";
		at?: string | null;
	};
}

/**
 * A money-moving provider write. `uncertain` is for providers without client idempotency keys
 * whose response was lost after the write may have succeeded; the correlation lets reconciliation
 * find it. Stripe wrappers never return it.
 */
export type ProviderWriteResult<T> =
	| ({ outcome: "committed"; timing: OperationTiming } & T)
	| { outcome: "uncertain"; correlation: Record<string, string>; timing: OperationTiming };

/** The provider-specific service surfaces the request path already uses. */
export interface ProviderServiceTypes {
	apple: AppleStoreKitServiceLike;
	google: GooglePlayBillingServiceLike;
	stripe: StripeBillingServiceLike;
}

/** The worker ports each real provider service implements. */
export interface ProviderWorkerPorts {
	apple: StoreEventReplayProvider & SubscriptionReconciliationProvider;
	google: StoreEventReplayProvider & SubscriptionReconciliationProvider;
	stripe: StoreEventReplayProvider &
		SubscriptionReconciliationProvider &
		RecurringBillingWorkerProvider &
		AutoTopupWorkerProvider &
		PromotionStripeProvider;
}

/** A service built from a connection: the request surface plus every worker port. */
export type ProviderService<P extends BillingProvider> = ProviderServiceTypes[P] &
	ProviderWorkerPorts[P];

/** What a wrapper accepts: test overrides and legacy services may omit the worker ports. */
export type ProviderServiceSource<P extends BillingProvider> = ProviderServiceTypes[P] &
	Partial<ProviderWorkerPorts[P]>;

type StripeMethod<K extends keyof StripeBillingServiceLike> = NonNullable<
	StripeBillingServiceLike[K]
>;

export interface ProviderWebhookGroups {
	apple: { ingest: AppleStoreKitServiceLike["handleNotification"] };
	google: {
		ingest: GooglePlayBillingServiceLike["handleRtdn"];
		/** Authenticates the push before its body is read. */
		verifyAuthorization?: NonNullable<GooglePlayBillingServiceLike["verifyRtdnAuthorization"]>;
	};
	stripe: { ingest: StripeBillingServiceLike["handleWebhook"] };
}

export interface ProviderPurchaseGroups {
	apple: {
		verify: AppleStoreKitServiceLike["verifyPurchase"];
		accountLink: AppleStoreKitServiceLike["getOrCreateAppAccountToken"];
	};
	google: {
		verify: GooglePlayBillingServiceLike["verifyPurchase"];
		accountLink: GooglePlayBillingServiceLike["getAccountLink"];
	};
	stripe: never;
}

export interface ProviderCheckoutGroup {
	createHosted: StripeMethod<"createCheckoutSession">;
	createPlan?: StripeMethod<"createRecurringCheckoutSession">;
	status: StripeMethod<"getCheckoutSessionStatus">;
	expire?: StripeMethod<"expireCheckoutSession">;
}

export interface ProviderPortalGroup {
	createSession: StripeMethod<"createPortalSession">;
}

export interface ProviderCommercialGroup {
	preview?: StripeMethod<"previewCommercialAction">;
	execute?: StripeMethod<"executeCommercialAction">;
	requestChange?: StripeMethod<"requestSubscriptionChange">;
}

export interface ProviderChangeGroup {
	apply(
		operation: SubscriptionChangeOperation,
	): Promise<ProviderWriteResult<{ providerRequestId: string }>>;
}

export interface ProviderSettlementGroup {
	/** Collects a closed period's rated charge, or issues the adjustment for a corrected one. */
	collectFinalizedCharge(
		job: UsageInvoiceJob,
	): Promise<ProviderWriteResult<{ externalChargeId: string }>>;
}

export interface ProviderTopupGroup {
	chargeAutomatic(job: AutoTopupJob): Promise<AutoTopupChargeResult & { timing: OperationTiming }>;
}

export interface ProviderPromotionGroup {
	syncObject(job: PromotionStripeSyncJob): Promise<PromotionStripeSyncOutcome>;
}

export interface ProviderReadGroup {
	catalog?: StripeMethod<"getCatalog">;
	billingAccount?: StripeMethod<"getBillingAccount">;
}

/**
 * The shared seam over one provider connection. Optional groups exist only when the wrapped
 * service can serve them; `replay` and `reconciliation` come from the worker ports, which test
 * overrides may omit, so they are optional too. The registry requires every group the declaration
 * marks as implemented when it builds an adapter from a connection.
 */
export interface ProviderAdapter<P extends BillingProvider = BillingProvider> {
	readonly provider: P;
	readonly declaration: ProviderCapabilityDeclaration;
	/** The provider account behind this connection, when the connection records one. */
	readonly accountIdentity: string | null;
	readonly webhooks: ProviderWebhookGroups[P];
	readonly replay?: StoreEventReplayProvider;
	readonly reconciliation?: SubscriptionReconciliationProvider;
	readonly purchases?: ProviderPurchaseGroups[P];
	readonly checkout?: ProviderCheckoutGroup;
	readonly portal?: ProviderPortalGroup;
	readonly commercial?: ProviderCommercialGroup;
	readonly changes?: ProviderChangeGroup;
	readonly settlement?: ProviderSettlementGroup;
	readonly topups?: ProviderTopupGroup;
	readonly promotions?: ProviderPromotionGroup;
	readonly reads?: ProviderReadGroup;
}

export type AnyProviderAdapter = { [P in BillingProvider]: ProviderAdapter<P> }[BillingProvider];

export const providerAdapterGroups = [
	"webhooks",
	"replay",
	"reconciliation",
	"purchases",
	"checkout",
	"portal",
	"commercial",
	"changes",
	"settlement",
	"topups",
	"promotions",
	"reads",
] as const;
export type ProviderAdapterGroup = (typeof providerAdapterGroups)[number];
export type ProviderAdapterMethod = `${ProviderAdapterGroup}.${string}`;

/**
 * The adapter methods that can serve each operation; any one of them is enough. Catalog
 * constructs are accepted or rejected by the catalog and need no adapter method.
 */
export const providerOperationMethods: Record<ProviderOperation, readonly ProviderAdapterMethod[]> =
	{
		"catalog.product.subscription": [],
		"catalog.product.consumable": [],
		"catalog.product.non_consumable": [],
		"catalog.trial": [],
		"catalog.addon": [],
		"catalog.topup": [],
		"catalog.price.flat": [],
		"catalog.price.licensed": [],
		"catalog.price.tiered": [],
		"catalog.price.hybrid": [],
		"catalog.price.postpaid_usage": [],
		"checkout.hosted": ["checkout.createHosted"],
		"checkout.plan": ["checkout.createPlan"],
		"purchase.verify": ["purchases.verify"],
		"portal.session": ["portal.createSession"],
		"webhook.ingest": ["webhooks.ingest"],
		"event.replay": ["replay.replayStoreEvent"],
		"subscription.reconcile": ["reconciliation.reconcileSubscription"],
		"subscription.change.preview": ["commercial.preview"],
		"subscription.change.apply": ["changes.apply"],
		"subscription.change.period_end": ["changes.apply"],
		"subscription.cancel": ["commercial.execute"],
		"subscription.uncancel": ["commercial.execute"],
		"settlement.collect_finalized_charge": ["settlement.collectFinalizedCharge"],
		"adjustment.issue": ["settlement.collectFinalizedCharge"],
		"refund.sync": ["webhooks.ingest"],
		"topup.customer_initiated": ["checkout.createHosted", "purchases.verify"],
		"topup.automatic": ["topups.chargeAutomatic"],
		"promotion.code_entry": ["commercial.execute"],
		"promotion.hosted_code": ["promotions.syncObject"],
	};

/** Whether the adapter has a method that can serve `operation`. */
export function adapterServesOperation(
	adapter: AnyProviderAdapter,
	operation: ProviderOperation,
): boolean {
	const methods = providerOperationMethods[operation];
	return methods.length === 0 || methods.some((method) => hasAdapterMethod(adapter, method));
}

/** Operations the declaration marks as implemented that the adapter has no method for. */
export function missingAdapterOperations(adapter: AnyProviderAdapter): ProviderOperation[] {
	return providerOperations.filter((operation) => {
		const support = adapter.declaration.operations[operation];
		const implemented =
			(support.level === "native" || support.level === "quotum_composed") &&
			(support.verification.status === "verified" || support.verification.status === "conditional");
		return implemented && !adapterServesOperation(adapter, operation);
	});
}

function hasAdapterMethod(adapter: AnyProviderAdapter, method: ProviderAdapterMethod): boolean {
	const [groupName, methodName] = method.split(".");
	const group = (adapter as unknown as Record<string, unknown>)[groupName ?? ""];
	return (
		typeof group === "object" &&
		group !== null &&
		typeof (group as Record<string, unknown>)[methodName ?? ""] === "function"
	);
}

/** Keeps only the methods the wrapped service has; a group with none of them is undefined. */
export function adapterGroup<Group extends object>(
	methods: {
		[K in keyof Group]: Group[K] | undefined;
	},
): Group | undefined {
	const present = Object.entries(methods).filter(([, method]) => method !== undefined);
	return present.length === 0 ? undefined : (Object.fromEntries(present) as Group);
}

export interface ProviderOverrideKeys {
	apple: "appleStoreKitService";
	google: "googlePlayBillingService";
	stripe: "stripeBillingService";
}

export interface ProviderBuildInput<P extends BillingProvider> {
	project: ProjectInstanceContext;
	config: RuntimeConnectionConfigs[P];
	repository: ProjectScopedBillingRepository;
	clientFactories: ProviderClientFactories;
}

/** Builds provider clients from the config the default client would use; tests inject fakes. */
export interface ProviderClientFactories {
	apple?: (
		config: AppleStoreKitConfig,
		projectInstanceKey: string,
	) => AppleStoreKitServiceDependencies["client"];
	google?: (
		config: GooglePlayConfig,
		projectInstanceKey: string,
	) => GooglePlayBillingServiceDependencies["client"];
	stripe?: (
		config: StripeBillingConfig,
		projectInstanceKey: string,
	) => StripeBillingClientDependency;
}

/** How the registry builds, identifies and wraps one admitted provider. */
export interface ProviderRegistryEntry<P extends BillingProvider> {
	readonly provider: P;
	readonly declaration: ProviderCapabilityDeclaration;
	readonly connectionKind: P;
	/** The `projectProviderServices` and legacy service key that replaces a connection build. */
	readonly overrideKey: ProviderOverrideKeys[P];
	/** Names the provider in not-configured errors, e.g. "Stripe provider is not configured". */
	readonly label: string;
	/** The status the request path returns when the project has no service for this provider. */
	readonly notConfiguredStatus: number;
	accountIdentity(config: RuntimeConnectionConfigs[P]): string | null;
	build(input: ProviderBuildInput<P>): ProviderService<P>;
	wrap(service: ProviderServiceSource<P>, accountIdentity: string | null): ProviderAdapter<P>;
}

export type AnyProviderRegistryEntry = {
	[P in BillingProvider]: ProviderRegistryEntry<P>;
}[BillingProvider];
