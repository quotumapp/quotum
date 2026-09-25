import { sql as drizzleSql } from "drizzle-orm";
import { planGrantWindowBounds } from "./meter-limit-windows";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

export interface SubscriptionAllocationPeriodResult {
	granted: number;
	transitioned: number;
}

/** Only recorded, still-funded provider periods can produce new monthly allowances. */
export async function materializeMonthlySubscriptionAllocations(
	executor: QueryExecutor,
	projectId: string,
	subscriptionId: string,
): Promise<SubscriptionAllocationPeriodResult> {
	const result = { granted: 0, transitioned: 0 };
	const subscription = await executeOne<{
		customer_id: string;
		entity_id: string | number | bigint | null;
		plan_version_id: string | number | bigint;
		period_start: Date | string;
		period_end: Date | string;
		db_now: Date | string;
	}>(
		executor,
		drizzleSql`
		SELECT s.customer_id, s.entity_id, s.plan_version_id,
			COALESCE(s.current_period_start, s.starts_at) AS period_start,
			COALESCE(s.current_period_end, s.expires_at) AS period_end, now() AS db_now
		FROM subscriptions s
		JOIN plan_versions pv ON pv.project_id = s.project_id AND pv.id = s.plan_version_id
		WHERE s.project_id = ${projectId} AND s.id = ${subscriptionId}
			AND pv.billing_interval = 'year'
			AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
			AND COALESCE(s.current_period_start, s.starts_at) <= now()
			AND COALESCE(s.current_period_end, s.expires_at) > now()
			AND (s.expires_at IS NULL OR s.expires_at > now())
		FOR UPDATE OF s
	`,
	);
	if (subscription === null) return result;
	const items = await executeRows<{
		id: string | number | bigint;
		feature_id: string | number | bigint;
		quantity: string;
		allocation_scope: string;
		expires_after_seconds: number | null;
	}>(
		executor,
		drizzleSql`
		SELECT id, feature_id, quantity::text AS quantity, allocation_scope, expires_after_seconds
		FROM plan_items
		WHERE project_id = ${projectId} AND plan_version_id = ${String(subscription.plan_version_id)}::bigint
			AND item_kind = 'allocation' AND reset_interval = 'month'
		ORDER BY id
	`,
	);
	const window = planGrantWindowBounds(
		subscription.period_start,
		subscription.period_end,
		"month",
		new Date(subscription.db_now),
	);
	const start = window.start.toISOString();
	const end = window.end.toISOString();
	for (const item of items) {
		if (item.allocation_scope === "entity" && subscription.entity_id === null) {
			throw new Error("Entity-scoped plan allocations require an entity-scoped subscription");
		}
		// Adopt a pre-fix year-long grant without replenishing it or moving any ledger/hold row.
		// Keep its source key: historical provider redelivery must not recreate that grant.
		const transitioned = await executeRows(
			executor,
			drizzleSql`
			UPDATE balance_allocations SET period_start_at = ${start}::timestamptz,
				period_end_at = ${end}::timestamptz,
				expires_at = LEAST(expires_at, ${end}::timestamptz), updated_at = now()
			WHERE project_id = ${projectId} AND subscription_id = ${subscriptionId}
				AND plan_item_id = ${String(item.id)}::bigint AND source_kind = 'subscription'
				AND period_start_at <= ${start}::timestamptz AND period_end_at >= ${end}::timestamptz
				AND (period_start_at < ${start}::timestamptz OR period_end_at > ${end}::timestamptz)
			RETURNING id
		`,
		);
		result.transitioned += transitioned.length;
		const expiresAt =
			item.expires_after_seconds === null
				? end
				: new Date(
						Math.min(
							window.end.getTime(),
							window.start.getTime() + item.expires_after_seconds * 1000,
						),
					).toISOString();
		const inserted = await executeOne(
			executor,
			drizzleSql`
			INSERT INTO balance_allocations (
				project_id, customer_id, entity_id, feature_id, plan_item_id, subscription_id,
				source_kind, source_key, quantity, period_start_at, period_end_at, expires_at
			)
			SELECT ${projectId}, ${subscription.customer_id},
				${item.allocation_scope === "entity" ? String(subscription.entity_id) : null}::bigint,
				${String(item.feature_id)}::bigint, ${String(item.id)}::bigint, ${subscriptionId},
				'subscription', ${`subscription:${subscriptionId}:${String(item.id)}:${start}:${end}`},
				${item.quantity}::numeric, ${start}::timestamptz, ${end}::timestamptz, ${expiresAt}::timestamptz
			WHERE NOT EXISTS (
				SELECT 1 FROM balance_allocations
				WHERE project_id = ${projectId} AND subscription_id = ${subscriptionId}
					AND plan_item_id = ${String(item.id)}::bigint AND source_kind = 'subscription'
					AND period_start_at = ${start}::timestamptz AND period_end_at = ${end}::timestamptz
			)
			ON CONFLICT (project_id, feature_id, source_kind, source_key) DO NOTHING RETURNING id
		`,
		);
		if (inserted !== null) result.granted += 1;
	}
	return result;
}

/** Filter already-funded windows before LIMIT so an idle subscription cannot starve due work. */
export async function materializeDueSubscriptionAllocations(
	executor: QueryExecutor,
	limit: number,
) {
	const candidates = await executeRows<{ project_id: string; id: string; customer_id: string }>(
		executor,
		drizzleSql`
		WITH candidates AS MATERIALIZED (
			SELECT s.project_id, s.id, s.customer_id
			FROM subscriptions s
			JOIN plan_versions pv ON pv.project_id = s.project_id AND pv.id = s.plan_version_id
			WHERE pv.billing_interval = 'year'
				AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND COALESCE(s.current_period_start, s.starts_at) <= now()
				AND COALESCE(s.current_period_end, s.expires_at) > now()
				AND (s.expires_at IS NULL OR s.expires_at > now())
				AND EXISTS (
					SELECT 1 FROM plan_items pi
					WHERE pi.project_id = s.project_id AND pi.plan_version_id = s.plan_version_id
						AND pi.item_kind = 'allocation' AND pi.reset_interval = 'month'
						AND NOT EXISTS (
							SELECT 1 FROM balance_allocations a
							WHERE a.project_id = s.project_id AND a.subscription_id = s.id AND a.plan_item_id = pi.id
								AND a.source_kind = 'subscription'
								AND a.period_start_at <= now() AND a.period_end_at > now()
								AND NOT (
									a.period_start_at = COALESCE(s.current_period_start, s.starts_at)
									AND a.period_end_at = COALESCE(s.current_period_end, s.expires_at)
									AND a.period_end_at > ((a.period_start_at AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
								)
						)
				)
			ORDER BY s.id LIMIT ${limit}
		), locked_customers AS MATERIALIZED (
			SELECT c.project_id, c.id FROM customers c
			JOIN (SELECT DISTINCT project_id, customer_id FROM candidates) candidate
				ON candidate.project_id = c.project_id AND candidate.customer_id = c.id
			ORDER BY c.id FOR UPDATE OF c
		)
		SELECT s.project_id, s.id, s.customer_id FROM subscriptions s
		JOIN candidates candidate ON candidate.project_id = s.project_id AND candidate.id = s.id
		JOIN locked_customers c ON c.project_id = s.project_id AND c.id = s.customer_id
		ORDER BY s.id FOR UPDATE OF s SKIP LOCKED
	`,
	);
	const changed: Array<
		SubscriptionAllocationPeriodResult & { projectId: string; customerId: string }
	> = [];
	for (const row of candidates) {
		const result = await materializeMonthlySubscriptionAllocations(
			executor,
			row.project_id,
			row.id,
		);
		if (result.granted + result.transitioned > 0) {
			changed.push({ ...result, projectId: row.project_id, customerId: row.customer_id });
		}
	}
	return changed;
}
