import { BillingError } from "../../billing/errors";

/** The stable receipt code for a request Paddle's limiter, or this process's cooldown, refused. */
export const PADDLE_RATE_LIMITED = "PADDLE_RATE_LIMITED";

/**
 * A definitive provider rejection is terminal for its own Idempotency-Key: the write was not applied
 * and the ledger never sends it again. The receipt code tells the caller what to change.
 */
export function paddleOperationFailed(operation: {
	id: string;
	errorCode: string | null;
}): BillingError {
	return new BillingError(
		operation.errorCode === PADDLE_RATE_LIMITED
			? "Paddle rate limited this operation and did not apply it; retry with a new Idempotency-Key after the retry interval"
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
