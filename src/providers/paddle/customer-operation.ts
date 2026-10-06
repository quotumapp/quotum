import { sha256Hex } from "../../billing/decimal";

/**
 * Serializes unresolved customer writes: the database allows one unresolved `customer.create` per
 * resource key. Operations created before checkout-scoped keys used it as their idempotency key too.
 */
export function paddleCustomerResourceKey(billingAccountId: string): string {
	return `customer:${sha256Hex(billingAccountId)}`;
}

/**
 * One customer creation attempt per checkout key, so a definitive rejection stays a terminal,
 * immutable receipt for its own key while a new deliberate attempt can create the customer once.
 */
export function paddleCustomerAttemptKey(billingAccountId: string, checkoutKey: string): string {
	return `${paddleCustomerResourceKey(billingAccountId)}:${sha256Hex(checkoutKey)}`;
}

/**
 * The operation and reservation keys a retry of this checkout key resumes: the checkout's own and
 * its customer attempt's. A write prepared under any other key belongs to another request.
 */
export function paddleResumableKeys(billingAccountId: string, checkoutKey: string): string[] {
	return [checkoutKey, paddleCustomerAttemptKey(billingAccountId, checkoutKey)];
}
