import { z } from "@hono/zod-openapi";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1AdminCatalogResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			revisionId: z.union([z.null(), z.string()]),
			revision: z.union([z.null(), z.number()]),
			intentHash: z.union([z.null(), z.string()]),
			publishedAt: z.union([z.null(), z.string()]),
			catalog: z.union([
				z.null(),
				z.object({
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
							currency: z.union([z.null(), z.string()]),
							baseAmountMinor: z.union([z.null(), z.number()]),
							billingInterval: z.union([z.null(), z.literal("month"), z.literal("year")]),
							trialDays: z.union([z.null(), z.number()]),
							kind: z.enum(["base", "addon"]).optional(),
							tierRank: z.number().optional(),
							trialRequiresPaymentMethod: z.boolean().optional(),
							trialEndBehavior: z.enum(["cancel", "pause"]).optional(),
							upgradeProrationBehavior: z
								.enum(["always_invoice", "create_prorations", "none"])
								.optional(),
							downgradeProrationBehavior: z
								.enum(["always_invoice", "create_prorations", "none"])
								.optional(),
							visibility: z.enum(["public", "customer_specific"]).optional(),
							customerBillingAccountId: z.union([z.null(), z.string()]).optional(),
							basePrice: z
								.union([
									z.null(),
									z.object({
										key: z.string(),
										currency: z.string(),
										unitAmountMinor: z.number(),
										billingUnits: z.string(),
										billingInterval: z.enum(["month", "year"]),
										minimumQuantity: z.number(),
										maximumQuantity: z.union([z.null(), z.number()]),
										taxBehavior: z.enum(["inclusive", "exclusive", "unspecified"]),
										pricingModel: z.enum(["flat", "graduated", "volume"]).optional(),
										tiers: z
											.array(
												z.object({
													upToQuantity: z.union([z.null(), z.string()]),
													unitAmountMinor: z.number(),
													flatAmountMinor: z.number().optional(),
												}),
											)
											.optional(),
										providerBindings: z.array(
											z.object({
												productKey: z.string(),
												provider: z.enum(["google", "apple", "stripe"]),
												channel: z.enum(["ios", "android", "web"]),
											}),
										),
									}),
								])
								.optional(),
							items: z.array(
								z.object({
									featureKey: z.string(),
									itemKind: z.enum(["access", "allocation", "meter_limit", "licensed_quantity"]),
									quantity: z.union([z.null(), z.string()]),
									resetInterval: z.union([z.null(), z.literal("month"), z.literal("year")]),
									expiresAfterSeconds: z.union([z.null(), z.number()]),
									overagePolicy: z.enum(["blocked", "allowed"]),
									allocationScope: z.enum(["account", "entity", "license_pool"]).optional(),
									rollover: z
										.union([
											z.null(),
											z.object({
												maxQuantity: z.union([z.null(), z.string()]),
												expiry: z.union([
													z.object({ mode: z.literal("forever") }),
													z.object({ mode: z.literal("months"), months: z.number() }),
												]),
											}),
										])
										.optional(),
									price: z
										.union([
											z.null(),
											z.object({
												key: z.string(),
												currency: z.string(),
												unitAmountMinor: z.number(),
												billingUnits: z.string(),
												billingInterval: z.enum(["month", "year"]),
												minimumQuantity: z.number(),
												maximumQuantity: z.union([z.null(), z.number()]),
												taxBehavior: z.enum(["inclusive", "exclusive", "unspecified"]),
												pricingModel: z.enum(["flat", "graduated", "volume"]).optional(),
												tiers: z
													.array(
														z.object({
															upToQuantity: z.union([z.null(), z.string()]),
															unitAmountMinor: z.number(),
															flatAmountMinor: z.number().optional(),
														}),
													)
													.optional(),
												providerBindings: z.array(
													z.object({
														productKey: z.string(),
														provider: z.enum(["google", "apple", "stripe"]),
														channel: z.enum(["ios", "android", "web"]),
													}),
												),
											}),
										])
										.optional(),
								}),
							),
							controls: z
								.array(
									z.object({
										controlKind: z.enum(["spend_limit", "usage_limit"]),
										featureKey: z.union([z.null(), z.string()]),
										currency: z.union([z.null(), z.string()]),
										limitValue: z.string(),
										interval: z.enum(["month", "year", "lifetime"]),
									}),
								)
								.optional(),
							providerBindings: z.array(
								z.object({
									productKey: z.string(),
									provider: z.enum(["google", "apple", "stripe"]),
									channel: z.enum(["ios", "android", "web"]),
								}),
							),
						}),
					),
					topups: z.array(
						z.object({
							key: z.string(),
							featureKey: z.string(),
							quantity: z.string(),
							expiresAfterSeconds: z.union([z.null(), z.number()]),
							providerBindings: z.array(
								z.object({
									productKey: z.string(),
									provider: z.enum(["google", "apple", "stripe"]),
									channel: z.enum(["ios", "android", "web"]),
								}),
							),
						}),
					),
					rateCards: z.array(
						z.object({
							meterFeatureKey: z.string(),
							walletFeatureKey: z.string(),
							ratePerUnit: z.string(),
							pricingModel: z.enum(["flat", "graduated"]).optional(),
							tiers: z
								.array(
									z.object({
										upToQuantity: z.union([z.null(), z.string()]),
										ratePerUnit: z.string(),
									}),
								)
								.optional(),
						}),
					),
					retiredFeatureKeys: z.array(z.string()).optional(),
					retiredPlanKeys: z.array(z.string()).optional(),
					retiredTopupKeys: z.array(z.string()).optional(),
				}),
			]),
		}),
	})
	.openapi("getV1AdminCatalogResponse200");

export const postV1AdminCatalogPreviewResponse200Schema = z
	.object({
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
			}),
		}),
	})
	.openapi("postV1AdminCatalogPreviewResponse200");

export const postV1AdminCatalogPublishResponse200Schema = z
	.object({
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
			}),
		}),
	})
	.openapi("postV1AdminCatalogPublishResponse200");
