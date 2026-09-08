import { z } from "@hono/zod-openapi";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1BillingAccountsByBillingAccountIdBillingSummaryResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			schemaVersion: z.literal(1),
			billingAccountId: z.string(),
			customerExists: z.boolean(),
			generatedAt: z.string(),
			subscriptions: z.array(
				z.object({
					id: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					planKey: z.union([z.null(), z.string()]),
					status: z.string(),
					currentPeriodStart: z.union([z.null(), z.string()]),
					currentPeriodEnd: z.union([z.null(), z.string()]),
					cancelAtPeriodEnd: z.boolean(),
				}),
			),
			balances: z.array(
				z.object({
					featureKey: z.string(),
					unit: z.string(),
					available: z.string(),
					held: z.string(),
					expiresAt: z.union([z.null(), z.string()]),
				}),
			),
			usage: z.array(
				z.object({
					featureKey: z.string(),
					unit: z.string(),
					quantity: z.string(),
					windowStart: z.string(),
					windowEnd: z.string(),
				}),
			),
			recentInvoices: z.array(
				z.object({
					id: z.string(),
					externalInvoiceId: z.string(),
					status: z.string(),
					amountPaidMinor: z.number(),
					currency: z.string(),
					paidAt: z.union([z.null(), z.string()]),
					createdAt: z.string(),
				}),
			),
		}),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdBillingSummaryResponse200");

export const getV1BillingAccountsByBillingAccountIdUsageEventsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				recordedAt: z.string(),
				occurredAt: z.union([z.null(), z.string()]),
				effectiveAt: z.string(),
				operation: z.enum(["consume", "confirm", "correction"]),
				featureKey: z.string(),
				featureUnit: z.string(),
				entityId: z.union([z.null(), z.string()]),
				quantity: z.string(),
				walletQuantity: z.string(),
				filterKey: z.union([z.null(), z.string()]),
				metadata: z.record(z.string(), z.unknown()),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdUsageEventsResponse200");

export const getV1BillingAccountsByBillingAccountIdUsageSeriesResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				periodStart: z.string(),
				featureKey: z.string(),
				featureUnit: z.string(),
				quantity: z.string(),
				walletQuantity: z.string(),
				eventCount: z.number(),
			}),
		),
		meta: z.object({ from: z.string(), to: z.string(), interval: z.enum(["hour", "day"]) }),
	})
	.openapi("getV1BillingAccountsByBillingAccountIdUsageSeriesResponse200");
