import { maxInt4 } from "../shared/input-bounds";
import { BillingError } from "./errors";

/**
 * The most seats, or other licensed units, one price can carry. A subscription item's quantity is
 * a Postgres `integer`, so a larger request would be accepted here and then fail the provider event
 * that reports it (22003, out of range) with nothing stored, which the provider retries for ever.
 * It holds whether or not the price sets a `maximumQuantity`.
 */
export const maxLicensedQuantity = maxInt4;

/** The `400 INVALID_QUANTITY` for a quantity, or a total it implies, that cannot be accepted. */
export function invalidQuantityError(message: string): BillingError {
	return new BillingError(message, "INVALID_QUANTITY", 400);
}
