import { z } from "zod";
import { billingProviders } from "../billing/types";
import {
	billingCadenceUnits,
	cadenceUnits,
	maxCadenceCount,
	maxExpirySeconds,
} from "../shared/cadence";
import { maxInt4, minInt4 } from "../shared/input-bounds";

/** An exact-duration expiry: whole seconds, at most ten years. */
const expirySecondsSchema = z.number().int().min(1).max(maxExpirySeconds);

const featureSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(200),
		kind: z.enum(["boolean", "metered"]),
		meterKind: z.enum(["consumable", "non_consumable"]).nullable(),
		unit: z.string().trim().min(1).max(120),
		creditScale: z.number().int().min(0).max(9),
		filterDimensions: z.array(z.string().trim().min(1).max(120)).max(8),
	})
	.strict();

const providerBindingSchema = z
	.object({
		productKey: z.string().trim().min(1).max(120),
		provider: z.enum(billingProviders),
		channel: z.enum(["ios", "android", "web"]),
	})
	.strict();

const priceTierSchema = z
	.object({
		upToQuantity: z.string().trim().min(1).max(80).nullable(),
		unitAmountMinor: z.number().int().nonnegative(),
		flatAmountMinor: z.number().int().nonnegative().optional(),
	})
	.strict();

const priceSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		currency: z.string().trim().length(3),
		unitAmountMinor: z.number().int().nonnegative(),
		billingUnits: z.string().trim().min(1).max(80),
		billingInterval: z.enum(billingCadenceUnits),
		billingIntervalCount: z.number().int().min(1).max(maxCadenceCount).optional(),
		minimumQuantity: z.number().int().min(1).max(maxInt4),
		maximumQuantity: z.number().int().min(1).max(maxInt4).nullable(),
		taxBehavior: z.enum(["inclusive", "exclusive", "unspecified"]),
		pricingModel: z.enum(["flat", "graduated", "volume"]).optional(),
		// Empty for a flat price, which is how the published catalog returns one.
		tiers: z.array(priceTierSchema).max(100).optional(),
		providerBindings: z.array(providerBindingSchema).min(1).max(20),
	})
	.strict();

const featureKeySchema = z.string().trim().min(1).max(120);
const quantitySchema = z.string().trim().min(1).max(80);

const cadenceSchema = z
	.object({
		interval: z.enum(cadenceUnits),
		intervalCount: z.number().int().min(1).max(maxCadenceCount),
	})
	.strict();

/** An allowance or top-up expiry: never, a calendar cadence, or an exact duration. */
const expirySchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("forever") }).strict(),
	z
		.object({
			mode: z.literal("after"),
			interval: z.enum(cadenceUnits),
			intervalCount: z.number().int().min(1).max(maxCadenceCount),
		})
		.strict(),
	z.object({ mode: z.literal("after_seconds"), seconds: expirySecondsSchema }).strict(),
]);

const canonicalRolloverSchema = z
	.object({
		maxQuantity: quantitySchema.nullable(),
		expiry: z.discriminatedUnion("mode", [
			z.object({ mode: z.literal("forever") }).strict(),
			z
				.object({
					mode: z.literal("after"),
					interval: z.enum(cadenceUnits),
					intervalCount: z.number().int().min(1).max(maxCadenceCount),
				})
				.strict(),
		]),
	})
	.strict();

/** A plan item in the canonical spelling: each kind takes only the fields it uses. */
const canonicalPlanItemSchema = z.discriminatedUnion("itemKind", [
	z.object({ itemKind: z.literal("access"), featureKey: featureKeySchema }).strict(),
	z
		.object({
			itemKind: z.literal("allocation"),
			featureKey: featureKeySchema,
			quantity: quantitySchema,
			reset: cadenceSchema.nullable().optional(),
			expiry: expirySchema.optional(),
			allocationScope: z.enum(["account", "entity"]).optional(),
			rollover: canonicalRolloverSchema.nullable().optional(),
		})
		.strict(),
	z
		.object({
			itemKind: z.literal("meter_limit"),
			featureKey: featureKeySchema,
			quantity: quantitySchema,
			reset: cadenceSchema,
			overage: z
				.discriminatedUnion("policy", [
					z.object({ policy: z.literal("blocked") }).strict(),
					z.object({ policy: z.literal("allowed"), price: priceSchema }).strict(),
				])
				.optional(),
			allocationScope: z.enum(["account", "entity"]).optional(),
		})
		.strict(),
	z
		.object({
			itemKind: z.literal("licensed_quantity"),
			featureKey: featureKeySchema,
			quantity: quantitySchema,
			price: priceSchema,
			allocationScope: z.enum(["account", "license_pool"]).optional(),
		})
		.strict(),
	z.object({ itemKind: z.literal("unlimited_usage"), featureKey: featureKeySchema }).strict(),
]);

const planItemSchema = canonicalPlanItemSchema;

/** Products whose price the provider owns: App Store, Google Play, or Stripe dashboard prices. */
const providerPricedSchema = z
	.object({
		billingInterval: z.enum(billingCadenceUnits),
		billingIntervalCount: z.number().int().min(1).max(maxCadenceCount).optional(),
		providerBindings: z.array(providerBindingSchema).min(1).max(20),
	})
	.strict();

const controlSchema = z
	.object({
		controlKind: z.enum(["spend_limit", "usage_limit"]),
		featureKey: z.string().trim().min(1).max(120).nullable(),
		currency: z.string().trim().length(3).nullable(),
		limitValue: z.string().trim().min(1).max(80),
		interval: z.enum([...cadenceUnits, "lifetime"]),
		intervalCount: z.number().int().min(1).max(maxCadenceCount).nullable().optional(),
	})
	.strict();

/** A canonical plan with optional authoring defaults. */
const planSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(200),
		version: z.number().int().min(1).max(maxInt4),
		trialDays: z.number().int().min(0).max(730).nullable().optional(),
		kind: z.enum(["base", "addon"]).optional(),
		tierRank: z.number().int().min(minInt4).max(maxInt4).optional(),
		trialRequiresPaymentMethod: z.boolean().optional(),
		trialEndBehavior: z.enum(["cancel", "pause"]).optional(),
		upgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
		downgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
		visibility: z.enum(["public", "customer_specific"]).optional(),
		customerBillingAccountId: z.string().trim().min(1).max(200).nullable().optional(),
		basePrice: priceSchema.nullable().optional(),
		providerPriced: providerPricedSchema.nullable().optional(),
		items: z.array(planItemSchema).max(100),
		controls: z.array(controlSchema).max(50).optional(),
	})
	.strict();

const rateCardSchema = z
	.object({
		meterFeatureKey: z.string().trim().min(1).max(120),
		walletFeatureKey: z.string().trim().min(1).max(120),
		ratePerUnit: z.string().trim().min(1).max(80),
		pricingModel: z.enum(["flat", "graduated"]).optional(),
		tiers: z
			.array(
				z
					.object({
						upToQuantity: z.string().trim().min(1).max(80).nullable(),
						ratePerUnit: z.string().trim().min(1).max(80),
					})
					.strict(),
			)
			// Empty for a flat rate card, which is how the published catalog returns one.
			.max(100)
			.optional(),
	})
	.strict();

const topupSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		featureKey: z.string().trim().min(1).max(120),
		quantity: z.string().trim().min(1).max(80),
		expiry: expirySchema.optional(),
		providerBindings: z.array(providerBindingSchema).min(1).max(20),
	})
	.strict();

const giftSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(200),
		promotionKey: z.string().trim().min(1).max(120),
		codeCount: z.number().int().min(1).max(100).optional(),
		codeValidDays: z.number().int().min(1).max(730),
		providerBindings: z.array(providerBindingSchema).min(1).max(20),
	})
	.strict();

export const catalogIntentSchema = z
	.object({
		features: z.array(featureSchema).min(1).max(100),
		plans: z.array(planSchema).max(100),
		topups: z.array(topupSchema).max(100),
		rateCards: z.array(rateCardSchema).max(100),
		gifts: z.array(giftSchema).max(100).optional(),
		retiredFeatureKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		retiredPlanKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		retiredTopupKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		retiredGiftKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		defaultPlan: z
			.object({
				planKey: z.string().trim().min(1).max(120),
				entitlementKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
			})
			.strict()
			.nullable()
			.optional(),
	})
	.strict();
