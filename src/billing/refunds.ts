import type { ProjectInstanceContext } from "../projects/context";
import type { BillingProvider } from "./types";

/** `full` returns everything paid net of earlier refunds; `prorated` returns the unused share. */
export const refundModes = ["full", "prorated"] as const;
export type RefundMode = (typeof refundModes)[number];

/**
 * What a refund amount was measured by: the whole payment, the share of the paid period still
 * ahead, or the share of a purchased credit pack that is not yet consumed.
 */
export type RefundBasis = "full" | "remaining_time" | "unconsumed_credit";

export type RefundTargetKind = "subscription_payment" | "purchase";

/**
 * `requested` is recorded before the provider is asked and stays until the provider answers;
 * `pending` is a refund the provider accepted but has not paid out; `succeeded` and `failed` are
 * final; `requires_review` is a request whose provider outcome could not be established safely.
 */
export const refundRequestStatuses = [
	"requested",
	"pending",
	"succeeded",
	"failed",
	"requires_review",
] as const;
export type RefundRequestStatus = (typeof refundRequestStatuses)[number];

/** A refund request Quotum made of a provider, with the amount and reason the caller approved. */
export interface RefundRequest {
	id: string;
	billingAccountId: string;
	provider: BillingProvider;
	targetKind: RefundTargetKind;
	/** The provider's invoice id, for a subscription payment. */
	externalInvoiceId: string | null;
	purchaseId: string | null;
	/** The provider payment the refund draws on, such as a Stripe PaymentIntent id. */
	providerPaymentId: string;
	amountMinor: number;
	currency: string;
	mode: RefundMode;
	basis: RefundBasis;
	cancelImmediately: boolean;
	reason: string;
	status: RefundRequestStatus;
	providerRefundId: string | null;
	failureCode: string | null;
	/** The key the provider call used; internal, never returned by the API. */
	providerIdempotencyKey: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}

/** Where the refund read route gets the requests of a billing account. */
export interface RefundRequestStore {
	listRefundRequests(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; limit: number },
	): Promise<RefundRequest[]>;
}

/** A refund request as the API returns it; the provider key stays internal. */
export function publicRefundRequest(
	request: RefundRequest,
): Omit<RefundRequest, "providerIdempotencyKey"> {
	const { providerIdempotencyKey: _internal, ...visible } = request;
	return visible;
}

/**
 * The share of a payment a refund of the unused part of a paid period returns: the time between
 * `now` and the end of the period, over the whole period, of what was paid, rounded down and never
 * more than what is still refundable. A period that has ended refunds nothing.
 */
export function remainingTimeRefundMinor(input: {
	paidMinor: number;
	refundableMinor: number;
	periodStart: Date;
	periodEnd: Date;
	now: Date;
}): number {
	const total = input.periodEnd.getTime() - input.periodStart.getTime();
	if (total <= 0) return 0;
	const remaining = Math.min(
		total,
		Math.max(
			0,
			input.periodEnd.getTime() - Math.max(input.now.getTime(), input.periodStart.getTime()),
		),
	);
	const share = (BigInt(input.paidMinor) * BigInt(remaining)) / BigInt(total);
	return Math.min(Number(share), input.refundableMinor);
}
