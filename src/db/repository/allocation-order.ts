import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { executeRows } from "./query";
import type { QueryExecutor } from "./types";

/**
 * The order usage spends a feature's allocations in: the earliest expiry first; at equal expiry an
 * entity's own allocations before the shared account pool; then the oldest. Every path that locks
 * allocation rows orders them the same way, so two transactions never take rows they share in
 * opposite orders.
 */
export function allocationSpendOrderSql(allocation: DrizzleSQL): DrizzleSQL {
	return drizzleSql`${allocation}.expires_at ASC NULLS LAST, (${allocation}.entity_id IS NULL) ASC, ${allocation}.created_at ASC, ${allocation}.id ASC`;
}

/**
 * A version switch can touch outgoing, returning and linked carry allocations. Lock the account's
 * existing rows once in spend order before any of those updates; a later semantic iteration by id
 * then takes no new locks. Expired, unprocessed allowances belong to rollover maintenance;
 * reversed rows cannot participate. Newly inserted rows are private to the switching transaction.
 */
export async function lockCustomerAllocationRows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
  SELECT allocation.id FROM balance_allocations allocation
  WHERE allocation.project_id = ${projectId} AND allocation.customer_id = ${customerId}
   AND allocation.reversed_at IS NULL
   AND (allocation.expires_at IS NULL OR allocation.expires_at > now()
    OR allocation.rollover_processed_at IS NOT NULL)
  ORDER BY ${allocationSpendOrderSql(drizzleSql`allocation`)}
  FOR UPDATE OF allocation
 `,
	);
}
