import { sql as drizzleSql } from "drizzle-orm";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor, TransactionalQueryExecutor } from "./types";
export function desiredLicensePoolsSql(projectId: string, customerId: string) {
	return drizzleSql`
		SELECT subscription.project_id, subscription.customer_id, subscription.id AS subscription_id,
			item.id AS plan_item_id, item.feature_id,
			COALESCE(subscription_item.quantity, item.quantity::integer) AS quantity
		FROM subscriptions subscription
		JOIN plan_items item
			ON item.project_id = subscription.project_id
			AND item.plan_version_id = subscription.plan_version_id
		JOIN price_components price
			ON price.project_id = item.project_id AND price.plan_item_id = item.id
			AND price.component_kind = 'licensed'
		LEFT JOIN subscription_items subscription_item
			ON subscription_item.project_id = subscription.project_id
			AND subscription_item.subscription_id = subscription.id
			AND subscription_item.price_component_id = price.id
			AND subscription_item.active = true
		WHERE subscription.project_id = ${projectId} AND subscription.customer_id = ${customerId}
			AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
			AND (subscription.expires_at IS NULL OR subscription.expires_at > now())
			AND item.item_kind = 'licensed_quantity' AND item.allocation_scope = 'license_pool'
	`;
}

/**
 * Brings the customer's stored pools in line with `desiredLicensePoolsSql`, and does nothing
 * when they already are. Called by mutating entitlement recomputation, assignment and the operator
 * backfill. Read routes derive current capacity without invoking this helper.
 */
export async function syncLicensePools(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<void> {
	const state = await executeOne<{ current: boolean }>(
		executor,
		drizzleSql`
			WITH desired AS (
				SELECT subscription_id, plan_item_id, quantity
				FROM (${desiredLicensePoolsSql(projectId, customerId)}) wanted
			), stored AS (
				SELECT subscription_id, plan_item_id, quantity
				FROM license_pools
				WHERE project_id = ${projectId} AND customer_id = ${customerId} AND active = true
			)
			SELECT NOT EXISTS (SELECT * FROM desired EXCEPT SELECT * FROM stored)
				AND NOT EXISTS (SELECT * FROM stored EXCEPT SELECT * FROM desired) AS current
		`,
	);
	if (state?.current === true) return;
	await refreshLicensePools(executor, projectId, customerId);
}

/**
 * Rebuilds the customer's license pools from the purchased subscription items under the customer
 * lock. Pool ids are stable across refreshes, so callers that remembered one keep using it while
 * its capacity follows the provider's current quantity.
 */
async function refreshLicensePools(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			SELECT id FROM customers
			WHERE project_id = ${projectId} AND id = ${customerId}
			FOR NO KEY UPDATE
		`,
	);
	await executeRows(
		executor,
		drizzleSql`
			UPDATE license_pools SET active = false, updated_at = now()
			WHERE project_id = ${projectId} AND customer_id = ${customerId} AND active = true
		`,
	);
	await executeRows(
		executor,
		drizzleSql`
			INSERT INTO license_pools (project_id, customer_id, subscription_id, plan_item_id, feature_id, quantity)
			${desiredLicensePoolsSql(projectId, customerId)}
			ON CONFLICT (project_id, subscription_id, plan_item_id) DO UPDATE SET
				quantity = EXCLUDED.quantity, active = true, updated_at = now()
		`,
	);
}

/** One bounded page; callers resume from the returned customer ID. Each account commits separately. */
export async function syncLicensePoolPage(
	database: TransactionalQueryExecutor,
	projectId: string,
	after: string | null,
	limit = 100,
): Promise<{ customers: number; nextAfter: string | null }> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 500)
		throw new Error("License pool batch must be between 1 and 500");
	const rows = await executeRows<{ id: string }>(
		database,
		drizzleSql`
 SELECT c.id FROM customers c WHERE c.project_id=${projectId}
 AND (${after}::uuid IS NULL OR c.id>${after}::uuid)
 ORDER BY c.id LIMIT ${limit}`,
	);
	for (const row of rows)
		await database.transaction(async (tx) => {
			await syncLicensePools(tx, projectId, row.id);
		});
	return {
		customers: rows.length,
		nextAfter: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
	};
}
