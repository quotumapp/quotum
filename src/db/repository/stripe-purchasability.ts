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

/** A gift product that is not on sale: it has no published gift, it was retired or its promotion is gone. */
export function giftNotOnSale(
	productKey: string,
	reason: "no_definition" | "retired" | "promotion_unavailable",
): PersistenceConflictError {
	const why = {
		no_definition: "has no published gift",
		retired: "is retired",
		promotion_unavailable: "names a promotion that no longer gives a plan",
	}[reason];
	return new PersistenceConflictError(
		`Gift product ${productKey} is not on sale: it ${why}`,
		"PRODUCT_NOT_PURCHASABLE_VIA_STRIPE",
	);
}
