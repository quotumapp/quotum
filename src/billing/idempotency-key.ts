import { BillingError, InvalidRequestError } from "./errors";

/** Printable key characters, at most as long as the `provider_operations` key columns allow. */
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,200}$/u;

/** Returns the caller's `Idempotency-Key` unchanged, or refuses one a provider route cannot store. */
export function parseIdempotencyKey(value: string): string {
	if (!idempotencyKeyPattern.test(value)) {
		throw new BillingError("Idempotency-Key is invalid", "INVALID_IDEMPOTENCY_KEY", 400);
	}
	return value;
}

/**
 * The caller's `Idempotency-Key` for a `/v1` mutation: 1 to 200 characters, taken exactly as sent.
 * A key with surrounding whitespace is refused, never trimmed: the trimmed key is another caller
 * identity, and would replay or conflict with the operation recorded under the unpadded key.
 */
export function requireIdempotencyKey(value: string | null | undefined): string {
	if (
		value === null ||
		value === undefined ||
		value.length < 1 ||
		value.length > 200 ||
		value.trim() !== value
	) {
		throw new InvalidRequestError(
			"Idempotency-Key header must contain between 1 and 200 characters with no surrounding whitespace",
		);
	}
	return value;
}
