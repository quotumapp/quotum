import { type SQL, sql } from "drizzle-orm";
import { executeRows } from "./query";
import type { QueryExecutor } from "./types";

export interface AppleRefundAllocationTarget {
	projectId: string;
	customerId: string;
	transactionId: string;
	purchaseId: string | null;
	subscriptionId: string | null;
}

/** The allocation alias is shared by the repair preview and its guarded update. */
export function appleRefundAllocationScope(target: AppleRefundAllocationTarget): SQL {
	return sql`allocation.project_id = ${target.projectId}
		AND allocation.customer_id = ${target.customerId}
		AND allocation.reversed_at IS NOT NULL
		AND (
			(${target.purchaseId}::uuid IS NOT NULL AND allocation.purchase_id = ${target.purchaseId}::uuid)
			OR (${target.subscriptionId}::uuid IS NOT NULL
				AND allocation.subscription_id = ${target.subscriptionId}::uuid)
		)`;
}

export function appleRefundAllocationAttribution(target: AppleRefundAllocationTarget): SQL {
	// Purchase allocations belong to exactly one payment. Subscription invalidations affect all
	// existing allowances, including reset windows and lifetime grants. Both the refund event and
	// those newly invalidated rows use the same transaction's now(): compare in SQL to retain the
	// microseconds a JavaScript Date would drop. An earlier refund/revocation keeps its own marker.
	return target.purchaseId !== null
		? sql`true`
		: sql`EXISTS (
			SELECT 1 FROM store_events refund
			WHERE refund.project_id = allocation.project_id AND refund.provider = 'apple'
				AND refund.customer_id = allocation.customer_id
				AND refund.transaction_id = ${target.transactionId}
				AND refund.event_type = 'REFUND' AND refund.processing_status = 'processed'
				AND refund.processed_at = allocation.reversed_at
		)`;
}

/** Undo only the refund's effects; never recreate a grant or reset usage, holds or expiry. */
export async function restoreAppleRefundAllocations(
	executor: QueryExecutor,
	target: AppleRefundAllocationTarget,
): Promise<string[]> {
	const rows = await executeRows<{ id: string }>(
		executor,
		sql`
			UPDATE balance_allocations allocation
			SET reversed_at = NULL,
				reversed_quantity = ${target.purchaseId !== null ? sql`0` : sql`allocation.reversed_quantity`},
				updated_at = now()
			WHERE allocation.project_id = ${target.projectId}
				AND ${appleRefundAllocationScope(target)} AND ${appleRefundAllocationAttribution(target)}
			RETURNING allocation.id::text
		`,
	);
	return rows.map((row) => row.id);
}
