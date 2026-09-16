import { z } from "zod";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
const channelSchema = z.enum(["web", "ios", "android"]);
const durationSchema = z.enum(["once", "repeating", "forever"]);

const promotionEffectSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("discount"),
		discount: z.discriminatedUnion("type", [
			z.object({
				type: z.literal("percent"),
				percentOffBps: z.number(),
				duration: durationSchema,
				durationMonths: z.union([z.null(), z.number()]),
			}),
			z.object({
				type: z.literal("amount"),
				amounts: z.array(z.object({ currency: z.string(), amountOffMinor: z.number() })),
				duration: durationSchema,
				durationMonths: z.union([z.null(), z.number()]),
			}),
		]),
	}),
	z.object({
		kind: z.literal("feature_grant"),
		items: z.array(
			z.object({
				featureKey: z.string(),
				quantity: z.string(),
				expiresAfterSeconds: z.union([z.null(), z.number()]),
			}),
		),
	}),
	z.object({
		kind: z.literal("plan_grant"),
		planKey: z.string(),
		durationUnit: z.enum(["day", "month"]),
		durationCount: z.number(),
	}),
]);

const promotionSchema = z.object({
	id: z.string(),
	key: z.string(),
	name: z.string(),
	status: z.enum(["active", "archived"]),
	effect: promotionEffectSchema,
	targets: z.array(z.object({ kind: z.enum(["plan", "product"]), key: z.string() })),
	allowedChannels: z.array(channelSchema),
	metadata: z.record(z.string(), z.unknown()),
	termsHash: z.string(),
	createdBy: z.string(),
	createdAt: z.string(),
	archivedBy: z.union([z.null(), z.string()]),
	archivedAt: z.union([z.null(), z.string()]),
	codeCounts: z.object({ total: z.number(), active: z.number() }),
	redemptionCounts: z.object({
		reserved: z.number(),
		applied: z.number(),
		released: z.number(),
		reversed: z.number(),
	}),
	providerObjects: z.array(
		z.object({
			id: z.string(),
			provider: z.enum(["stripe", "apple", "google"]),
			objectKind: z.enum([
				"coupon",
				"promotion_code",
				"apple_promotional_offer",
				"apple_offer_code",
				"google_developer_offer",
				"google_promo_code",
			]),
			promotionCodeId: z.union([z.null(), z.string()]),
			externalId: z.union([z.null(), z.string()]),
			status: z.enum(["pending", "ready", "failed", "retired"]),
			desiredActive: z.boolean(),
			providerActive: z.union([z.null(), z.boolean()]),
			error: z.union([z.null(), z.string()]),
			attempts: z.number(),
			updatedAt: z.string(),
		}),
	),
});

const promotionCodeSchema = z.object({
	id: z.string(),
	promotionKey: z.string(),
	code: z.string(),
	active: z.boolean(),
	startsAt: z.union([z.null(), z.string()]),
	expiresAt: z.union([z.null(), z.string()]),
	maxRedemptions: z.union([z.null(), z.number()]),
	maxRedemptionsPerCustomer: z.union([z.null(), z.number()]),
	firstPurchaseOnly: z.boolean(),
	billingAccountId: z.union([z.null(), z.string()]),
	hostedCheckoutEnabled: z.boolean(),
	redeemedCount: z.number(),
	reservedCount: z.number(),
	createdBy: z.string(),
	createdAt: z.string(),
	deactivatedBy: z.union([z.null(), z.string()]),
	deactivatedAt: z.union([z.null(), z.string()]),
});

const promotionRedemptionSchema = z.object({
	id: z.string(),
	promotionKey: z.string(),
	promotionCodeId: z.union([z.null(), z.string()]),
	code: z.union([z.null(), z.string()]),
	billingAccountId: z.string(),
	channel: channelSchema,
	status: z.enum(["reserved", "applied", "released", "reversed"]),
	provider: z.enum(["quotum", "stripe", "apple", "google"]),
	source: z.enum([
		"api_redeem",
		"commercial_action",
		"stripe_hosted_checkout",
		"apple_offer",
		"google_offer",
	]),
	stripeCheckoutSessionId: z.union([z.null(), z.string()]),
	externalSubscriptionId: z.union([z.null(), z.string()]),
	currency: z.union([z.null(), z.string()]),
	amountSubtotalMinor: z.union([z.null(), z.number()]),
	amountDiscountMinor: z.union([z.null(), z.number()]),
	amountTotalMinor: z.union([z.null(), z.number()]),
	limitViolation: z.union([
		z.null(),
		z.enum(["global", "first_purchase", "not_applicable", "inactive", "expired"]),
	]),
	actor: z.string(),
	reason: z.union([z.null(), z.string()]),
	reservedUntil: z.union([z.null(), z.string()]),
	appliedAt: z.union([z.null(), z.string()]),
	releasedAt: z.union([z.null(), z.string()]),
	reversedAt: z.union([z.null(), z.string()]),
	createdAt: z.string(),
});

const paginationSchema = z.object({ nextCursor: z.union([z.null(), z.string()]) });

export const postV1AdminPromotionsResponse201Schema = z.object({
	success: z.literal(true),
	data: promotionSchema,
});

export const postV1AdminPromotionsResponse200Schema = z.object({
	success: z.literal(true),
	data: promotionSchema,
});

export const getV1AdminPromotionsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(promotionSchema),
	pagination: paginationSchema,
});

export const getV1AdminPromotionsByPromotionKeyResponse200Schema = z.object({
	success: z.literal(true),
	data: promotionSchema,
});

export const postV1AdminPromotionsByPromotionKeyArchiveResponse200Schema = z.object({
	success: z.literal(true),
	data: promotionSchema,
});

export const postV1AdminPromotionsByPromotionKeyProviderSyncResponse200Schema = z.object({
	success: z.literal(true),
	data: promotionSchema,
});

export const postV1AdminPromotionsByPromotionKeyCodesResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ codes: z.array(promotionCodeSchema), created: z.number() }),
});

export const getV1AdminPromotionsByPromotionKeyCodesResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(promotionCodeSchema),
	pagination: paginationSchema,
});

export const postV1AdminPromotionsByPromotionKeyCodesByCodeIdDeactivateResponse200Schema = z.object(
	{
		success: z.literal(true),
		data: promotionCodeSchema,
	},
);

export const getV1AdminPromotionsByPromotionKeyRedemptionsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(promotionRedemptionSchema),
	pagination: paginationSchema,
});

export const postV1BillingAccountsByBillingAccountIdPromotionCodesValidateResponse200Schema =
	z.object({
		success: z.literal(true),
		data: z.object({
			valid: z.boolean(),
			reason: z.union([z.null(), z.string()]),
			promotion: z.union([
				z.null(),
				z.object({
					key: z.string(),
					name: z.string(),
					effectKind: z.enum(["discount", "feature_grant", "plan_grant"]),
					allowedChannels: z.array(channelSchema),
				}),
			]),
			code: z.union([
				z.null(),
				z.object({
					id: z.string(),
					code: z.string(),
					expiresAt: z.union([z.null(), z.string()]),
					hostedCheckoutEnabled: z.boolean(),
				}),
			]),
		}),
	});

export const postV1BillingAccountsByBillingAccountIdPromotionRedemptionsResponse200Schema =
	z.object({
		success: z.literal(true),
		data: z.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("granted"),
				duplicate: z.boolean(),
				redemption: promotionRedemptionSchema,
				grant: z.object({
					features: z.array(
						z.object({
							featureKey: z.string(),
							quantity: z.string(),
							expiresAt: z.union([z.null(), z.string()]),
							allocationId: z.string(),
						}),
					),
				}),
			}),
			z.object({
				kind: z.literal("requires_commercial_action"),
				duplicate: z.literal(false),
				redemption: z.null(),
				promotion: z.object({ key: z.string(), effectKind: z.literal("discount") }),
				commercialAction: z.object({ promotionCode: z.string() }),
			}),
		]),
	});

export const getV1BillingAccountsByBillingAccountIdPromotionRedemptionsResponse200Schema = z.object(
	{
		success: z.literal(true),
		data: z.array(promotionRedemptionSchema),
		pagination: paginationSchema,
	},
);

export const getV1BillingAccountsByBillingAccountIdPromotionRedemptionsByRedemptionIdResponse200Schema =
	z.object({
		success: z.literal(true),
		data: promotionRedemptionSchema,
	});

export const postV1AdminPromotionRedemptionsByRedemptionIdRevokeResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		duplicate: z.boolean(),
		redemption: promotionRedemptionSchema,
		reversedAllocations: z.array(
			z.object({
				allocationId: z.string(),
				featureKey: z.string(),
				reversedQuantity: z.string(),
				consumedQuantity: z.string(),
				heldQuantity: z.string(),
				expired: z.boolean(),
			}),
		),
	}),
});
