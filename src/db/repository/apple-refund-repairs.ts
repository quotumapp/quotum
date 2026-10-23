import { sql } from "drizzle-orm";
import { databaseDecimal } from "../../billing/decimal";
import {
	type AppleRefundAllocationTarget,
	appleRefundAllocationAttribution,
	appleRefundAllocationScope,
	canRestoreAppleRefund,
	restoreAppleRefundAllocations,
} from "./apple-allocation-restoration";
import { withDeadlockRetry } from "./base";
import { enqueueUsageProjection } from "./entitlements";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor, TransactionalQueryExecutor } from "./types";

export interface AppleRefundReversalRepair {
	storeEventId: string;
	transactionId: string | null;
	billingAccountId: string | null;
	status: "ready" | "unchanged" | "blocked";
	reason: string | null;
	allocations: { allocationId: string; featureKey: string; availableDelta: string }[];
	unattributedAllocationIds: string[];
}

interface RepairTargetRow {
	id: string;
	transaction_id: string | null;
	customer_id: string | null;
	billing_account_id: string | null;
	purchase_id: string | null;
	purchase_kind: string | null;
	purchase_status: string | null;
	purchase_invalidated: boolean;
	subscription_id: string | null;
	subscription_status: string | null;
	identity_matches: boolean;
	erased: boolean;
	later_invalidation: boolean;
}

export interface AppleRefundReversalReportOptions {
	after?: string;
	limit?: number;
}

/** A bounded, read-only preview. Apply rechecks each selected event under the customer mutex. */
export async function readAppleRefundReversalRepairs(
	executor: QueryExecutor,
	projectId: string,
	options: AppleRefundReversalReportOptions = {},
): Promise<{ events: AppleRefundReversalRepair[]; nextAfter: string | null }> {
	const limit = options.limit ?? 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500)
		throw new Error("Repair report limit must be an integer from 1 to 500");
	const rows = await executeRows<{ id: string }>(
		executor,
		sql`
			SELECT id FROM store_events
			WHERE project_id = ${projectId} AND provider = 'apple'
				AND event_type = 'REFUND_REVERSED' AND processing_status = 'processed'
				AND (${options.after ?? null}::uuid IS NULL OR id > ${options.after ?? null}::uuid)
			ORDER BY id LIMIT ${limit + 1}
		`,
	);
	const events: AppleRefundReversalRepair[] = [];
	for (const row of rows.slice(0, limit)) {
		const target = await requireRepairTarget(executor, projectId, row.id);
		events.push(await previewRepair(executor, projectId, target));
	}
	return { events, nextAfter: rows.length > limit ? (events.at(-1)?.storeEventId ?? null) : null };
}

/** No event replay, new grant or commercial fact: only the proven missing accounting effect. */
export async function applyAppleRefundReversalRepair(
	database: TransactionalQueryExecutor,
	projectId: string,
	storeEventId: string,
): Promise<AppleRefundReversalRepair & { restoredAllocationIds: string[] }> {
	return await withDeadlockRetry(() =>
		database.transaction(async (tx) => {
			const initial = await requireRepairTarget(tx, projectId, storeEventId);
			if (initial.customer_id !== null) {
				await executeRows(
					tx,
					sql`SELECT id FROM customers WHERE project_id = ${projectId}
						AND id = ${initial.customer_id} FOR NO KEY UPDATE`,
				);
			}
			const target = await requireRepairTarget(tx, projectId, storeEventId);
			const preview = await previewRepair(tx, projectId, target);
			if (preview.status !== "ready") return { ...preview, restoredAllocationIds: [] };
			const restoredAllocationIds = await restoreAppleRefundAllocations(
				tx,
				allocationTarget(projectId, target),
			);
			if (restoredAllocationIds.length > 0 && target.customer_id !== null) {
				await enqueueUsageProjection(tx, { projectId, customerId: target.customer_id });
			}
			return { ...preview, restoredAllocationIds };
		}),
	);
}

async function requireRepairTarget(
	executor: QueryExecutor,
	projectId: string,
	storeEventId: string,
): Promise<RepairTargetRow> {
	const target = await executeOne<RepairTargetRow>(
		executor,
		sql`
			SELECT event.id, event.transaction_id, purchase.customer_id, customer.billing_account_id,
				purchase.id AS purchase_id, purchase.purchase_kind, purchase.status AS purchase_status,
				purchase.invalidated_at IS NOT NULL AS purchase_invalidated,
				purchase.subscription_id, subscription.status AS subscription_status,
				COALESCE(event.customer_id = purchase.customer_id
					AND event.store_product_id = purchase.store_product_id
					AND event.purchase_kind = purchase.purchase_kind
					AND event.channel = purchase.channel, false) AS identity_matches,
				customer.erased_at IS NOT NULL AS erased,
				EXISTS (
					SELECT 1 FROM store_events later
					WHERE later.project_id = event.project_id AND later.provider = 'apple'
						AND later.customer_id = purchase.customer_id
						AND later.processing_status = 'processed'
						AND (later.processed_at, later.id) > (event.processed_at, event.id)
						AND later.event_type <> 'REFUND_REVERSED'
						AND (later.event_type IN ('REFUND', 'REVOKE')
							OR later.raw_payload->>'storeKitStatus' = '5'
							OR later.raw_payload->'transaction'->>'revocationDate' IS NOT NULL)
						AND (later.transaction_id = event.transaction_id
							OR (subscription.id IS NOT NULL AND (
								later.raw_payload->'transaction'->>'originalTransactionId' = subscription.external_subscription_id
								OR EXISTS (
									SELECT 1 FROM purchases related
									WHERE related.project_id = later.project_id AND related.provider = 'apple'
										AND related.transaction_id = later.transaction_id
										AND related.subscription_id = subscription.id
								)
							)))
				) AS later_invalidation
			FROM store_events event
			LEFT JOIN purchases purchase ON purchase.project_id = event.project_id
				AND purchase.provider = 'apple' AND purchase.transaction_id = event.transaction_id
			LEFT JOIN customers customer ON customer.project_id = purchase.project_id
				AND customer.id = purchase.customer_id
			LEFT JOIN subscriptions subscription ON subscription.project_id = purchase.project_id
				AND subscription.id = purchase.subscription_id
			WHERE event.project_id = ${projectId} AND event.id = ${storeEventId}::uuid
				AND event.provider = 'apple' AND event.event_type = 'REFUND_REVERSED'
				AND event.processing_status = 'processed'
		`,
	);
	if (target === null)
		throw new Error("Processed Apple refund reversal was not found in this instance");
	return target;
}

function allocationTarget(projectId: string, target: RepairTargetRow): AppleRefundAllocationTarget {
	if (target.customer_id === null || target.transaction_id === null)
		throw new Error("Apple refund reversal has no recorded allocation owner");
	return {
		projectId,
		customerId: target.customer_id,
		transactionId: target.transaction_id,
		purchaseId: target.purchase_kind === "consumable" ? target.purchase_id : null,
		subscriptionId: target.purchase_kind === "subscription" ? target.subscription_id : null,
	};
}

async function previewRepair(
	executor: QueryExecutor,
	projectId: string,
	target: RepairTargetRow,
): Promise<AppleRefundReversalRepair> {
	const result: AppleRefundReversalRepair = {
		storeEventId: target.id,
		transactionId: target.transaction_id,
		billingAccountId: target.billing_account_id,
		status: "blocked",
		reason: blockedReason(target),
		allocations: [],
		unattributedAllocationIds: [],
	};
	if (result.reason !== null) return result;
	const scope = allocationTarget(projectId, target);
	if (!(await canRestoreAppleRefund(executor, scope))) {
		result.reason = "refund_not_restorable";
		return result;
	}
	const rows = await executeRows<{
		id: string;
		feature_key: string;
		credit_scale: number;
		attributed: boolean;
		available_delta: string;
	}>(
		executor,
		sql`
			SELECT allocation.id::text, feature.key AS feature_key, feature.credit_scale,
				${appleRefundAllocationAttribution(scope)} AS attributed,
				CASE WHEN allocation.expires_at IS NULL OR allocation.expires_at > now()
					THEN GREATEST(0, allocation.quantity - allocation.consumed_quantity
						- allocation.held_quantity - ${scope.purchaseId !== null ? sql`0` : sql`allocation.reversed_quantity`})
					ELSE 0 END::text AS available_delta
			FROM balance_allocations allocation
			JOIN features feature ON feature.project_id = allocation.project_id
				AND feature.id = allocation.feature_id
			WHERE ${appleRefundAllocationScope(scope)} ORDER BY allocation.id
		`,
	);
	for (const row of rows) {
		if (!row.attributed) result.unattributedAllocationIds.push(row.id);
		else
			result.allocations.push({
				allocationId: row.id,
				featureKey: row.feature_key,
				availableDelta: databaseDecimal(
					row.available_delta,
					"repair balance delta",
					row.credit_scale,
				),
			});
	}
	result.status = result.allocations.length > 0 ? "ready" : "unchanged";
	if (result.unattributedAllocationIds.length > 0 && result.allocations.length === 0) {
		result.status = "blocked";
		result.reason = "allocation_attribution_missing";
	}
	return result;
}

function blockedReason(target: RepairTargetRow): string | null {
	if (target.purchase_id === null) return "purchase_missing";
	if (!target.identity_matches) return "identity_mismatch";
	if (target.erased) return "customer_erased";
	if (target.purchase_status !== "completed" || target.purchase_invalidated)
		return "purchase_invalidated";
	if (target.purchase_kind !== "subscription" && target.purchase_kind !== "consumable")
		return "purchase_kind_unsupported";
	if (target.purchase_kind === "subscription" && target.subscription_status === null)
		return "subscription_missing";
	if (target.subscription_status === "refunded" || target.subscription_status === "revoked")
		return "subscription_invalidated";
	if (target.later_invalidation) return "later_invalidation";
	return null;
}
