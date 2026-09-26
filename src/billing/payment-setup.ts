/**
 * Hosted payment-method setup: saving a payment method for later off-session charges. Without a
 * plan, a setup is not a purchase and the only billing state it changes is the provider default
 * payment method. With a plan, completion starts that plan on the saved card.
 */

import { BillingError } from "./errors";
import type { BillingProvider } from "./types";

export const paymentSetupStatuses = [
	/** The hosted link is being created; the provider call may or may not have landed. */
	"creating",
	/** The link exists and the customer has not finished with it. */
	"awaiting_customer",
	/** The customer finished; the default-method write, and any plan start, is still owed. */
	"applying_default",
	/** The default-method write is confirmed and any plan outcome is terminal. */
	"completed",
	/** The link expired without a completed setup, confirmed against the provider. */
	"expired",
	/** Work remains that retries could not finish; the setup keeps the account's active slot. */
	"needs_attention",
] as const;
export type PaymentSetupStatus = (typeof paymentSetupStatuses)[number];

/**
 * What happened to a plan attached to a setup. `pending` holds the setup in `applying_default`
 * until the outcome is terminal; a completed setup is never left pending.
 */
export const paymentSetupPlanStatuses = [
	"pending",
	"started",
	"payment_failed",
	"plan_changed",
	"not_eligible",
] as const;
export type PaymentSetupPlanStatus = (typeof paymentSetupPlanStatuses)[number];

export interface PaymentSetupPlanFailure {
	code: string;
	message: string;
}

/** The plan a setup session reports. Absent when setup only saved a card. */
export interface PaymentSetupSessionPlan {
	planKey: string;
	planVersionId: string;
	quantities: Record<string, number>;
	status: PaymentSetupPlanStatus;
	externalSubscriptionId: string | null;
	failure: PaymentSetupPlanFailure | null;
	resolvedAt: string | null;
}

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
	/** The plan this setup starts after the card is saved, or null when it only saves a card. */
	plan: PaymentSetupSessionPlan | null;
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
