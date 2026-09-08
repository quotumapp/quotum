import { z } from "@hono/zod-openapi";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1BillingAccountsByBillingAccountIdBalancesByFeatureKeyResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			featureKey: z.string(),
			unit: z.string(),
			scale: z.number(),
			granted: z.string(),
			consumed: z.string(),
			held: z.string(),
			available: z.string(),
			breakdown: z.array(
				z.object({
					allocationId: z.string(),
					entityId: z.union([z.null(), z.string()]),
					sourceKind: z.string(),
					sourceKey: z.string(),
					rolloverOriginAllocationId: z.union([z.null(), z.string()]),
					rolloverPolicyRevision: z.union([z.null(), z.number()]),
					quantity: z.string(),
					reversed: z.string(),
					consumed: z.string(),
					held: z.string(),
					available: z.string(),
					periodStartAt: z.union([z.null(), z.string()]),
					periodEndAt: z.union([z.null(), z.string()]),
					expiresAt: z.union([z.null(), z.string()]),
					createdAt: z.string(),
				}),
			),
		}),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdBalancesByFeatureKeyResponse200");

export const getV1BillingAccountsByBillingAccountIdUsageOperationsByOperationByOperationIdResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.union([
				z.object({
					operation: z.enum(["consume", "confirm", "reserve", "release", "correct"]),
					operationId: z.string(),
					status: z.literal("processing"),
					outcome: z.null(),
					completedAt: z.null(),
				}),
				z.object({
					operation: z.enum(["consume", "confirm", "reserve", "release", "correct"]),
					operationId: z.string(),
					status: z.literal("completed"),
					outcome: z.object({
						allowed: z.boolean(),
						reason: z.string(),
						usageEventId: z.union([z.null(), z.string()]),
						recordedAt: z.union([z.null(), z.string()]),
						reservationId: z.union([z.null(), z.string()]),
						reservationStatus: z.union([z.null(), z.string()]),
						expiresAt: z.union([z.null(), z.string()]),
						quantity: z.union([z.null(), z.string()]),
						walletQuantity: z.union([z.null(), z.string()]),
						originalUsageEventId: z.union([z.null(), z.string()]),
						originalRecordedAt: z.union([z.null(), z.string()]),
						balance: z.object({
							featureKey: z.string(),
							available: z.string(),
							consumed: z.string(),
							held: z.string(),
						}),
					}),
					completedAt: z.string(),
				}),
			]),
		})
		.openapi(
			"getV1BillingAccountsByBillingAccountIdUsageOperationsByOperationByOperationIdResponse200",
		);

export const postV1BillingAccountsByBillingAccountIdUsageCheckResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			allowed: z.boolean(),
			reason: z.enum([
				"allowed",
				"insufficient_balance",
				"control_limit_exceeded",
				"configuration_error",
			]),
			requestedQuantity: z.string(),
			walletQuantity: z.string(),
			balance: z.object({
				featureKey: z.string(),
				unit: z.string(),
				scale: z.number(),
				granted: z.string(),
				consumed: z.string(),
				held: z.string(),
				available: z.string(),
				breakdown: z.array(
					z.object({
						allocationId: z.string(),
						entityId: z.union([z.null(), z.string()]),
						sourceKind: z.string(),
						sourceKey: z.string(),
						rolloverOriginAllocationId: z.union([z.null(), z.string()]),
						rolloverPolicyRevision: z.union([z.null(), z.number()]),
						quantity: z.string(),
						reversed: z.string(),
						consumed: z.string(),
						held: z.string(),
						available: z.string(),
						periodStartAt: z.union([z.null(), z.string()]),
						periodEndAt: z.union([z.null(), z.string()]),
						expiresAt: z.union([z.null(), z.string()]),
						createdAt: z.string(),
					}),
				),
			}),
			rateCard: z.object({
				path: z.enum(["direct", "pinned", "additive"]),
				revision: z.union([z.null(), z.number()]),
				revisionId: z.union([z.null(), z.string()]),
				entryId: z.union([z.null(), z.string()]),
				meterFeatureKey: z.string(),
				walletFeatureKey: z.string(),
				pricingModel: z.enum(["flat", "graduated"]),
				ratePerUnit: z.string(),
				tiers: z.array(
					z.object({ upToQuantity: z.union([z.null(), z.string()]), ratePerUnit: z.string() }),
				),
			}),
			eligiblePurchaseActions: z.array(
				z.object({
					provider: z.enum(["google", "apple", "stripe"]),
					action: z.enum(["purchase_required", "provider_action_required"]),
				}),
			),
			control: z.union([
				z.null(),
				z.object({
					kind: z.enum(["spend_limit", "usage_limit"]),
					source: z.enum(["account", "entity", "plan_default", "contract"]),
					revision: z.number(),
					policyId: z.string(),
					limitValue: z.string(),
					currentValue: z.string(),
					requestedValue: z.string(),
					remainingValue: z.string(),
				}),
			]),
		}),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdUsageCheckResponse200");

export const postV1BillingAccountsByBillingAccountIdUsageConsumeResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			usageEventId: z.union([z.null(), z.string()]),
			recordedAt: z.union([z.null(), z.string()]),
			deductions: z.array(
				z.object({
					allocationId: z.string(),
					quantity: z.string(),
					sourceKind: z.string(),
					sourceKey: z.string(),
					expiresAt: z.union([z.null(), z.string()]),
				}),
			),
			allowed: z.boolean(),
			reason: z.enum([
				"allowed",
				"insufficient_balance",
				"control_limit_exceeded",
				"configuration_error",
			]),
			requestedQuantity: z.string(),
			walletQuantity: z.string(),
			balance: z.object({
				featureKey: z.string(),
				unit: z.string(),
				scale: z.number(),
				granted: z.string(),
				consumed: z.string(),
				held: z.string(),
				available: z.string(),
				breakdown: z.array(
					z.object({
						allocationId: z.string(),
						entityId: z.union([z.null(), z.string()]),
						sourceKind: z.string(),
						sourceKey: z.string(),
						rolloverOriginAllocationId: z.union([z.null(), z.string()]),
						rolloverPolicyRevision: z.union([z.null(), z.number()]),
						quantity: z.string(),
						reversed: z.string(),
						consumed: z.string(),
						held: z.string(),
						available: z.string(),
						periodStartAt: z.union([z.null(), z.string()]),
						periodEndAt: z.union([z.null(), z.string()]),
						expiresAt: z.union([z.null(), z.string()]),
						createdAt: z.string(),
					}),
				),
			}),
			rateCard: z.object({
				path: z.enum(["direct", "pinned", "additive"]),
				revision: z.union([z.null(), z.number()]),
				revisionId: z.union([z.null(), z.string()]),
				entryId: z.union([z.null(), z.string()]),
				meterFeatureKey: z.string(),
				walletFeatureKey: z.string(),
				pricingModel: z.enum(["flat", "graduated"]),
				ratePerUnit: z.string(),
				tiers: z.array(
					z.object({ upToQuantity: z.union([z.null(), z.string()]), ratePerUnit: z.string() }),
				),
			}),
			eligiblePurchaseActions: z.array(
				z.object({
					provider: z.enum(["google", "apple", "stripe"]),
					action: z.enum(["purchase_required", "provider_action_required"]),
				}),
			),
			control: z.union([
				z.null(),
				z.object({
					kind: z.enum(["spend_limit", "usage_limit"]),
					source: z.enum(["account", "entity", "plan_default", "contract"]),
					revision: z.number(),
					policyId: z.string(),
					limitValue: z.string(),
					currentValue: z.string(),
					requestedValue: z.string(),
					remainingValue: z.string(),
				}),
			]),
		}),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdUsageConsumeResponse200");

export const postV1BillingAccountsByBillingAccountIdUsageReservationsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			reservationId: z.union([z.null(), z.string()]),
			status: z.union([
				z.null(),
				z.literal("active"),
				z.literal("expired"),
				z.literal("confirmed"),
				z.literal("released"),
			]),
			expiresAt: z.union([z.null(), z.string()]),
			deductions: z.array(
				z.object({
					allocationId: z.string(),
					quantity: z.string(),
					sourceKind: z.string(),
					sourceKey: z.string(),
					expiresAt: z.union([z.null(), z.string()]),
				}),
			),
			allowed: z.boolean(),
			reason: z.enum([
				"allowed",
				"insufficient_balance",
				"control_limit_exceeded",
				"configuration_error",
			]),
			requestedQuantity: z.string(),
			walletQuantity: z.string(),
			balance: z.object({
				featureKey: z.string(),
				unit: z.string(),
				scale: z.number(),
				granted: z.string(),
				consumed: z.string(),
				held: z.string(),
				available: z.string(),
				breakdown: z.array(
					z.object({
						allocationId: z.string(),
						entityId: z.union([z.null(), z.string()]),
						sourceKind: z.string(),
						sourceKey: z.string(),
						rolloverOriginAllocationId: z.union([z.null(), z.string()]),
						rolloverPolicyRevision: z.union([z.null(), z.number()]),
						quantity: z.string(),
						reversed: z.string(),
						consumed: z.string(),
						held: z.string(),
						available: z.string(),
						periodStartAt: z.union([z.null(), z.string()]),
						periodEndAt: z.union([z.null(), z.string()]),
						expiresAt: z.union([z.null(), z.string()]),
						createdAt: z.string(),
					}),
				),
			}),
			rateCard: z.object({
				path: z.enum(["direct", "pinned", "additive"]),
				revision: z.union([z.null(), z.number()]),
				revisionId: z.union([z.null(), z.string()]),
				entryId: z.union([z.null(), z.string()]),
				meterFeatureKey: z.string(),
				walletFeatureKey: z.string(),
				pricingModel: z.enum(["flat", "graduated"]),
				ratePerUnit: z.string(),
				tiers: z.array(
					z.object({ upToQuantity: z.union([z.null(), z.string()]), ratePerUnit: z.string() }),
				),
			}),
			eligiblePurchaseActions: z.array(
				z.object({
					provider: z.enum(["google", "apple", "stripe"]),
					action: z.enum(["purchase_required", "provider_action_required"]),
				}),
			),
			control: z.union([
				z.null(),
				z.object({
					kind: z.enum(["spend_limit", "usage_limit"]),
					source: z.enum(["account", "entity", "plan_default", "contract"]),
					revision: z.number(),
					policyId: z.string(),
					limitValue: z.string(),
					currentValue: z.string(),
					requestedValue: z.string(),
					remainingValue: z.string(),
				}),
			]),
		}),
	})
	.openapi("postV1BillingAccountsByBillingAccountIdUsageReservationsResponse200");

export const postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdConfirmResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.object({
				allowed: z.boolean(),
				reason: z.enum([
					"allowed",
					"insufficient_balance",
					"control_limit_exceeded",
					"reservation_expired",
				]),
				reservationId: z.string(),
				status: z.enum(["active", "expired", "confirmed", "released"]),
				usageEventId: z.union([z.null(), z.string()]),
				recordedAt: z.union([z.null(), z.string()]),
				balance: z.object({
					featureKey: z.string(),
					unit: z.string(),
					scale: z.number(),
					granted: z.string(),
					consumed: z.string(),
					held: z.string(),
					available: z.string(),
					breakdown: z.array(
						z.object({
							allocationId: z.string(),
							entityId: z.union([z.null(), z.string()]),
							sourceKind: z.string(),
							sourceKey: z.string(),
							rolloverOriginAllocationId: z.union([z.null(), z.string()]),
							rolloverPolicyRevision: z.union([z.null(), z.number()]),
							quantity: z.string(),
							reversed: z.string(),
							consumed: z.string(),
							held: z.string(),
							available: z.string(),
							periodStartAt: z.union([z.null(), z.string()]),
							periodEndAt: z.union([z.null(), z.string()]),
							expiresAt: z.union([z.null(), z.string()]),
							createdAt: z.string(),
						}),
					),
				}),
				deductions: z.array(
					z.object({
						allocationId: z.string(),
						quantity: z.string(),
						sourceKind: z.string(),
						sourceKey: z.string(),
						expiresAt: z.union([z.null(), z.string()]),
					}),
				),
				control: z
					.union([
						z.null(),
						z.object({
							kind: z.enum(["spend_limit", "usage_limit"]),
							source: z.enum(["account", "entity", "plan_default", "contract"]),
							revision: z.number(),
							policyId: z.string(),
							limitValue: z.string(),
							currentValue: z.string(),
							requestedValue: z.string(),
							remainingValue: z.string(),
						}),
					])
					.optional(),
			}),
		})
		.openapi(
			"postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdConfirmResponse200",
		);

export const postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdReleaseResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.object({
				allowed: z.boolean(),
				reason: z.enum([
					"allowed",
					"insufficient_balance",
					"control_limit_exceeded",
					"reservation_expired",
				]),
				reservationId: z.string(),
				status: z.enum(["active", "expired", "confirmed", "released"]),
				usageEventId: z.union([z.null(), z.string()]),
				recordedAt: z.union([z.null(), z.string()]),
				balance: z.object({
					featureKey: z.string(),
					unit: z.string(),
					scale: z.number(),
					granted: z.string(),
					consumed: z.string(),
					held: z.string(),
					available: z.string(),
					breakdown: z.array(
						z.object({
							allocationId: z.string(),
							entityId: z.union([z.null(), z.string()]),
							sourceKind: z.string(),
							sourceKey: z.string(),
							rolloverOriginAllocationId: z.union([z.null(), z.string()]),
							rolloverPolicyRevision: z.union([z.null(), z.number()]),
							quantity: z.string(),
							reversed: z.string(),
							consumed: z.string(),
							held: z.string(),
							available: z.string(),
							periodStartAt: z.union([z.null(), z.string()]),
							periodEndAt: z.union([z.null(), z.string()]),
							expiresAt: z.union([z.null(), z.string()]),
							createdAt: z.string(),
						}),
					),
				}),
				deductions: z.array(
					z.object({
						allocationId: z.string(),
						quantity: z.string(),
						sourceKind: z.string(),
						sourceKey: z.string(),
						expiresAt: z.union([z.null(), z.string()]),
					}),
				),
				control: z
					.union([
						z.null(),
						z.object({
							kind: z.enum(["spend_limit", "usage_limit"]),
							source: z.enum(["account", "entity", "plan_default", "contract"]),
							revision: z.number(),
							policyId: z.string(),
							limitValue: z.string(),
							currentValue: z.string(),
							requestedValue: z.string(),
							remainingValue: z.string(),
						}),
					])
					.optional(),
			}),
		})
		.openapi(
			"postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdReleaseResponse200",
		);

export const postV1BillingAccountsByBillingAccountIdUsageEventsByUsageEventIdCorrectionsResponse200Schema =
	z
		.object({
			success: z.literal(true),
			data: z.object({
				usageEventId: z.string(),
				recordedAt: z.string(),
				originalUsageEventId: z.string(),
				originalRecordedAt: z.string(),
				quantity: z.string(),
				walletQuantity: z.string(),
				balance: z.object({
					featureKey: z.string(),
					unit: z.string(),
					scale: z.number(),
					granted: z.string(),
					consumed: z.string(),
					held: z.string(),
					available: z.string(),
					breakdown: z.array(
						z.object({
							allocationId: z.string(),
							entityId: z.union([z.null(), z.string()]),
							sourceKind: z.string(),
							sourceKey: z.string(),
							rolloverOriginAllocationId: z.union([z.null(), z.string()]),
							rolloverPolicyRevision: z.union([z.null(), z.number()]),
							quantity: z.string(),
							reversed: z.string(),
							consumed: z.string(),
							held: z.string(),
							available: z.string(),
							periodStartAt: z.union([z.null(), z.string()]),
							periodEndAt: z.union([z.null(), z.string()]),
							expiresAt: z.union([z.null(), z.string()]),
							createdAt: z.string(),
						}),
					),
				}),
				deductions: z.array(
					z.object({
						allocationId: z.string(),
						quantity: z.string(),
						sourceKind: z.string(),
						sourceKey: z.string(),
						expiresAt: z.union([z.null(), z.string()]),
					}),
				),
			}),
		})
		.openapi(
			"postV1BillingAccountsByBillingAccountIdUsageEventsByUsageEventIdCorrectionsResponse200",
		);
