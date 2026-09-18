import type { SubscriptionPendingChange } from "../providers/capability-read-types";
import type { BillingChannel, BillingProvider, SubscriptionStatus } from "./types";

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
	balances: Array<{
		featureKey: string;
		unit: string;
		available: string;
		held: string;
		expiresAt: string | null;
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
			canonicalDate(parsed.recordedAt) &&
			"id" in parsed &&
			typeof parsed.id === "string" &&
			uuidPattern.test(parsed.id)
		) {
			return { recordedAt: new Date(parsed.recordedAt).toISOString(), id: parsed.id };
		}
	} catch {
		return null;
	}
	return null;
}

function canonicalDate(value: string): boolean {
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}
