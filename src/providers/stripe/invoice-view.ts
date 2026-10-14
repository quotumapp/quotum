import type { InvoiceLine } from "../../billing/insights";

/**
 * The fields of a stored Stripe invoice payload that the invoice reads expose. The payload is the
 * event body Stripe sent, so any field can be absent, and a customer erasure replaces it with `{}`.
 * Every field is therefore optional and nothing here throws.
 */
export interface StripeInvoiceView {
	number: string | null;
	totalMinor: number | null;
	amountDueMinor: number | null;
	/** The service period: earliest line start and latest line end. */
	periodStart: string | null;
	periodEnd: string | null;
	hostedInvoiceUrl: string | null;
	invoicePdfUrl: string | null;
	lines: InvoiceLine[];
	/** The event carried only the first page of lines. */
	linesTruncated: boolean;
}

export function stripeInvoiceView(payload: unknown): StripeInvoiceView {
	const invoice = optionalRecord(payload) ?? {};
	const linesPage = optionalRecord(invoice.lines);
	const lines = recordArray(linesPage?.data);
	// Invoice-level period fields describe the usage window (one period back for a subscription
	// invoice), so the service period comes from the lines, as the subscription normalizer reads it.
	const subscriptionLines = lines.filter((line) => !isInvoiceItemLine(line));
	const periodLines = subscriptionLines.length > 0 ? subscriptionLines : lines;
	const starts = periodLines.flatMap((line) => finiteSeconds(optionalRecord(line.period)?.start));
	const ends = periodLines.flatMap((line) => finiteSeconds(optionalRecord(line.period)?.end));
	return {
		number: optionalString(invoice.number),
		totalMinor: safeInteger(invoice.total),
		amountDueMinor: safeInteger(invoice.amount_due),
		periodStart: starts.length === 0 ? null : instant(Math.min(...starts)),
		periodEnd: ends.length === 0 ? null : instant(Math.max(...ends)),
		hostedInvoiceUrl: optionalString(invoice.hosted_invoice_url),
		invoicePdfUrl: optionalString(invoice.invoice_pdf),
		lines: lines.map(invoiceLine),
		linesTruncated: linesPage?.has_more === true,
	};
}

function invoiceLine(line: Record<string, unknown>): InvoiceLine {
	const period = optionalRecord(line.period);
	const price = optionalRecord(line.price);
	const pricingDetails = optionalRecord(optionalRecord(line.pricing)?.price_details);
	const subscriptionItemDetails = optionalRecord(
		optionalRecord(line.parent)?.subscription_item_details,
	);
	return {
		id: optionalString(line.id),
		description: optionalString(line.description),
		amountMinor: safeInteger(line.amount),
		quantity: safeInteger(line.quantity),
		periodStart: instant(period?.start),
		periodEnd: instant(period?.end),
		externalPriceId:
			optionalId(price) ?? optionalId(pricingDetails?.price) ?? optionalId(line.plan),
		externalProductId:
			optionalId(price?.product) ??
			optionalId(pricingDetails?.product) ??
			optionalId(optionalRecord(line.plan)?.product),
		proration:
			optionalBoolean(subscriptionItemDetails?.proration) ?? optionalBoolean(line.proration),
	};
}

function isInvoiceItemLine(line: Record<string, unknown>): boolean {
	const parent = optionalRecord(line.parent);
	const hasInvoiceItemParent = optionalRecord(parent?.invoice_item_details) !== null;
	const hasSubscriptionItemParent = optionalRecord(parent?.subscription_item_details) !== null;
	return (
		optionalString(line.type) === "invoiceitem" ||
		(hasInvoiceItemParent && !hasSubscriptionItemParent)
	);
}

function instant(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const date = new Date(value * 1000);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteSeconds(value: unknown): number[] {
	return typeof value === "number" && Number.isFinite(value) ? [value] : [];
}

function safeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalId(value: unknown): string | null {
	return optionalString(value) ?? optionalString(optionalRecord(value)?.id);
}

function optionalBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function recordArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is Record<string, unknown> => optionalRecord(item) !== null);
}
