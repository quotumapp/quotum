import type { BillingChannel, BillingProvider } from "../billing/types";
import type { ProjectInstanceContext } from "../projects/context";
import type { CatalogProviderCompatibility } from "../providers/catalog-compatibility-types";
import type { BillingCadenceUnit, CadenceUnit } from "../shared/cadence";
import type { PreviewOptions } from "../shared/preview-lifetime";

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
	/** The database working representation of an item kind. */
	itemKind: "access" | "allocation" | "meter_limit" | "licensed_quantity" | "unlimited_usage";
	quantity: string | null;
	resetInterval: CadenceUnit | null;
	/** How many `resetInterval` units one window spans; defaults to one. */
	resetIntervalCount?: number | null;
	expiresAfterSeconds: number | null;
	/**
	 * A calendar expiry: `expiryIntervalCount` units of `expiryInterval` after the allowance's window
	 * start. Exclusive with `expiresAfterSeconds`; only the canonical `expiry` can set it.
	 */
	expiryInterval?: CadenceUnit | null;
	expiryIntervalCount?: number | null;
	overagePolicy: "blocked" | "allowed";
	allocationScope?: "account" | "entity" | "license_pool";
	rollover?: {
		maxQuantity: string | null;
		expiry: CatalogRolloverExpiryIntent;
	} | null;
	price?: CatalogPriceIntent | null;
}

/** When rolled-over quantity expires. */
export type CatalogRolloverExpiryIntent = CatalogCanonicalRolloverExpiry;

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
	/** A calendar expiry after the purchase; exclusive with `expiresAfterSeconds`. */
	expiryInterval?: CadenceUnit | null;
	expiryIntervalCount?: number | null;
	providerBindings: CatalogProviderBindingIntent[];
}

/**
 * A one-time product that sells codes redeemable for a plan grant. It names an existing
 * `plan_grant` promotion, so the plan, its term and the redemption rules stay with the promotion;
 * the gift fixes how many codes one purchase yields and how long they stay redeemable.
 */
export interface CatalogGiftIntent {
	key: string;
	name: string;
	promotionKey: string;
	codeCount: number;
	codeValidDays: number;
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

/** Internal database working representation, derived from canonical authoring. */
export interface CatalogIntent {
	features: CatalogFeatureIntent[];
	plans: CatalogPlanIntent[];
	topups: CatalogTopupIntent[];
	rateCards: CatalogRateCardIntent[];
	/** Absent when the catalog sells no gifts. */
	gifts?: CatalogGiftIntent[];
	retiredFeatureKeys?: string[];
	retiredPlanKeys?: string[];
	retiredTopupKeys?: string[];
	retiredGiftKeys?: string[];
	/** Absent or null when the catalog marks no default plan. */
	defaultPlan?: CatalogDefaultPlanIntent | null;
}

/** A reset or billing window: `intervalCount` units of `interval`. */
export interface CatalogCadenceIntent {
	interval: CadenceUnit;
	intervalCount: number;
}

/**
 * When an allowance or a top-up expires, counted from the allowance's window start (and capped at
 * the window end) or from the purchase. `forever` never expires; `after` adds a calendar cadence in
 * UTC, month units clamping to a shorter month's last day as reset windows do; `after_seconds` is an
 * exact duration.
 */
export type CatalogExpiryIntent =
	| { mode: "forever" }
	| { mode: "after"; interval: CadenceUnit; intervalCount: number }
	| { mode: "after_seconds"; seconds: number };

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
	  }
	/**
	 * No quota cap on a metered feature: while a source holding it is active, the feature's meter
	 * limits do not deny usage, which is still recorded and still subject to controls.
	 */
	| { itemKind: "unlimited_usage"; featureKey: string };

/**
 * The products a provider prices: App Store and Google Play products, and Stripe products priced in
 * the Stripe dashboard. Quotum holds no amount for them, only their billing cadence and bindings.
 */
export interface CatalogProviderPricedIntent {
	billingInterval: BillingCadenceUnit;
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
	/**
	 * Left out when the catalog sells no gifts, like the two fields below, so a catalog published
	 * before gifts existed keeps its intent hash.
	 */
	gifts?: CatalogGiftIntent[];
	/** Left out when no gift is retired. */
	retiredGiftKeys?: string[];
	/** Left out when the catalog marks no default plan. */
	defaultPlan?: Required<CatalogDefaultPlanIntent>;
}

/** A canonical plan as an operator writes it, with optional defaults. */
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
}

export interface AuthoredProviderPricedIntent {
	billingInterval: BillingCadenceUnit;
	billingIntervalCount?: number;
	providerBindings: CatalogProviderBindingIntent[];
}

/** A canonical plan item with optional defaults. */
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
	| { itemKind: "unlimited_usage"; featureKey: string };

/** A canonical top-up with optional expiry. */
export interface AuthoredTopupIntent {
	key: string;
	featureKey: string;
	quantity: string;
	expiry?: CatalogExpiryIntent;
	providerBindings: CatalogProviderBindingIntent[];
}

/** A gift as an operator writes it: one code per purchase unless `codeCount` says otherwise. */
export interface AuthoredGiftIntent {
	key: string;
	name: string;
	promotionKey: string;
	codeCount?: number;
	codeValidDays: number;
	providerBindings: CatalogProviderBindingIntent[];
}

/** The canonical catalog accepted by preview and publish, with optional defaults. */
export interface AuthoredCatalogIntent {
	features: CatalogFeatureIntent[];
	plans: AuthoredPlanIntent[];
	topups: AuthoredTopupIntent[];
	rateCards: CatalogRateCardIntent[];
	gifts?: AuthoredGiftIntent[];
	retiredFeatureKeys?: string[];
	retiredPlanKeys?: string[];
	retiredTopupKeys?: string[];
	retiredGiftKeys?: string[];
	defaultPlan?: CatalogDefaultPlanIntent | null;
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
	giftOptionsCreated: number;
	giftsRetired: number;
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
	/** Valid shapes the operator may want to reconsider. */
	advisories: CatalogAdvisory[];
	/**
	 * For each feature the intent caps with a meter limit, the scope each plan declares and the plan
	 * versions live subscriptions stay pinned to with a different scope: a publish does not move
	 * them, a catalog migration does (PC-04).
	 */
	scopeImpact: CatalogScopeImpact[];
}

export interface CatalogScopeImpact {
	featureKey: string;
	scopes: Array<{ plan: string; scope: "account" | "entity" }>;
	pinnedVersions: Array<{
		plan: string;
		version: number;
		scope: "account" | "entity";
		subscriptions: number;
	}>;
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
	preview(
		project: ProjectInstanceContext,
		input: CatalogPreviewInput,
		options?: PreviewOptions,
	): Promise<CatalogPreview>;
	publish(
		project: ProjectInstanceContext,
		input: CatalogPublishInput,
	): Promise<CatalogPublishResult>;
}
