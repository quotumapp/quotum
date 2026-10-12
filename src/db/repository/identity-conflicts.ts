/** How a provider identity an event names disagrees with the identity Quotum already stored. */
export type IdentityConflictKind =
	/** The provider customer is linked to a different billing account than the event resolves to. */
	| "customer_linked_to_other_account"
	/** The billing account is linked to a different provider customer than the event names. */
	| "account_linked_to_other_customer"
	/** The event id was recorded earlier with another customer, product, transaction or type. */
	| "event_identity_changed"
	/** The payment is recorded for another customer or product. */
	| "purchase_identity_conflict"
	/** The subscription is recorded for another customer or product. */
	| "subscription_identity_conflict";

/**
 * A stored identity contradicts what a provider event names. Nothing is reassigned: the recording
 * transaction rolls back, and a caller that owns the event decides how to keep it. The message names
 * provider object ids only, so it is safe to store and log.
 */
export class IdentityConflictError extends Error {
	constructor(
		readonly kind: IdentityConflictKind,
		message: string,
	) {
		super(message);
		this.name = "IdentityConflictError";
	}
}

const identityConflictKinds: Record<IdentityConflictKind, true> = {
	customer_linked_to_other_account: true,
	account_linked_to_other_customer: true,
	event_identity_changed: true,
	purchase_identity_conflict: true,
	subscription_identity_conflict: true,
};

/**
 * Why a Stripe event was kept as skipped because a stored identity contradicts it. Nothing it
 * carried was applied. A retry stores the reason as the processing error, and an operator fixes
 * the stored identity before replaying the event.
 */
export type StripeIdentityConflictSkipReason = `stripe_${IdentityConflictKind}`;

/** The skip reason a Stripe event is stored under when it runs into this conflict. */
export function stripeIdentityConflictReason(
	error: IdentityConflictError,
): StripeIdentityConflictSkipReason {
	return `stripe_${error.kind}`;
}

export function isStripeIdentityConflictReason(
	reason: string | undefined,
): reason is StripeIdentityConflictSkipReason {
	if (reason?.startsWith("stripe_") !== true) return false;
	return Object.hasOwn(identityConflictKinds, reason.slice("stripe_".length));
}
