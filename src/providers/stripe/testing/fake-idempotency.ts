import Stripe from "stripe";
import { canonicalJson } from "../../../shared/canonical-json";

export interface FakeStripeIdempotency {
	/**
	 * Records the request an idempotency key was first used for. A later request with the same
	 * key must be that request again: another endpoint, object or parameter set fails the way
	 * Stripe fails it instead of replaying the first response. Fakes claim after an injected
	 * failure would have thrown, so an injected failure is a request Stripe never executed.
	 */
	claim(idempotencyKey: string | undefined, request: string, params?: unknown): void;
}

/** Stripe's idempotency keys, per account: one request per key, whatever the endpoint. */
export function createFakeStripeIdempotency(): FakeStripeIdempotency {
	const requests = new Map<string, string>();
	return {
		claim(idempotencyKey, request, params = {}) {
			if (idempotencyKey === undefined) return;
			const fingerprint = `${request} ${canonicalJson(params)}`;
			const first = requests.get(idempotencyKey);
			if (first === undefined) {
				requests.set(idempotencyKey, fingerprint);
				return;
			}
			if (first !== fingerprint) throw stripeIdempotencyError(idempotencyKey);
		},
	};
}

/** The error the Stripe client raises for Stripe's 400 `idempotency_error` response. */
export function stripeIdempotencyError(
	idempotencyKey: string,
): Stripe.errors.StripeIdempotencyError {
	return new Stripe.errors.StripeIdempotencyError({
		type: "idempotency_error",
		statusCode: 400,
		message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idempotencyKey}' if you meant to execute a different request.`,
	});
}
