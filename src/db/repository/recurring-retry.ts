import { sql as drizzleSql } from "drizzle-orm";

/**
 * Subscription changes and usage invoices (periods and late adjustments) are retried with growing
 * delays and parked as `failed` after this many attempts. The delays sum to about 14 hours, which
 * stays inside the 24 hours Stripe keeps idempotency keys: a retry inside that window repeats the
 * keyed calls of the first attempt instead of creating a second invoice.
 */
export const RECURRING_JOB_MAX_ATTEMPTS = 20;

const FIRST_RETRY_MINUTES = 1;
const LONGEST_RETRY_MINUTES = 60;
/** 2 ** 12 minutes is far past the cap; the exponent stops here so the interval cannot overflow. */
const LARGEST_EXPONENT = 12;

/** Minutes a job waits after its `attempts`-th failed attempt: 1, 2, 4, 8, 16, 32, then 60. */
export function recurringRetryDelayMinutes(attempts: number): number {
	const exponent = Math.min(Math.max(attempts - 1, 0), LARGEST_EXPONENT);
	return Math.min(LONGEST_RETRY_MINUTES, FIRST_RETRY_MINUTES * 2 ** exponent);
}

/**
 * Whether a pending job may be claimed: a job that never ran is due at once, and a failed one waits
 * out the delay measured from the failure, which stamped `updated_at`.
 */
export function recurringRetryDue(
	alias: "subscription_changes" | "usage_invoice_periods" | "adjustment",
) {
	const attempts = `${alias}.attempts`;
	// Only constants and a fixed alias are interpolated, so the fragment cannot carry input.
	return drizzleSql.raw(`(
		${attempts} = 0
		OR ${alias}.updated_at + LEAST(
			${LONGEST_RETRY_MINUTES}::double precision,
			${FIRST_RETRY_MINUTES}::double precision
				* power(2, LEAST(GREATEST(${attempts} - 1, 0), ${LARGEST_EXPONENT}))
		) * interval '1 minute' <= now()
	)`);
}
