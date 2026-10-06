import { describe, expect, it } from "bun:test";
import {
	RECURRING_JOB_MAX_ATTEMPTS,
	recurringRetryDelayMinutes,
	recurringRetryDue,
} from "../../src/db/repository/recurring-retry";
import { renderDrizzleSql } from "../helpers/drizzle-sql";

describe("recurring job retry schedule", () => {
	it("doubles the delay from one minute up to an hour", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 19, 500].map(recurringRetryDelayMinutes)).toEqual([
			1, 1, 2, 4, 8, 16, 32, 60, 60, 60, 60,
		]);
	});

	it("parks a job inside Stripe's 24 hour idempotency retention", () => {
		let waitedMinutes = 0;
		for (let attempts = 1; attempts < RECURRING_JOB_MAX_ATTEMPTS; attempts += 1) {
			waitedMinutes += recurringRetryDelayMinutes(attempts);
		}
		// Retrying after Stripe forgets the keys would create a second invoice for the same usage.
		expect(waitedMinutes).toBeGreaterThan(12 * 60);
		expect(waitedMinutes).toBeLessThan(24 * 60);
	});

	it("renders a due check that never overflows and runs a new job at once", () => {
		const sql = renderDrizzleSql(recurringRetryDue("usage_invoice_periods"));
		expect(sql).toContain("usage_invoice_periods.attempts = 0");
		expect(sql).toContain("usage_invoice_periods.updated_at + LEAST(");
		expect(sql).toContain("power(2, LEAST(GREATEST(usage_invoice_periods.attempts - 1, 0), 12))");
	});
});
