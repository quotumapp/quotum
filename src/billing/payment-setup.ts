/**
 * Hosted payment-method setup: saving a payment method for later off-session charges. A setup is
 * not a purchase. It creates no purchase, allocation, entitlement or invoice, and the only billing
 * state it changes is which payment method the provider charges by default.
 */

import { BillingError } from "./errors";
import type { BillingProvider } from "./types";

export const paymentSetupStatuses = [
	/** The hosted link is being created; the provider call may or may not have landed. */
	"creating",
	/** The link exists and the customer has not finished with it. */
	"awaiting_customer",
	/** The customer finished; the provider default-method write is still owed. */
	"applying_default",
	/** The default-method write is confirmed. */
	"completed",
	/** The link expired without a completed setup, confirmed against the provider. */
	"expired",
	/** Work remains that retries could not finish; the setup keeps the account's active slot. */
	"needs_attention",
] as const;
export type PaymentSetupStatus = (typeof paymentSetupStatuses)[number];

/**
 * The states that release a billing account's single active setup slot. Everything else, including
 * `needs_attention`, holds the slot so an unfinished setup stays visible instead of being replaced.
 */
export const resolvedPaymentSetupStatuses = ["completed", "expired"] as const;
export type ResolvedPaymentSetupStatus = (typeof resolvedPaymentSetupStatuses)[number];

export function isResolvedPaymentSetupStatus(
	status: PaymentSetupStatus,
): status is ResolvedPaymentSetupStatus {
	return (resolvedPaymentSetupStatuses as readonly PaymentSetupStatus[]).includes(status);
}

/** The card summary a completed setup may show; never a full number and never a token. */
export interface PaymentSetupCard {
	brand: string | null;
	last4: string | null;
	expMonth: number | null;
	expYear: number | null;
}

/** A persisted setup as the read route reports it; nothing here comes from a live provider call. */
export interface PaymentSetupSession {
	setupId: string;
	billingAccountId: string;
	provider: BillingProvider;
	status: PaymentSetupStatus;
	currency: string;
	/** The provider's hosted session id, absent only while the creating call is in flight. */
	sessionId: string | null;
	/** The hosted URL only while awaiting the customer and not expired. */
	url: string | null;
	expiresAt: string | null;
	completedAt: string | null;
	/** Present only after the default-method write is confirmed. */
	card: PaymentSetupCard | null;
	/** Why the setup needs attention, in operator-facing words; null otherwise. */
	attention: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The active setup a conflict names, so a caller can read or reuse it instead of retrying. */
export interface ActivePaymentSetupSummary {
	setupId: string;
	status: PaymentSetupStatus;
	expiresAt: string | null;
}

/**
 * A different setup request arrived while one is unresolved. The response names the active setup
 * so the caller can read it, reuse its link, or wait for it to expire.
 */
export function paymentSetupConflict(active: ActivePaymentSetupSummary): BillingError {
	return new BillingError(
		"A payment method setup is already in progress for this billing account",
		"PAYMENT_SETUP_ALREADY_ACTIVE",
		409,
		{ classification: "persistence_conflict", details: { paymentSetup: active } },
	);
}

export function paymentSetupNotFound(): BillingError {
	return new BillingError("Payment setup session was not found", "PAYMENT_SETUP_NOT_FOUND", 404, {
		classification: "not_found",
	});
}

/** Three-letter ISO 4217, lowercased for the provider, as the catalog stores currencies. */
export function normalizePaymentSetupCurrency(value: string): string {
	const currency = value.trim().toLowerCase();
	if (!/^[a-z]{3}$/.test(currency)) {
		throw new BillingError("currency must be a three-letter ISO 4217 code", "INVALID_REQUEST", 400);
	}
	return currency;
}
