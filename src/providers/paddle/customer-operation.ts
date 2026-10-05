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
