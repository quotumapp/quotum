import { z } from "@hono/zod-openapi";
export const StripeBillingAccountSummarySchema = z
	.object({
		schemaVersion: z.literal(1),
		customerExists: z.boolean(),
		subscriptions: z.array(
			z.object({
				id: z.string(),
				plan: z.string(),
				status: z.enum(["trialing", "active", "past_due", "unpaid", "cancelled"]),
				currentPeriodStart: z.union([z.null(), z.string()]),
				currentPeriodEnd: z.union([z.null(), z.string()]),
				cancelAtPeriodEnd: z.boolean(),
			}),
		),
		recentInvoices: z.array(
			z.object({
				id: z.string(),
				status: z.enum(["draft", "open", "paid", "uncollectible", "void", "unknown"]),
				amountPaidCents: z.number(),
				currency: z.string(),
				paidAt: z.union([z.null(), z.string()]),
				createdAt: z.string(),
			}),
		),
	})
	.openapi("StripeBillingAccountSummary");
export const SubscriptionChangeOperationSchema = z
	.object({
		changeId: z.string(),
		projectInstanceId: z.string(),
		projectKey: z.string(),
		status: z.enum(["cancelled", "pending", "processing", "applied", "failed"]),
		changeKind: z.enum(["upgrade", "downgrade", "quantity"]),
		effectiveMode: z.enum(["immediate", "period_end"]),
		effectiveAt: z.string(),
		prorationBehavior: z.enum(["always_invoice", "create_prorations", "none"]),
		externalSubscriptionId: z.string(),
		targetPlanVersionId: z.string(),
		items: z.array(
			z.object({
				providerSubscriptionItemId: z.string().optional(),
				externalPriceId: z.string().optional(),
				quantity: z.number().optional(),
				deleted: z.literal(true).optional(),
			}),
		),
	})
	.openapi("SubscriptionChangeOperation");
export const EntitlementSnapshotSchema = z
	.object({
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
	})
	.openapi("EntitlementSnapshot");
export const AppleWebhookResultSchema = z
	.object({
		status: z.enum(["processed", "skipped", "ignored"]),
		entitlements: z.union([
			z.null(),
			z.object({
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
		]),
	})
	.openapi("AppleWebhookResult");
export const GoogleWebhookResultSchema = z
	.object({
		processed: z.boolean(),
		eventType: z.string(),
		messageId: z.string(),
		entitlements: z
			.union([
				z.null(),
				z.object({
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
			])
			.optional(),
	})
	.openapi("GoogleWebhookResult");
