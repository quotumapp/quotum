/** Stripe's answer for an object id it does not know, as stripe-node raises it. */
export function isStripeResourceMissing(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const record = error as { code?: unknown; raw?: { code?: unknown } };
	return (record.code ?? record.raw?.code) === "resource_missing";
}
