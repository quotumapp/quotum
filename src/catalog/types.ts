import type { BillingChannel, BillingProvider } from "../billing/types";
import type { ProjectInstanceContext } from "../projects/context";
import type { CatalogProviderCompatibility } from "../providers/catalog-compatibility-types";
import type { BillingCadenceUnit, CadenceUnit } from "../shared/cadence";

export interface CatalogFeatureIntent {
	key: string;
	name: string;
	kind: "boolean" | "metered";
	meterKind: "consumable" | "non_consumable" | null;
	unit: string;
	creditScale: number;
	filterDimensions: string[];
}

export interface CatalogPlanItemIntent {
	featureKey: string;
	itemKind: "access" | "allocation" | "meter_limit" | "licensed_quantity";
	quantity: string | null;
	resetInterval: CadenceUnit | null;
	/** How many `resetInterval` units one window spans; defaults to one. */
	resetIntervalCount?: number | null;
	expiresAfterSeconds: number | null;
	overagePolicy: "blocked" | "allowed";
	allocationScope?: "account" | "entity" | "license_pool";
	rollover?: {
		maxQuantity: string | null;
		expiry: CatalogRolloverExpiryIntent;
	} | null;
	price?: CatalogPriceIntent | null;
}

/**
 * When rolled-over quantity expires. `months` is the earlier spelling of `after` with a month
 * interval; it is still accepted and is normalized to `after`.
 */
export type CatalogRolloverExpiryIntent =
	| { mode: "forever" }
	| { mode: "after"; interval: CadenceUnit; intervalCount: number }
	| { mode: "months"; months: number };

export interface CatalogProviderBindingIntent {
	productKey: string;
	provider: BillingProvider;
	channel: BillingChannel;
}

export interface CatalogPriceIntent {
	key: string;
	currency: string;
	unitAmountMinor: number;
	billingUnits: string;
	billingInterval: BillingCadenceUnit;
	/** How many `billingInterval` units one billing period spans; defaults to one. */
	billingIntervalCount?: number;
	minimumQuantity: number;
	maximumQuantity: number | null;
	taxBehavior: "inclusive" | "exclusive" | "unspecified";
	pricingModel?: "flat" | "graduated" | "volume";
	tiers?: CatalogPriceTierIntent[];
	providerBindings: CatalogProviderBindingIntent[];
}

export interface CatalogPriceTierIntent {
	upToQuantity: string | null;
	unitAmountMinor: number;
	flatAmountMinor?: number;
}

export interface CatalogControlIntent {
	controlKind: "spend_limit" | "usage_limit";
	featureKey: string | null;
	currency: string | null;
	limitValue: string;
	interval: CadenceUnit | "lifetime";
	/** How many `interval` units one window spans; defaults to one, and lifetime takes none. */
	intervalCount?: number | null;
}

export interface CatalogPlanIntent {
	key: string;
	name: string;
	version: number;
	currency: string | null;
	baseAmountMinor: number | null;
	billingInterval: BillingCadenceUnit | null;
	/** How many `billingInterval` units one billing period spans; defaults to one. */
	billingIntervalCount?: number | null;
	trialDays: number | null;
	kind?: "base" | "addon";
	tierRank?: number;
	trialRequiresPaymentMethod?: boolean;
	trialEndBehavior?: "cancel" | "pause";
	upgradeProrationBehavior?: "always_invoice" | "create_prorations" | "none";
	downgradeProrationBehavior?: "always_invoice" | "create_prorations" | "none";
	visibility?: "public" | "customer_specific";
	customerBillingAccountId?: string | null;
	basePrice?: CatalogPriceIntent | null;
	items: CatalogPlanItemIntent[];
	controls?: CatalogControlIntent[];
	providerBindings: CatalogProviderBindingIntent[];
}

export interface CatalogRateCardIntent {
	meterFeatureKey: string;
	walletFeatureKey: string;
	ratePerUnit: string;
	pricingModel?: "flat" | "graduated";
	tiers?: Array<{
		upToQuantity: string | null;
		ratePerUnit: string;
	}>;
}

export interface CatalogTopupIntent {
	key: string;
	featureKey: string;
	quantity: string;
	expiresAfterSeconds: number | null;
	providerBindings: CatalogProviderBindingIntent[];
}

/**
 * The plan an account holds while it has no paid base plan: a public, unpriced base plan of this
 * catalog. Its entitlement keys are declared here, since an unpriced plan has no provider product.
 */
export interface CatalogDefaultPlanIntent {
	planKey: string;
	entitlementKeys?: string[];
}

export interface CatalogIntent {
	features: CatalogFeatureIntent[];
	plans: CatalogPlanIntent[];
	topups: CatalogTopupIntent[];
	rateCards: CatalogRateCardIntent[];
	retiredFeatureKeys?: string[];
	retiredPlanKeys?: string[];
	retiredTopupKeys?: string[];
	/** Absent or null when the catalog marks no default plan. */
	defaultPlan?: CatalogDefaultPlanIntent | null;
}

export interface CatalogPreviewInput {
	expectedRevision: number | null;
	actor: string;
	catalog: CatalogIntent;
}

export interface CatalogPublishInput extends CatalogPreviewInput {
	previewToken: string;
}

export interface CatalogImpact {
	featuresCreated: number;
	featuresReused: number;
	featuresRetired: number;
	plansCreated: number;
	planVersionsCreated: number;
	plansRetired: number;
	topupOptionsCreated: number;
	topupsRetired: number;
	providerBindingsValidated: number;
	existingSubscriptionsGrandfathered: number;
	/** Accounts without a paid base plan or an active base plan grant, which hold the default. */
	defaultPlanAccounts: number;
}

export interface CatalogPreview {
	previewToken: string;
	intentHash: string;
	baseRevision: number | null;
	nextRevision: number;
	expiresAt: string;
	impact: CatalogImpact;
	/**
	 * Every binding judged on the declarations, each entry's bindings followed by one hypothetical
	 * binding per admitted provider it leaves unbound. A preview only succeeds when every bound
	 * entry is compatible.
	 */
	providerCompatibility: CatalogProviderCompatibility[];
}

export interface CatalogPublishResult {
	revisionId: string;
	revision: number;
	intentHash: string;
	publishedAt: string;
	duplicate: boolean;
	impact: CatalogImpact;
}

export interface PublishedCatalog {
	revisionId: string | null;
	revision: number | null;
	intentHash: string | null;
	publishedAt: string | null;
	catalog: CatalogIntent | null;
}

export interface CatalogControlPlaneLike {
	getPublished?(project: ProjectInstanceContext): Promise<PublishedCatalog>;
	preview(project: ProjectInstanceContext, input: CatalogPreviewInput): Promise<CatalogPreview>;
	publish(
		project: ProjectInstanceContext,
		input: CatalogPublishInput,
	): Promise<CatalogPublishResult>;
}
