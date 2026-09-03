import type { PurchaseStatus } from "../../billing/types";

export function isInvalidatedStatus(status: PurchaseStatus): boolean {
	return status === "refunded" || status === "revoked" || status === "voided";
}

export function stripNulls<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(
			([, entryValue]) => entryValue !== null && entryValue !== undefined,
		),
	) as T;
}

export function requireNonBlank(value: string | null | undefined, name: string): void {
	if (value === null || value === undefined || value.trim() === "") {
		throw new Error(`${name} must not be blank`);
	}
}

export function requirePositiveLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error("p_limit must be greater than zero");
	}
	return Math.min(limit, 100);
}

export function requireStripeCustomerId(value: string): void {
	requireNonBlank(value, "p_stripe_customer_id");
	if (!value.startsWith("cus_")) {
		throw new Error("p_stripe_customer_id must be a Stripe customer id");
	}
}

export function toIsoStringOrNull(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	return String(value);
}

export function toRequiredIsoString(value: unknown): string {
	return toIsoStringOrNull(value) ?? new Date().toISOString();
}

export function formatUtcTimestamp(value: unknown): string {
	const date = value instanceof Date ? value : new Date(String(value));
	if (!Number.isFinite(date.getTime())) {
		return String(value);
	}
	return date.toISOString();
}
