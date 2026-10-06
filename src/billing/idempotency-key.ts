import { BillingError } from "./errors";

/** Printable key characters, at most as long as the `provider_operations` key columns allow. */
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,200}$/u;

/** Returns the caller's `Idempotency-Key` unchanged, or refuses one a provider route cannot store. */
export function parseIdempotencyKey(value: string): string {
	if (!idempotencyKeyPattern.test(value)) {
		throw new BillingError("Idempotency-Key is invalid", "INVALID_IDEMPOTENCY_KEY", 400);
	}
	return value;
}
