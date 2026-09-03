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
		provider: "apple" | "google" | "stripe";
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
