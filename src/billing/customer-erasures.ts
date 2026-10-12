import { BillingError } from "./errors";

/** Why an operator erased the account. An enum, because free text can itself be personal data. */
export const customerErasureBases = [
	"data_subject_request",
	"merchant_offboarding",
	"legal_order",
	"other",
] as const;

export type CustomerErasureBasis = (typeof customerErasureBases)[number];

/** Losses an erasure causes that the operator must accept before it runs. */
export const customerErasureAcknowledgements = [
	"forfeit_paid_balances",
	"forfeit_lifetime_purchases",
] as const;

export type CustomerErasureAcknowledgement = (typeof customerErasureAcknowledgements)[number];

// Each entry declares `code` literally so the wire error registry inventories it.
const customerErasureErrorDefinitions = [
	{
		code: "BILLING_ACCOUNT_ERASED",
		status: 409,
		message: "Billing account was erased and its id cannot be used again until the erasure expires",
	},
] as const;

export type CustomerErasureErrorCode = (typeof customerErasureErrorDefinitions)[number]["code"];

export function customerErasureError(
	code: CustomerErasureErrorCode,
	details?: Record<string, unknown>,
): BillingError {
	const definition = customerErasureErrorDefinitions.find((candidate) => candidate.code === code);
	return new BillingError(
		definition?.message ?? "Customer erasure failed",
		code,
		definition?.status ?? 409,
		details === undefined ? {} : { details },
	);
}
