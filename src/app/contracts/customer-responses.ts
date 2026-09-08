import { z } from "@hono/zod-openapi";
import {
	EntitlementSnapshotSchema,
	StripeBillingAccountSummarySchema,
	SubscriptionChangeOperationSchema,
} from "./provider-responses";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1BillingAccountsByBillingAccountIdEntitlementsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			billingAccountId: z.string(),
			entitlements: z.array(
				z.object({
					key: z.string(),
					active: z.boolean(),
					expiresAt: z.union([z.null(), z.string()]),
					metadata: z.record(z.string(), z.unknown()),
				}),
			),
			generatedAt: z.string(),
		}),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdEntitlementsResponse200");

export const getV1CatalogResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			schemaVersion: z.literal(1),
			plans: z.array(
				z.object({
					key: z.string(),
					name: z.string(),
					version: z.number(),
					kind: z.enum(["base", "addon"]),
					tierRank: z.number(),
					trialDays: z.union([z.null(), z.number()]),
					trialRequiresPaymentMethod: z.boolean(),
					trialEndBehavior: z.enum(["cancel", "pause"]),
					upgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]),
					downgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]),
					components: z.array(
						z.object({
							key: z.string(),
							kind: z.enum(["base", "licensed", "metered_overage"]),
							featureKey: z.union([z.null(), z.string()]),
							featureUnit: z.union([z.null(), z.string()]),
							includedQuantity: z.union([z.null(), z.string()]),
							currency: z.string(),
							unitAmountMinor: z.number(),
							pricingModel: z.enum(["flat", "graduated", "volume"]),
							tiers: z.array(
								z.object({
									upToQuantity: z.union([z.null(), z.string()]),
									unitAmountMinor: z.number(),
									flatAmountMinor: z.number(),
								}),
							),
							billingUnits: z.string(),
							interval: z.enum(["month", "year"]),
							minimumQuantity: z.number(),
							maximumQuantity: z.union([z.null(), z.number()]),
							taxBehavior: z.enum(["inclusive", "exclusive", "unspecified"]),
						}),
					),
				}),
			),
			oneTimePurchases: z.array(
				z.object({
					key: z.string(),
					name: z.string(),
					kind: z.enum(["topup", "one_time"]),
					currency: z.string(),
					amountMinor: z.number(),
					credits: z.number(),
				}),
			),
		}),
	})
	.openapi("getV1CatalogResponse200");

export const getV1BillingAccountsByBillingAccountIdBillingAccountResponse200Schema = z
	.object({ success: z.literal(true), data: StripeBillingAccountSummarySchema })
	.openapi("getV1BillingAccountsByBillingAccountIdBillingAccountResponse200");

export const postV1BillingAccountsByBillingAccountIdCommercialActionsPreviewResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			schemaVersion: z.literal(1),
			previewToken: z.string(),
			intentHash: z.string(),
			stateFingerprint: z.string(),
			expiresAt: z.string(),
			billingAccountId: z.string(),
			action: z.enum(["checkout_plan", "checkout_product", "subscription_change"]),
			provider: z.literal("stripe"),
			lineItems: z.array(
				z.object({
					key: z.string(),
					label: z.string(),
					quantity: z.number(),
					unitAmountMinor: z.number(),
					currency: z.string(),
					interval: z.union([z.null(), z.literal("month"), z.literal("year")]),
					pricingModel: z.enum(["flat", "graduated", "volume"]),
				}),
			),
			estimatedTotalMinor: z.union([z.null(), z.number()]),
			currency: z.union([z.null(), z.string()]),
			amountStatus: z.enum(["exact", "provider_calculated"]),
			effectiveMode: z.union([z.null(), z.literal("immediate"), z.literal("period_end")]),
			effectiveAt: z.union([z.null(), z.string()]),
			prorationBehavior: z.union([
				z.null(),
				z.literal("always_invoice"),
				z.literal("create_prorations"),
				z.literal("none"),
			]),
			changeKind: z.union([
				z.null(),
				z.literal("quantity"),
				z.literal("upgrade"),
				z.literal("downgrade"),
			]),
			fromPlanVersionId: z.union([z.null(), z.string()]),
			toPlanVersionId: z.union([z.null(), z.string()]),
			targetId: z.string(),
			warnings: z.array(z.string()),
		}),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdCommercialActionsPreviewResponse200");

export const postV1BillingAccountsByBillingAccountIdCommercialActionsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.union([
			z.object({
				kind: z.literal("checkout"),
				sessionId: z.string(),
				url: z.string(),
				duplicate: z.boolean(),
			}),
			z.object({
				kind: z.literal("subscription_change"),
				changeId: z.string(),
				status: z.enum(["pending", "failed", "cancelled", "processing", "applied"]),
				effectiveMode: z.enum(["immediate", "period_end"]),
				effectiveAt: z.string(),
			}),
		]),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdCommercialActionsResponse200");

export const postV1BillingAccountsByBillingAccountIdCommercialActionsResponse202Schema = z
	.object({
		success: z.literal(true),
		data: z.union([
			z.object({
				kind: z.literal("checkout"),
				sessionId: z.string(),
				url: z.string(),
				duplicate: z.boolean(),
			}),
			z.object({
				kind: z.literal("subscription_change"),
				changeId: z.string(),
				status: z.enum(["pending", "failed", "cancelled", "processing", "applied"]),
				effectiveMode: z.enum(["immediate", "period_end"]),
				effectiveAt: z.string(),
			}),
		]),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdCommercialActionsResponse202");

export const getV1BillingAccountsByBillingAccountIdProvidersAppleAccountTokenResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ appAccountToken: z.string() }) })
	.openapi("getV1BillingAccountsByBillingAccountIdProvidersAppleAccountTokenResponse200");

export const getV1BillingAccountsByBillingAccountIdProvidersGoogleAccountLinkResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ obfuscatedAccountId: z.string() }) })
	.openapi("getV1BillingAccountsByBillingAccountIdProvidersGoogleAccountLinkResponse200");

export const postV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.object({ sessionId: z.string(), url: z.string(), duplicate: z.boolean().optional() }),
		})
		.openapi("postV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsResponse200");

export const postV1BillingAccountsByBillingAccountIdProvidersStripePortalSessionsResponse200Schema =
	z
		.object({ success: z.literal(true), data: z.object({ url: z.string() }) })
		.openapi("postV1BillingAccountsByBillingAccountIdProvidersStripePortalSessionsResponse200");

export const postV1BillingAccountsByBillingAccountIdSubscriptionsBySubscriptionIdChangesResponse202Schema =
	z
		.object({ success: z.literal(true), data: SubscriptionChangeOperationSchema })
		.openapi(
			"postV1BillingAccountsByBillingAccountIdSubscriptionsBySubscriptionIdChangesResponse202",
		);

export const getV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsBySessionIdResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.object({
				sessionId: z.string(),
				status: z.union([z.null(), z.string()]),
				paymentStatus: z.union([z.null(), z.string()]),
				customerEmail: z.union([z.null(), z.string()]),
				productKey: z.union([z.null(), z.string()]),
			}),
		})
		.openapi(
			"getV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsBySessionIdResponse200",
		);

export const postV1PurchasesVerifyResponse200Schema = z
	.object({ success: z.literal(true), data: EntitlementSnapshotSchema })
	.openapi("postV1PurchasesVerifyResponse200");
