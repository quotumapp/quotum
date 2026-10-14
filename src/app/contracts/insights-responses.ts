import { z } from "zod";
import { billingProviderValues } from "./provider-enum";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1BillingAccountsByBillingAccountIdBillingSummaryResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		schemaVersion: z.literal(1),
		billingAccountId: z.string(),
		customerExists: z.boolean(),
		generatedAt: z.string(),
		subscriptions: z.array(
			z.object({
				id: z.string(),
				provider: z.enum(billingProviderValues("google")),
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
				/** Null only when an unlimited usage source lifts the feature's cap. */
				available: z.union([z.null(), z.string()]),
				held: z.string(),
				expiresAt: z.union([z.null(), z.string()]),
				unlimited: z.literal(true).optional(),
				/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
				scope: z.enum(["account", "entity"]).optional(),
				windowStartAt: z.string().optional(),
				windowEndAt: z.string().optional(),
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
});

const usageEventItemSchema = z.object({
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
});

export const getV1BillingAccountsByBillingAccountIdUsageEventsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(usageEventItemSchema),
	pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
});

export const getV1AdminUsageEventsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(
		usageEventItemSchema.extend({
			customerId: z.string(),
			billingAccountId: z.string(),
			customerEmail: z.union([z.null(), z.string()]),
		}),
	),
	pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
});

export const getV1BillingAccountsByBillingAccountIdUsageSeriesResponse200Schema = z.object({
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
});

const nullableString = z.union([z.null(), z.string()]);
const nullableNumber = z.union([z.null(), z.number()]);

const invoiceItemSchema = z.object({
	id: z.string(),
	externalInvoiceId: z.string(),
	/** `auto_topup` rows are recorded at settlement and carry no provider payload fields. */
	kind: z.enum(["subscription", "auto_topup"]),
	subscriptionId: nullableString,
	externalSubscriptionId: nullableString,
	status: z.string(),
	number: nullableString,
	currency: z.string(),
	amountPaidMinor: z.number(),
	totalMinor: nullableNumber,
	amountDueMinor: nullableNumber,
	periodStart: nullableString,
	periodEnd: nullableString,
	paidAt: nullableString,
	/** The invoice's creation time at the provider; the list is ordered by it. */
	createdAt: z.string(),
});

const invoiceLineSchema = z.object({
	id: nullableString,
	description: nullableString,
	amountMinor: nullableNumber,
	quantity: nullableNumber,
	periodStart: nullableString,
	periodEnd: nullableString,
	externalPriceId: nullableString,
	externalProductId: nullableString,
	proration: z.union([z.null(), z.boolean()]),
});

export const getV1BillingAccountsByBillingAccountIdInvoicesResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(invoiceItemSchema),
	pagination: z.object({ nextCursor: nullableString }),
});

export const getV1BillingAccountsByBillingAccountIdInvoicesByInvoiceIdResponse200Schema = z.object({
	success: z.literal(true),
	data: invoiceItemSchema.extend({
		/** The lines the stored provider event carried; the provider truncates long invoices. */
		lines: z.array(invoiceLineSchema),
		linesTruncated: z.boolean(),
		/** Bearer links, null unless the request used a full project credential. */
		hostedInvoiceUrl: nullableString,
		invoicePdfUrl: nullableString,
	}),
});
