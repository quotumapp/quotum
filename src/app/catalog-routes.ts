import { z } from "zod";
import { BillingError } from "../billing/errors";
import { billingProviders } from "../billing/types";
import type { CatalogControlPlaneLike } from "../catalog/types";
import {
	billingCadenceUnits,
	cadenceUnits,
	maxCadenceCount,
	maxExpirySeconds,
} from "../shared/cadence";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { maxInt4, minInt4 } from "../shared/input-bounds";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/catalog-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface CatalogRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	catalogControlPlane: CatalogControlPlaneLike;
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
}

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

/** @deprecated The legacy spelling of a plan item, accepted until the 1.0 release candidate. */
const legacyPlanItemSchema = z
	.object({
		featureKey: z.string().trim().min(1).max(120),
		itemKind: z.enum(["access", "allocation", "meter_limit", "licensed_quantity"]),
		quantity: z.string().trim().min(1).max(80).nullable(),
		resetInterval: z.enum(cadenceUnits).nullable(),
		resetIntervalCount: z.number().int().min(1).max(maxCadenceCount).nullable().optional(),
		expiresAfterSeconds: expirySecondsSchema.nullable(),
		overagePolicy: z.enum(["blocked", "allowed"]),
		allocationScope: z.enum(["account", "entity", "license_pool"]).optional(),
		rollover: z
			.object({
				maxQuantity: z.string().trim().min(1).max(80).nullable(),
				expiry: z.discriminatedUnion("mode", [
					z.object({ mode: z.literal("forever") }).strict(),
					z
						.object({
							mode: z.literal("after"),
							interval: z.enum(cadenceUnits),
							intervalCount: z.number().int().min(1).max(maxCadenceCount),
						})
						.strict(),
					// The earlier spelling of `after` with a month interval.
					z
						.object({ mode: z.literal("months"), months: z.number().int().min(1).max(120) })
						.strict(),
				]),
			})
			.strict()
			.nullable()
			.optional(),
		price: priceSchema.nullable().optional(),
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

const planItemSchema = z.union([canonicalPlanItemSchema, legacyPlanItemSchema]);

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

/**
 * A plan, in the canonical spelling (`basePrice`, `providerPriced`) or the legacy plan-level price
 * fields, which preview reports as deprecated. Defaulted fields are optional.
 */
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
		currency: z.string().trim().min(3).max(3).nullable().optional(),
		baseAmountMinor: z.number().int().nonnegative().nullable().optional(),
		billingInterval: z.enum(billingCadenceUnits).nullable().optional(),
		billingIntervalCount: z.number().int().min(1).max(maxCadenceCount).nullable().optional(),
		providerBindings: z.array(providerBindingSchema).max(20).optional(),
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
		expiresAfterSeconds: expirySecondsSchema.nullable().optional(),
		providerBindings: z.array(providerBindingSchema).min(1).max(20),
	})
	.strict();

const catalogSchema = z
	.object({
		features: z.array(featureSchema).min(1).max(100),
		plans: z.array(planSchema).max(100),
		topups: z.array(topupSchema).max(100),
		rateCards: z.array(rateCardSchema).max(100),
		retiredFeatureKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		retiredPlanKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		retiredTopupKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
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

export const previewSchema = z
	.object({
		expectedRevision: z.number().int().positive().nullable(),
		catalog: catalogSchema,
	})
	.strict();

export const publishSchema = z
	.object({
		expectedRevision: z.number().int().positive().nullable(),
		previewToken: z.string().regex(/^[a-f0-9]{64}$/),
		catalog: catalogSchema,
	})
	.strict();

export function registerCatalogRoutes({
	app,
	operatorApiKey,
	catalogControlPlane,
	registerPostAuthGuard,
}: CatalogRoutesDependencies): void {
	registerPostAuthGuard(
		// Reading the published catalog needs project authentication only; every other catalog
		// route, reads included, stays behind the operator key.
		operatorApiKeyGuard(operatorApiKey, (p) => /^\/v1\/admin\/catalog\/.+$/.test(p)),
	);

	app.get(
		"/v1/admin/catalog",
		async ({ project }) => {
			if (catalogControlPlane.getPublished === undefined) {
				throw new BillingError("Published catalog reads are not configured", "NOT_CONFIGURED", 503);
			}
			const result = await catalogControlPlane.getPublished(privateProject(project));
			return { success: true, data: result };
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminCatalog",
				credentialAccess: "read_only",
				tags: ["catalog"],
				path: "/v1/admin/catalog",
				responses: {
					200: responses.getV1AdminCatalogResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/catalog/preview",
		async ({ body, request, project }) => {
			const result = await catalogControlPlane.preview(privateProject(project), {
				...body,
				actor: requireActor(request.headers),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: previewSchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCatalogPreview",
				tags: ["catalog"],
				path: "/v1/admin/catalog/preview",
				responses: {
					200: responses.postV1AdminCatalogPreviewResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/catalog/publish",
		async ({ body, request, project }) => {
			const result = await catalogControlPlane.publish(privateProject(project), {
				...body,
				actor: requireActor(request.headers),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: publishSchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCatalogPublish",
				tags: ["catalog"],
				path: "/v1/admin/catalog/publish",
				responses: {
					200: responses.postV1AdminCatalogPublishResponse200Schema,
				},
			}),
		},
	);
}
