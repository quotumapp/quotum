import type { BillingChannel, BillingProvider } from "../billing/types";
import type { ProjectContext } from "../projects/context";

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
	resetInterval: "month" | "year" | null;
	expiresAfterSeconds: number | null;
	overagePolicy: "blocked" | "allowed";
	allocationScope?: "account" | "entity" | "license_pool";
	rollover?: {
		maxQuantity: string | null;
		expiry: { mode: "forever" } | { mode: "months"; months: number };
	} | null;
	price?: CatalogPriceIntent | null;
}

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
	billingInterval: "month" | "year";
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
	interval: "month" | "year" | "lifetime";
}

export interface CatalogPlanIntent {
	key: string;
	name: string;
	version: number;
	currency: string | null;
	baseAmountMinor: number | null;
	billingInterval: "month" | "year" | null;
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

export interface CatalogIntent {
	features: CatalogFeatureIntent[];
	plans: CatalogPlanIntent[];
	topups: CatalogTopupIntent[];
	rateCards: CatalogRateCardIntent[];
	retiredFeatureKeys?: string[];
	retiredPlanKeys?: string[];
	retiredTopupKeys?: string[];
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
}

export interface CatalogPreview {
	previewToken: string;
	intentHash: string;
	baseRevision: number | null;
	nextRevision: number;
	expiresAt: string;
	impact: CatalogImpact;
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
	getPublished?(project: ProjectContext): Promise<PublishedCatalog>;
	preview(project: ProjectContext, input: CatalogPreviewInput): Promise<CatalogPreview>;
	publish(project: ProjectContext, input: CatalogPublishInput): Promise<CatalogPublishResult>;
}
