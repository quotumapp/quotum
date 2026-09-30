import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";

/**
 * The order usage spends a feature's allocations in: the earliest expiry first; at equal expiry an
 * entity's own allocations before the shared account pool; then the oldest. Every path that locks
 * allocation rows orders them the same way, so two transactions never take rows they share in
 * opposite orders.
 */
export function allocationSpendOrderSql(allocation: DrizzleSQL): DrizzleSQL {
	return drizzleSql`${allocation}.expires_at ASC NULLS LAST, (${allocation}.entity_id IS NULL) ASC, ${allocation}.created_at ASC, ${allocation}.id ASC`;
}
