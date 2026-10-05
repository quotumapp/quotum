import { BillingError } from "../../billing/errors";

/** The stable receipt code for a request Paddle's limiter, or this process's cooldown, refused. */
export const PADDLE_RATE_LIMITED = "PADDLE_RATE_LIMITED";

export const paddleExistingCustomerReasons = [
	"claimed",
	"inactive",
	"email_mismatch",
	"ambiguous",
] as const;
export type PaddleExistingCustomerReason = (typeof paddleExistingCustomerReasons)[number];

/** The receipt code that records why an existing Paddle customer was not linked. */
export function paddleExistingCustomerReceiptCode(reason: PaddleExistingCustomerReason): string {
	return `PADDLE_CUSTOMER_EXISTS_${reason.toUpperCase()}`;
}

/** Paddle could not be asked about the existing customer; nothing was linked. */
export const PADDLE_UNAVAILABLE = "PADDLE_UNAVAILABLE";

/**
 * A definitive provider rejection is terminal for its own Idempotency-Key: the write was not applied
 * and the ledger never sends it again. The receipt code tells the caller what to change.
 */
export function paddleOperationFailed(operation: {
	id: string;
	errorCode: string | null;
}): BillingError {
	const reason = paddleExistingCustomerReasons.find(
		(candidate) => paddleExistingCustomerReceiptCode(candidate) === operation.errorCode,
	);
	if (reason !== undefined)
		return new BillingError(
			"Paddle already has a customer for this email that cannot be linked to this billing account; use a different email or contact support",
			"PADDLE_CUSTOMER_ALREADY_EXISTS",
			409,
			{ details: { operationId: operation.id, status: "failed", reason } },
		);
	return new BillingError(
		operation.errorCode === PADDLE_RATE_LIMITED || operation.errorCode === PADDLE_UNAVAILABLE
			? "Paddle did not apply this operation because it was rate limited or unavailable; retry with a new Idempotency-Key after the retry interval"
			: "Paddle rejected this operation; inspect its receipt before submitting a corrected request",
		"PROVIDER_OPERATION_FAILED",
		409,
		{
			details: {
				operationId: operation.id,
				status: "failed",
				...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
			},
		},
	);
}
