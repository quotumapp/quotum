import { z } from "zod";
import { billingProviderValues } from "./provider-enum";
import { checkSchema, consumeSchema, envelope } from "./usage-api";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1BillingAccountsByBillingAccountIdBalancesByFeatureKeyResponse200Schema = z.object(
	{
		success: z.literal(true),
		data: z.object({
			featureKey: z.string(),
			unit: z.string(),
			scale: z.number(),
			granted: z.union([z.null(), z.string()]),
			consumed: z.string(),
			held: z.string(),
			available: z.union([z.null(), z.string()]),
			unlimited: z.literal(true).optional(),
			/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
			scope: z.enum(["account", "entity"]).optional(),
			windowStartAt: z.string().optional(),
			windowEndAt: z.string().optional(),
			breakdown: z.array(
				z.object({
					allocationId: z.string(),
					entityId: z.union([z.null(), z.string()]),
					sourceKind: z.string(),
					sourceKey: z.string(),
					rolloverOriginAllocationId: z.union([z.null(), z.string()]),
					carryOverOriginAllocationId: z.union([z.null(), z.string()]),
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
	},
);

const legacyOperationResponseSchema = z.object({
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
					available: z.union([z.null(), z.string()]),
					consumed: z.string(),
					held: z.string(),
					unlimited: z.literal(true).optional(),
				}),
			}),
			completedAt: z.string(),
		}),
	]),
});

export const getV1BillingAccountsByBillingAccountIdUsageOperationsByOperationByOperationIdResponse200Schema =
	envelope(
		z.union([
			legacyOperationResponseSchema.shape.data.options[0],
			legacyOperationResponseSchema.shape.data.options[1].extend({
				outcome: z.union([
					consumeSchema,
					legacyOperationResponseSchema.shape.data.options[1].shape.outcome,
				]),
			}),
		]),
	);

export const postV1BillingAccountsByBillingAccountIdUsageCheckResponse200Schema =
	envelope(checkSchema);
export const postV1BillingAccountsByBillingAccountIdUsageConsumeResponse200Schema =
	envelope(consumeSchema);

export const postV1BillingAccountsByBillingAccountIdUsageReservationsResponse200Schema = z.object({
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
			granted: z.union([z.null(), z.string()]),
			consumed: z.string(),
			held: z.string(),
			available: z.union([z.null(), z.string()]),
			unlimited: z.literal(true).optional(),
			/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
			scope: z.enum(["account", "entity"]).optional(),
			windowStartAt: z.string().optional(),
			windowEndAt: z.string().optional(),
			breakdown: z.array(
				z.object({
					allocationId: z.string(),
					entityId: z.union([z.null(), z.string()]),
					sourceKind: z.string(),
					sourceKey: z.string(),
					rolloverOriginAllocationId: z.union([z.null(), z.string()]),
					carryOverOriginAllocationId: z.union([z.null(), z.string()]),
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
				provider: z.enum(billingProviderValues("google")),
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
});

export const postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdConfirmResponse200Schema =
	z.object({
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
				granted: z.union([z.null(), z.string()]),
				consumed: z.string(),
				held: z.string(),
				available: z.union([z.null(), z.string()]),
				unlimited: z.literal(true).optional(),
				/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
				scope: z.enum(["account", "entity"]).optional(),
				windowStartAt: z.string().optional(),
				windowEndAt: z.string().optional(),
				breakdown: z.array(
					z.object({
						allocationId: z.string(),
						entityId: z.union([z.null(), z.string()]),
						sourceKind: z.string(),
						sourceKey: z.string(),
						rolloverOriginAllocationId: z.union([z.null(), z.string()]),
						carryOverOriginAllocationId: z.union([z.null(), z.string()]),
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
	});

export const postV1BillingAccountsByBillingAccountIdUsageReservationsByReservationIdReleaseResponse200Schema =
	z.object({
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
				granted: z.union([z.null(), z.string()]),
				consumed: z.string(),
				held: z.string(),
				available: z.union([z.null(), z.string()]),
				unlimited: z.literal(true).optional(),
				/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
				scope: z.enum(["account", "entity"]).optional(),
				windowStartAt: z.string().optional(),
				windowEndAt: z.string().optional(),
				breakdown: z.array(
					z.object({
						allocationId: z.string(),
						entityId: z.union([z.null(), z.string()]),
						sourceKind: z.string(),
						sourceKey: z.string(),
						rolloverOriginAllocationId: z.union([z.null(), z.string()]),
						carryOverOriginAllocationId: z.union([z.null(), z.string()]),
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
	});

export const postV1BillingAccountsByBillingAccountIdUsageEventsByUsageEventIdCorrectionsResponse200Schema =
	z.object({
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
				granted: z.union([z.null(), z.string()]),
				consumed: z.string(),
				held: z.string(),
				available: z.union([z.null(), z.string()]),
				unlimited: z.literal(true).optional(),
				/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
				scope: z.enum(["account", "entity"]).optional(),
				windowStartAt: z.string().optional(),
				windowEndAt: z.string().optional(),
				breakdown: z.array(
					z.object({
						allocationId: z.string(),
						entityId: z.union([z.null(), z.string()]),
						sourceKind: z.string(),
						sourceKey: z.string(),
						rolloverOriginAllocationId: z.union([z.null(), z.string()]),
						carryOverOriginAllocationId: z.union([z.null(), z.string()]),
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
	});
