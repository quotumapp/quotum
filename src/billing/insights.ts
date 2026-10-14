import type { SubscriptionPendingChange } from "../providers/capability-read-types";
import { isStorableInstant } from "../shared/input-bounds";
import type { BillingChannel, BillingProvider, SubscriptionStatus } from "./types";

/**
 * `recordedAt` is the exact `recorded_at` of the last event on the page, to the microsecond, so a
 * page boundary inside one millisecond neither skips nor repeats events. Cursors issued before
 * that carry milliseconds only and still decode; they resume at the truncated instant.
 */
export interface UsageEventCursor {
	recordedAt: string;
	id: string;
}

export interface UsageEventListInput {
	billingAccountId: string;
	featureKey?: string;
	entityId?: string;
	operation?: "consume" | "confirm" | "correction";
	from: Date;
	to: Date;
	limit: number;
	cursor: UsageEventCursor | null;
}

export interface UsageEventItem {
	id: string;
	recordedAt: string;
	occurredAt: string | null;
	effectiveAt: string;
	operation: "consume" | "confirm" | "correction";
	featureKey: string;
	featureUnit: string;
	entityId: string | null;
	quantity: string;
	walletQuantity: string;
	filterKey: string | null;
	metadata: Record<string, unknown>;
}

export interface UsageEventPage {
	items: UsageEventItem[];
	nextCursor: UsageEventCursor | null;
}

export interface ProjectUsageEventListInput {
	billingAccountId?: string;
	featureKey?: string;
	entityId?: string;
	operation?: "consume" | "confirm" | "correction";
	from: Date;
	to: Date;
	limit: number;
	cursor: UsageEventCursor | null;
}

export interface ProjectUsageEventItem extends UsageEventItem {
	customerId: string;
	billingAccountId: string;
	customerEmail: string | null;
}

export interface ProjectUsageEventPage {
	items: ProjectUsageEventItem[];
	nextCursor: UsageEventCursor | null;
}

export interface UsageSeriesInput {
	billingAccountId: string;
	featureKey?: string;
	from: Date;
	to: Date;
	interval: "hour" | "day";
}

export interface UsageSeriesPoint {
	periodStart: string;
	featureKey: string;
	featureUnit: string;
	quantity: string;
	walletQuantity: string;
	eventCount: number;
}

export interface CustomerBillingSummary {
	schemaVersion: 1;
	billingAccountId: string;
	customerExists: boolean;
	generatedAt: string;
	subscriptions: Array<{
		id: string;
		provider: BillingProvider;
		planKey: string | null;
		status: string;
		currentPeriodStart: string | null;
		currentPeriodEnd: string | null;
		cancelAtPeriodEnd: boolean;
	}>;
	/**
	 * Wallet balances, then each meter-limited feature's current window. A meter-limit row carries
	 * its `scope` and window bounds (PC-12); an unlimited quota reports `unlimited: true` and a null
	 * `available`.
	 */
	balances: Array<{
		featureKey: string;
		unit: string;
		available: string | null;
		held: string;
		expiresAt: string | null;
		unlimited?: true;
		scope?: "account" | "entity";
		windowStartAt?: string;
		windowEndAt?: string;
	}>;
	usage: Array<{
		featureKey: string;
		unit: string;
		quantity: string;
		windowStart: string;
		windowEnd: string;
	}>;
	recentInvoices: Array<{
		id: string;
		externalInvoiceId: string;
		status: string;
		amountPaidMinor: number;
		currency: string;
		paidAt: string | null;
		createdAt: string;
	}>;
}

export const invoiceStatusValues = ["draft", "open", "paid", "uncollectible", "void"] as const;
export type InvoiceStatus = (typeof invoiceStatusValues)[number];

/** `createdAt` is the exact `provider_created_at` of the last invoice on the page, to the microsecond. */
export interface InvoiceCursor {
	createdAt: string;
	id: string;
}

export interface InvoiceListInput {
	billingAccountId: string;
	status?: InvoiceStatus;
	limit: number;
	cursor: InvoiceCursor | null;
}

/**
 * One mirrored provider invoice. The columns are always present; the payload-derived fields are
 * null for a row whose payload was scrubbed by customer erasure or that lacks the field.
 */
export interface InvoiceItem {
	id: string;
	externalInvoiceId: string;
	/**
	 * `subscription` rows are recorded from the provider's invoice events and carry its payload;
	 * `auto_topup` rows are recorded when an automatic top-up settles and carry only the columns.
	 */
	kind: "subscription" | "auto_topup";
	subscriptionId: string | null;
	externalSubscriptionId: string | null;
	status: string;
	number: string | null;
	currency: string;
	amountPaidMinor: number;
	totalMinor: number | null;
	amountDueMinor: number | null;
	periodStart: string | null;
	periodEnd: string | null;
	paidAt: string | null;
	/** The invoice's creation time at the provider; the list is ordered by it. */
	createdAt: string;
}

export interface InvoiceLine {
	id: string | null;
	description: string | null;
	amountMinor: number | null;
	quantity: number | null;
	periodStart: string | null;
	periodEnd: string | null;
	externalPriceId: string | null;
	externalProductId: string | null;
	proration: boolean | null;
}

export interface InvoiceDetail extends InvoiceItem {
	/** The lines the stored provider event carried; the provider truncates long invoices. */
	lines: InvoiceLine[];
	linesTruncated: boolean;
	/** Bearer links: present only for a full project credential. */
	hostedInvoiceUrl: string | null;
	invoicePdfUrl: string | null;
}

export interface InvoicePage {
	items: InvoiceItem[];
	nextCursor: InvoiceCursor | null;
}

/** The detail a caller without a full project credential may see: no bearer links. */
export function withoutInvoiceLinks(invoice: InvoiceDetail): InvoiceDetail {
	return { ...invoice, hostedInvoiceUrl: null, invoicePdfUrl: null };
}

/** The persisted facts the available-actions read evaluates; no provider is asked. */
export interface AvailableActionFacts {
	customerExists: boolean;
	/** Live subscriptions only: not expired, refunded or revoked and not past `expires_at`. */
	subscriptions: Array<{
		externalSubscriptionId: string;
		provider: BillingProvider;
		channel: BillingChannel;
		status: SubscriptionStatus;
		planKey: string | null;
		currentPeriodEnd: string | null;
		cancelAtPeriodEnd: boolean;
		pendingChange: SubscriptionPendingChange | null;
	}>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const microsecondInstantPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

export function encodeUsageCursor(cursor: UsageEventCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeUsageCursor(value: string): UsageEventCursor | null {
	if (!base64UrlPattern.test(value)) return null;
	try {
		const decoded = Buffer.from(value, "base64url");
		if (decoded.toString("base64url") !== value) return null;
		const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"recordedAt" in parsed &&
			typeof parsed.recordedAt === "string" &&
			canonicalCursorInstant(parsed.recordedAt) &&
			"id" in parsed &&
			typeof parsed.id === "string" &&
			uuidPattern.test(parsed.id)
		) {
			return { recordedAt: parsed.recordedAt, id: parsed.id };
		}
	} catch {
		return null;
	}
	return null;
}

export function encodeInvoiceCursor(cursor: InvoiceCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeInvoiceCursor(value: string): InvoiceCursor | null {
	if (!base64UrlPattern.test(value)) return null;
	try {
		const decoded = Buffer.from(value, "base64url");
		if (decoded.toString("base64url") !== value) return null;
		const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"createdAt" in parsed &&
			typeof parsed.createdAt === "string" &&
			canonicalCursorInstant(parsed.createdAt) &&
			"id" in parsed &&
			typeof parsed.id === "string" &&
			uuidPattern.test(parsed.id)
		) {
			return { createdAt: parsed.createdAt, id: parsed.id };
		}
	} catch {
		return null;
	}
	return null;
}

function canonicalCursorInstant(value: string): boolean {
	const microseconds = microsecondInstantPattern.exec(value);
	return canonicalDate(microseconds === null ? value : `${microseconds[1]}Z`);
}

function canonicalDate(value: string): boolean {
	try {
		const date = new Date(value);
		return isStorableInstant(date) && date.toISOString() === value;
	} catch {
		return false;
	}
}
