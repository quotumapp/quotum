import { PersistenceConflictError } from "../../billing/errors";

/**
 * A published plan the Stripe connection holds no price for, such as a free plan or one sold only
 * through an app store. The plan is real and the request is well formed, so this is a 409.
 */
export function planNotPurchasableViaStripe(planKey: string): PersistenceConflictError {
	return new PersistenceConflictError(
		`Plan ${planKey} has no Stripe price`,
		"PLAN_NOT_PURCHASABLE_VIA_STRIPE",
	);
}

/** A Stripe product whose stored price lacks the amount or currency a Checkout line needs. */
export function productNotPurchasableViaStripe(productKey: string): PersistenceConflictError {
	return new PersistenceConflictError(
		`Stripe product ${productKey} has no price amount and currency`,
		"PRODUCT_NOT_PURCHASABLE_VIA_STRIPE",
	);
}
