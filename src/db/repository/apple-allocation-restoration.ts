import { type SQL, sql } from "drizzle-orm";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

export interface AppleRefundAllocationTarget {
	projectId: string;
	customerId: string;
	transactionId: string;
	purchaseId: string | null;
	subscriptionId: string | null;
}

/** Call under the customer mutex, before restoring purchase or subscription state. */
export async function canRestoreAppleRefund(
	executor: QueryExecutor,
	target: Omit<AppleRefundAllocationTarget, "purchaseId">,
): Promise<boolean> {
	const latest = await executeOne<{
		event_type: string;
		transaction_id: string | null;
		revoked: boolean;
	}>(
		executor,
		sql`
			SELECT event.event_type, event.transaction_id, EXISTS (
				SELECT 1 FROM store_events revocation
				WHERE revocation.project_id = ${target.projectId} AND revocation.provider = 'apple'
					AND revocation.customer_id = ${target.customerId}
					AND revocation.processing_status = 'processed' AND revocation.event_type = 'REVOKE'
					AND (revocation.transaction_id = ${target.transactionId}
						OR EXISTS (
							SELECT 1 FROM purchases purchase
							WHERE purchase.project_id = revocation.project_id AND purchase.provider = 'apple'
								AND purchase.transaction_id = revocation.transaction_id
								AND purchase.subscription_id = ${target.subscriptionId}::uuid
						))
			) AS revoked
			FROM store_events event
			WHERE event.project_id = ${target.projectId} AND event.provider = 'apple'
				AND event.customer_id = ${target.customerId} AND event.processing_status = 'processed'
				AND event.event_type <> 'REFUND_REVERSED'
				AND (event.event_type IN ('REFUND', 'REVOKE')
					OR event.raw_payload->>'storeKitStatus' = '5'
					OR event.raw_payload->'transaction'->>'revocationDate' IS NOT NULL)
				AND (event.transaction_id = ${target.transactionId}
					OR EXISTS (
						SELECT 1 FROM subscriptions subscription
						WHERE subscription.project_id = event.project_id
							AND subscription.id = ${target.subscriptionId}::uuid
							AND (event.raw_payload->'transaction'->>'originalTransactionId' = subscription.external_subscription_id
								OR EXISTS (
									SELECT 1 FROM purchases related
									WHERE related.project_id = event.project_id AND related.provider = 'apple'
										AND related.transaction_id = event.transaction_id
										AND related.subscription_id = subscription.id
								))
					))
			ORDER BY event.processed_at DESC, event.id DESC LIMIT 1
		`,
	);
	return (
		latest?.event_type === "REFUND" &&
		latest.transaction_id === target.transactionId &&
		!latest.revoked
	);
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
