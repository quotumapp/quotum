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

/** A reset or billing window: `intervalCount` units of `interval`. */
export interface CatalogCadenceIntent {
	interval: CadenceUnit;
	intervalCount: number;
}

/**
 * When an allowance or a top-up expires. `forever` never expires; `after_seconds` is an exact
 * duration from the allowance's window start (capped at the window end) or from the purchase.
 */
export type CatalogExpiryIntent = { mode: "forever" } | { mode: "after_seconds"; seconds: number };

/** A meter limit either blocks usage beyond its quantity or bills it in arrears at `price`. */
export type CatalogOverageIntent =
	| { policy: "blocked" }
	| { policy: "allowed"; price: CatalogPriceIntent };

/** When rolled-over quantity expires, in its canonical spelling. */
export type CatalogCanonicalRolloverExpiry =
	| { mode: "forever" }
	| { mode: "after"; interval: CadenceUnit; intervalCount: number };

export interface CatalogCanonicalRollover {
	maxQuantity: string | null;
	expiry: CatalogCanonicalRolloverExpiry;
}

/** A plan item in its canonical spelling: each kind carries only the fields it uses. */
export type CanonicalPlanItem =
	| { itemKind: "access"; featureKey: string }
	| {
			itemKind: "allocation";
			featureKey: string;
			quantity: string;
			reset: CatalogCadenceIntent | null;
			expiry: CatalogExpiryIntent;
			allocationScope: "account" | "entity";
			rollover: CatalogCanonicalRollover | null;
	  }
	| {
			itemKind: "meter_limit";
			featureKey: string;
			quantity: string;
			reset: CatalogCadenceIntent;
			overage: CatalogOverageIntent;
			allocationScope: "account" | "entity";
	  }
	| {
			itemKind: "licensed_quantity";
			featureKey: string;
			quantity: string;
			price: CatalogPriceIntent;
			allocationScope: "account" | "license_pool";
	  };

/**
 * The products a provider prices: App Store and Google Play products, and Stripe products priced in
 * the Stripe dashboard. Quotum holds no amount for them, only their billing cadence and bindings.
 * `billingInterval` is null only in a stored plan published without one before the canonical intent;
 * a new intent must set it.
 */
export interface CatalogProviderPricedIntent {
	billingInterval: BillingCadenceUnit | null;
	billingIntervalCount: number;
	providerBindings: CatalogProviderBindingIntent[];
}

/**
 * A plan in its canonical spelling. A plan is unpriced when `basePrice` and `providerPriced` are
 * both null and no item has a price.
 */
export interface CanonicalPlan {
	key: string;
	name: string;
	version: number;
	kind: "base" | "addon";
	visibility: "public" | "customer_specific";
	customerBillingAccountId: string | null;
	tierRank: number;
	trialDays: number | null;
	trialRequiresPaymentMethod: boolean;
	trialEndBehavior: "cancel" | "pause";
	upgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
	downgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
	basePrice: CatalogPriceIntent | null;
	providerPriced: CatalogProviderPricedIntent | null;
	items: CanonicalPlanItem[];
	controls: CatalogControlIntent[];
}

export interface CanonicalTopup {
	key: string;
	featureKey: string;
	quantity: string;
	expiry: CatalogExpiryIntent;
	providerBindings: CatalogProviderBindingIntent[];
}

/**
 * The catalog intent in its canonical spelling: what preview stores and hashes and what the
 * published catalog reads back as, with every default spelled out. Features, rate cards, controls,
 * retirements and the default-plan marker keep the shapes of {@link CatalogIntent}.
 */
export interface CanonicalCatalog {
	features: CatalogFeatureIntent[];
	plans: CanonicalPlan[];
	topups: CanonicalTopup[];
	rateCards: CatalogRateCardIntent[];
	retiredFeatureKeys: string[];
	retiredPlanKeys: string[];
	retiredTopupKeys: string[];
	/** Left out when the catalog marks no default plan. */
	defaultPlan?: Required<CatalogDefaultPlanIntent>;
}

/**
 * A plan as an operator writes it during the transition to the canonical intent: either the
 * canonical fields (`basePrice`, `providerPriced`) or the legacy plan-level price fields, which
 * preview reports as deprecated. Defaulted fields are optional.
 */
export interface AuthoredPlanIntent {
	key: string;
	name: string;
	version: number;
	trialDays?: number | null;
	kind?: "base" | "addon";
	tierRank?: number;
	trialRequiresPaymentMethod?: boolean;
	trialEndBehavior?: "cancel" | "pause";
	upgradeProrationBehavior?: "always_invoice" | "create_prorations" | "none";
	downgradeProrationBehavior?: "always_invoice" | "create_prorations" | "none";
	visibility?: "public" | "customer_specific";
	customerBillingAccountId?: string | null;
	basePrice?: CatalogPriceIntent | null;
	providerPriced?: AuthoredProviderPricedIntent | null;
	items: AuthoredPlanItemIntent[];
	controls?: CatalogControlIntent[];
	/** @deprecated Use `basePrice` and `providerPriced`. */
	currency?: string | null;
	/** @deprecated Use `basePrice`; a provider-priced plan has no Quotum amount. */
	baseAmountMinor?: number | null;
	/** @deprecated Use the cadence of `basePrice` or `providerPriced`. */
	billingInterval?: BillingCadenceUnit | null;
	/** @deprecated Use the cadence of `basePrice` or `providerPriced`. */
	billingIntervalCount?: number | null;
	/** @deprecated Use the bindings of `basePrice` or `providerPriced`. */
	providerBindings?: CatalogProviderBindingIntent[];
}

export interface AuthoredProviderPricedIntent {
	billingInterval: BillingCadenceUnit;
	billingIntervalCount?: number;
	providerBindings: CatalogProviderBindingIntent[];
}

/** A plan item as an operator writes it: canonical, with defaults optional, or legacy. */
export type AuthoredPlanItemIntent =
	| { itemKind: "access"; featureKey: string }
	| {
			itemKind: "allocation";
			featureKey: string;
			quantity: string;
			reset?: CatalogCadenceIntent | null;
			expiry?: CatalogExpiryIntent;
			allocationScope?: "account" | "entity";
			rollover?: CatalogCanonicalRollover | null;
	  }
	| {
			itemKind: "meter_limit";
			featureKey: string;
			quantity: string;
			reset: CatalogCadenceIntent;
			overage?: CatalogOverageIntent;
			allocationScope?: "account" | "entity";
	  }
	| {
			itemKind: "licensed_quantity";
			featureKey: string;
			quantity: string;
			price: CatalogPriceIntent;
			allocationScope?: "account" | "license_pool";
	  }
	| CatalogPlanItemIntent;

/** A top-up as an operator writes it: canonical `expiry`, or the legacy `expiresAfterSeconds`. */
export interface AuthoredTopupIntent {
	key: string;
	featureKey: string;
	quantity: string;
	expiry?: CatalogExpiryIntent;
	/** @deprecated Use `expiry`. */
	expiresAfterSeconds?: number | null;
	providerBindings: CatalogProviderBindingIntent[];
}

/**
 * A catalog intent as preview and publish accept it during the transition: canonical or legacy
 * spellings, per plan, item and top-up. A legacy {@link CatalogIntent} is one.
 */
export interface AuthoredCatalogIntent {
	features: CatalogFeatureIntent[];
	plans: AuthoredPlanIntent[];
	topups: AuthoredTopupIntent[];
	rateCards: CatalogRateCardIntent[];
	retiredFeatureKeys?: string[];
	retiredPlanKeys?: string[];
	retiredTopupKeys?: string[];
	defaultPlan?: CatalogDefaultPlanIntent | null;
}

/**
 * Legacy syntax a preview accepted: the fields at `path`, and the canonical fields that replace
 * them (empty when the legacy value carries nothing the canonical intent keeps).
 */
export interface CatalogDeprecation {
	path: string;
	legacy: string[];
	canonical: string[];
	message: string;
}

/** A valid shape the operator may want to reconsider; it never implies removal. */
export interface CatalogAdvisory {
	path: string;
	message: string;
}

export interface CatalogPreviewInput {
	expectedRevision: number | null;
	actor: string;
	catalog: AuthoredCatalogIntent;
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
	/** Legacy syntax the intent used; it is accepted until the 1.0 release candidate. */
	deprecations: CatalogDeprecation[];
	/** Valid shapes the operator may want to reconsider. */
	advisories: CatalogAdvisory[];
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
	/** The hash of the canonical intent read back, which previewing it unchanged reports. */
	intentHash: string | null;
	publishedAt: string | null;
	catalog: CanonicalCatalog | null;
}

export interface CatalogControlPlaneLike {
	getPublished?(project: ProjectInstanceContext): Promise<PublishedCatalog>;
	preview(project: ProjectInstanceContext, input: CatalogPreviewInput): Promise<CatalogPreview>;
	publish(
		project: ProjectInstanceContext,
		input: CatalogPublishInput,
	): Promise<CatalogPublishResult>;
}
