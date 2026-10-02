import { z } from "zod";
import { billingCadenceUnits, cadenceUnits } from "../../shared/cadence";
import { billingProviderValues } from "./provider-enum";
import { CatalogProviderCompatibilitySchema } from "./provider-responses";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */

const providerBindingSchema = z.object({
	productKey: z.string(),
	provider: z.enum(billingProviderValues("google")),
	channel: z.enum(["ios", "android", "web"]),
});

const priceSchema = z.object({
	key: z.string(),
	currency: z.string(),
	unitAmountMinor: z.number(),
	billingUnits: z.string(),
	billingInterval: z.enum(billingCadenceUnits),
	billingIntervalCount: z.number(),
	minimumQuantity: z.number(),
	maximumQuantity: z.union([z.null(), z.number()]),
	taxBehavior: z.enum(["inclusive", "exclusive", "unspecified"]),
	pricingModel: z.enum(["flat", "graduated", "volume"]),
	tiers: z.array(
		z.object({
			upToQuantity: z.union([z.null(), z.string()]),
			unitAmountMinor: z.number(),
			flatAmountMinor: z.number(),
		}),
	),
	providerBindings: z.array(providerBindingSchema),
});

const cadenceSchema = z.object({ interval: z.enum(cadenceUnits), intervalCount: z.number() });

const expirySchema = z.union([
	z.object({ mode: z.literal("forever") }),
	z.object({ mode: z.literal("after"), interval: z.enum(cadenceUnits), intervalCount: z.number() }),
	z.object({ mode: z.literal("after_seconds"), seconds: z.number() }),
]);

/** A plan item as read back: canonical, each kind with only the fields it uses. */
const canonicalPlanItemSchema = z.discriminatedUnion("itemKind", [
	z.object({ itemKind: z.literal("access"), featureKey: z.string() }),
	z.object({
		itemKind: z.literal("allocation"),
		featureKey: z.string(),
		quantity: z.string(),
		reset: z.union([z.null(), cadenceSchema]),
		expiry: expirySchema,
		allocationScope: z.enum(["account", "entity"]),
		rollover: z.union([
			z.null(),
			z.object({
				maxQuantity: z.union([z.null(), z.string()]),
				expiry: z.union([
					z.object({ mode: z.literal("forever") }),
					z.object({
						mode: z.literal("after"),
						interval: z.enum(cadenceUnits),
						intervalCount: z.number(),
					}),
				]),
			}),
		]),
	}),
	z.object({
		itemKind: z.literal("meter_limit"),
		featureKey: z.string(),
		quantity: z.string(),
		reset: cadenceSchema,
		overage: z.union([
			z.object({ policy: z.literal("blocked") }),
			z.object({ policy: z.literal("allowed"), price: priceSchema }),
		]),
		allocationScope: z.enum(["account", "entity"]),
	}),
	z.object({
		itemKind: z.literal("licensed_quantity"),
		featureKey: z.string(),
		quantity: z.string(),
		price: priceSchema,
		allocationScope: z.enum(["account", "license_pool"]),
	}),
	z.object({ itemKind: z.literal("unlimited_usage"), featureKey: z.string() }),
]);

/** The published catalog read back in its canonical spelling, every default spelled out. */
export const CanonicalCatalogSchema = z.object({
	features: z.array(
		z.object({
			key: z.string(),
			name: z.string(),
			kind: z.enum(["boolean", "metered"]),
			meterKind: z.union([z.null(), z.literal("consumable"), z.literal("non_consumable")]),
			unit: z.string(),
			creditScale: z.number(),
			filterDimensions: z.array(z.string()),
		}),
	),
	plans: z.array(
		z.object({
			key: z.string(),
			name: z.string(),
			version: z.number(),
			kind: z.enum(["base", "addon"]),
			visibility: z.enum(["public", "customer_specific"]),
			customerBillingAccountId: z.union([z.null(), z.string()]),
			tierRank: z.number(),
			trialDays: z.union([z.null(), z.number()]),
			trialRequiresPaymentMethod: z.boolean(),
			trialEndBehavior: z.enum(["cancel", "pause"]),
			upgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]),
			downgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]),
			basePrice: z.union([z.null(), priceSchema]),
			providerPriced: z.union([
				z.null(),
				z.object({
					// Null only for a plan stored before the canonical intent without a billing interval.
					billingInterval: z.union([z.null(), z.enum(billingCadenceUnits)]),
					billingIntervalCount: z.number(),
					providerBindings: z.array(providerBindingSchema),
				}),
			]),
			items: z.array(canonicalPlanItemSchema),
			controls: z.array(
				z.object({
					controlKind: z.enum(["spend_limit", "usage_limit"]),
					featureKey: z.union([z.null(), z.string()]),
					currency: z.union([z.null(), z.string()]),
					limitValue: z.string(),
					interval: z.enum([...cadenceUnits, "lifetime"]),
					intervalCount: z.union([z.null(), z.number()]),
				}),
			),
		}),
	),
	topups: z.array(
		z.object({
			key: z.string(),
			featureKey: z.string(),
			quantity: z.string(),
			expiry: expirySchema,
			providerBindings: z.array(providerBindingSchema),
		}),
	),
	rateCards: z.array(
		z.object({
			meterFeatureKey: z.string(),
			walletFeatureKey: z.string(),
			ratePerUnit: z.string(),
			pricingModel: z.enum(["flat", "graduated"]),
			tiers: z.array(
				z.object({
					upToQuantity: z.union([z.null(), z.string()]),
					ratePerUnit: z.string(),
				}),
			),
		}),
	),
	retiredFeatureKeys: z.array(z.string()),
	retiredPlanKeys: z.array(z.string()),
	retiredTopupKeys: z.array(z.string()),
	defaultPlan: z.object({ planKey: z.string(), entitlementKeys: z.array(z.string()) }).optional(),
});

export const getV1AdminCatalogResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		revisionId: z.union([z.null(), z.string()]),
		revision: z.union([z.null(), z.number()]),
		intentHash: z.union([z.null(), z.string()]),
		publishedAt: z.union([z.null(), z.string()]),
		catalog: z.union([z.null(), CanonicalCatalogSchema]),
	}),
});

export const postV1AdminCatalogPreviewResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		previewToken: z.string(),
		intentHash: z.string(),
		baseRevision: z.union([z.null(), z.number()]),
		nextRevision: z.number(),
		expiresAt: z.string(),
		impact: z.object({
			featuresCreated: z.number(),
			featuresReused: z.number(),
			featuresRetired: z.number(),
			plansCreated: z.number(),
			planVersionsCreated: z.number(),
			plansRetired: z.number(),
			topupOptionsCreated: z.number(),
			topupsRetired: z.number(),
			providerBindingsValidated: z.number(),
			existingSubscriptionsGrandfathered: z.number(),
			defaultPlanAccounts: z.number(),
		}),
		providerCompatibility: z.array(CatalogProviderCompatibilitySchema),
		/** Legacy syntax the intent used; accepted until the 1.0 release candidate. */
		deprecations: z.array(
			z.object({
				path: z.string(),
				legacy: z.array(z.string()),
				canonical: z.array(z.string()),
				message: z.string(),
			}),
		),
		/** Valid shapes the operator may want to reconsider; an advisory never implies removal. */
		advisories: z.array(z.object({ path: z.string(), message: z.string() })),
	}),
});

export const postV1AdminCatalogPublishResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		revisionId: z.string(),
		revision: z.number(),
		intentHash: z.string(),
		publishedAt: z.string(),
		duplicate: z.boolean(),
		impact: z.object({
			featuresCreated: z.number(),
			featuresReused: z.number(),
			featuresRetired: z.number(),
			plansCreated: z.number(),
			planVersionsCreated: z.number(),
			plansRetired: z.number(),
			topupOptionsCreated: z.number(),
			topupsRetired: z.number(),
			providerBindingsValidated: z.number(),
			existingSubscriptionsGrandfathered: z.number(),
			defaultPlanAccounts: z.number(),
		}),
	}),
});
