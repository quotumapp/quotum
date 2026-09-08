import { z } from "@hono/zod-openapi";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const postV1BillingAccountsByBillingAccountIdEntitiesResponse201Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			externalId: z.string(),
			kind: z.string(),
			metadata: z.record(z.string(), z.unknown()),
			createdAt: z.string(),
			updatedAt: z.string(),
		}),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdEntitiesResponse201");

export const getV1BillingAccountsByBillingAccountIdEntitiesResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				externalId: z.string(),
				kind: z.string(),
				metadata: z.record(z.string(), z.unknown()),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
		),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdEntitiesResponse200");

export const putV1BillingAccountsByBillingAccountIdControlsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			controlKind: z.enum(["spend_limit", "usage_limit"]),
			featureKey: z.union([z.null(), z.string()]),
			currency: z.union([z.null(), z.string()]),
			limitValue: z.string(),
			interval: z.enum(["month", "year", "lifetime"]),
			source: z.enum(["account", "entity", "plan_default", "contract"]),
			revision: z.number(),
			policyId: z.string(),
			consumedValue: z.string(),
			heldValue: z.string(),
			remainingValue: z.string(),
		}),
	})
	.openapi("putV1BillingAccountsByBillingAccountIdControlsResponse200");

export const getV1BillingAccountsByBillingAccountIdControlsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				controlKind: z.enum(["spend_limit", "usage_limit"]),
				featureKey: z.union([z.null(), z.string()]),
				currency: z.union([z.null(), z.string()]),
				limitValue: z.string(),
				interval: z.enum(["month", "year", "lifetime"]),
				source: z.enum(["account", "entity", "plan_default", "contract"]),
				revision: z.number(),
				policyId: z.string(),
				consumedValue: z.string(),
				heldValue: z.string(),
				remainingValue: z.string(),
			}),
		),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdControlsResponse200");

export const postV1BillingAccountsByBillingAccountIdUsageAlertsResponse201Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			entityId: z.union([z.null(), z.string()]),
			featureKey: z.string(),
			thresholdType: z.enum(["absolute", "percentage"]),
			thresholdValue: z.string(),
			interval: z.enum(["month", "year", "lifetime"]),
			active: z.boolean(),
			currentValue: z.string(),
			crossed: z.boolean(),
			createdAt: z.string(),
		}),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdUsageAlertsResponse201");

export const getV1BillingAccountsByBillingAccountIdUsageAlertsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				entityId: z.union([z.null(), z.string()]),
				featureKey: z.string(),
				thresholdType: z.enum(["absolute", "percentage"]),
				thresholdValue: z.string(),
				interval: z.enum(["month", "year", "lifetime"]),
				active: z.boolean(),
				currentValue: z.string(),
				crossed: z.boolean(),
				createdAt: z.string(),
			}),
		),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdUsageAlertsResponse200");

export const getV1BillingAccountsByBillingAccountIdUsageAlertEventsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				alertId: z.string(),
				entityId: z.union([z.null(), z.string()]),
				featureKey: z.string(),
				eventType: z.enum(["threshold_crossed", "threshold_rearmed"]),
				currentValue: z.string(),
				thresholdValue: z.string(),
				windowStartAt: z.string(),
				createdAt: z.string(),
			}),
		),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdUsageAlertEventsResponse200");

export const putV1BillingAccountsByBillingAccountIdAutoTopupResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			entityId: z.union([z.null(), z.string()]),
			featureKey: z.string(),
			topupKey: z.string(),
			provider: z.enum(["google", "apple", "stripe"]),
			thresholdQuantity: z.string(),
			status: z.enum(["ready", "suspended", "cooldown"]),
			cooldownUntil: z.union([z.null(), z.string()]),
			consecutiveFailures: z.number(),
			active: z.boolean(),
		}),
	})
	.openapi("putV1BillingAccountsByBillingAccountIdAutoTopupResponse200");

export const getV1BillingAccountsByBillingAccountIdAutoTopupResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.union([
			z.null(),
			z.object({
				id: z.string(),
				entityId: z.union([z.null(), z.string()]),
				featureKey: z.string(),
				topupKey: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				thresholdQuantity: z.string(),
				status: z.enum(["ready", "suspended", "cooldown"]),
				cooldownUntil: z.union([z.null(), z.string()]),
				consecutiveFailures: z.number(),
				active: z.boolean(),
			}),
		]),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdAutoTopupResponse200");

export const postV1AdminAutoTopupsByBillingAccountIdByPolicyIdResetResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			entityId: z.union([z.null(), z.string()]),
			featureKey: z.string(),
			topupKey: z.string(),
			provider: z.enum(["google", "apple", "stripe"]),
			thresholdQuantity: z.string(),
			status: z.enum(["ready", "suspended", "cooldown"]),
			cooldownUntil: z.union([z.null(), z.string()]),
			consecutiveFailures: z.number(),
			active: z.boolean(),
		}),
	})
	.openapi("postV1AdminAutoTopupsByBillingAccountIdByPolicyIdResetResponse200");

export const postV1AdminContractsPreviewResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			previewToken: z.string(),
			billingAccountId: z.string(),
			contractKey: z.string(),
			version: z.number(),
			planVersionId: z.string(),
			expiresAt: z.string(),
			controls: z.number(),
		}),
	})
	.openapi("postV1AdminContractsPreviewResponse200");

export const postV1AdminContractsPublishResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			contractKey: z.string(),
			version: z.number(),
			status: z.enum(["expired", "published", "terminated"]),
			planVersionId: z.string(),
			effectiveAt: z.string(),
			expiresAt: z.union([z.null(), z.string()]),
			publishedAt: z.string(),
		}),
	})
	.openapi("postV1AdminContractsPublishResponse200");

export const getV1AdminContractsByBillingAccountIdResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				contractKey: z.string(),
				version: z.number(),
				status: z.enum(["expired", "published", "terminated"]),
				planVersionId: z.string(),
				effectiveAt: z.string(),
				expiresAt: z.union([z.null(), z.string()]),
				publishedAt: z.string(),
			}),
		),
	})
	.openapi("getV1AdminContractsByBillingAccountIdResponse200");

export const deleteV1AdminContractsByBillingAccountIdByContractIdResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			contractKey: z.string(),
			version: z.number(),
			status: z.enum(["expired", "published", "terminated"]),
			planVersionId: z.string(),
			effectiveAt: z.string(),
			expiresAt: z.union([z.null(), z.string()]),
			publishedAt: z.string(),
		}),
	})
	.openapi("deleteV1AdminContractsByBillingAccountIdByContractIdResponse200");

export const postV1AdminCatalogMigrationsPreviewResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			previewToken: z.string(),
			fromPlanVersionId: z.string(),
			toPlanVersionId: z.string(),
			matchingSubscriptions: z.number(),
			expiresAt: z.string(),
		}),
	})
	.openapi("postV1AdminCatalogMigrationsPreviewResponse200");

export const postV1AdminCatalogMigrationsPublishResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			queued: z.number(),
			duplicate: z.boolean(),
			previewToken: z.string(),
			fromPlanVersionId: z.string(),
			toPlanVersionId: z.string(),
			matchingSubscriptions: z.number(),
			expiresAt: z.string(),
		}),
	})
	.openapi("postV1AdminCatalogMigrationsPublishResponse200");

export const getV1BillingAccountsByBillingAccountIdLicensePoolsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				externalSubscriptionId: z.string(),
				featureKey: z.string(),
				quantity: z.number(),
				assignedQuantity: z.number(),
				availableQuantity: z.number(),
				active: z.boolean(),
			}),
		),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdLicensePoolsResponse200");

export const postV1BillingAccountsByBillingAccountIdLicenseAssignmentsResponse201Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			poolId: z.string(),
			entityId: z.string(),
			quantity: z.number(),
			assignedAt: z.string(),
			revokedAt: z.union([z.null(), z.string()]),
		}),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdLicenseAssignmentsResponse201");

export const deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentIdResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.object({
				id: z.string(),
				poolId: z.string(),
				entityId: z.string(),
				quantity: z.number(),
				assignedAt: z.string(),
				revokedAt: z.union([z.null(), z.string()]),
			}),
		})
		.openapi(
			"deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentIdResponse200",
		);

export const getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKeyResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.object({
				entityId: z.string(),
				featureKey: z.string(),
				requiredQuantity: z.number(),
				assignedQuantity: z.number(),
				allowed: z.boolean(),
			}),
		})
		.openapi(
			"getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKeyResponse200",
		);
