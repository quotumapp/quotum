import { sql as drizzleSql } from "drizzle-orm";
import type { CadenceUnit } from "../../shared/cadence";
import { resetIntervalSql, resetSplitsBillingPeriodSql, storedExpiresAt } from "./cadence-sql";
import { planGrantWindowBounds, storedCadence } from "./meter-limit-windows";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

export interface SubscriptionAllocationPeriodResult {
	granted: number;
	transitioned: number;
}

/**
 * Grants the current reset window of every allocation that resets more often than its plan bills
 * (a monthly allowance on an annual plan, a weekly one on a monthly plan). Only recorded,
 * still-funded provider periods produce new allowances.
 */
export async function materializeSubscriptionResetAllocations(
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
		WHERE s.project_id = ${projectId} AND s.id = ${subscriptionId}
			AND EXISTS (
				SELECT 1 FROM plan_items pi
				JOIN plan_versions pv ON pv.project_id = pi.project_id AND pv.id = pi.plan_version_id
				WHERE pi.project_id = s.project_id AND pi.plan_version_id = s.plan_version_id
					AND pi.item_kind = 'allocation' AND ${resetSplitsBillingPeriodSql("pi", "pv", { start: drizzleSql`COALESCE(s.current_period_start, s.starts_at)`, end: drizzleSql`COALESCE(s.current_period_end, s.expires_at)` })}
			)
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
		expires_after_seconds: number | string | null;
		expiry_interval: CadenceUnit | null;
		expiry_interval_count: number | null;
		reset_interval: CadenceUnit;
		reset_interval_count: number;
	}>(
		executor,
		drizzleSql`
		SELECT pi.id, pi.feature_id, pi.quantity::text AS quantity, pi.allocation_scope,
			pi.expires_after_seconds, pi.expiry_interval, pi.expiry_interval_count, pi.reset_interval,
			pi.reset_interval_count
		FROM plan_items pi
		JOIN plan_versions pv ON pv.project_id = pi.project_id AND pv.id = pi.plan_version_id
		WHERE pi.project_id = ${projectId}
			AND pi.plan_version_id = ${String(subscription.plan_version_id)}::bigint
			AND pi.item_kind = 'allocation' AND ${resetSplitsBillingPeriodSql("pi", "pv", { start: drizzleSql`${new Date(subscription.period_start).toISOString()}::timestamptz`, end: drizzleSql`${new Date(subscription.period_end).toISOString()}::timestamptz` })}
		ORDER BY pi.id
	`,
	);
	for (const item of items) {
		const window = planGrantWindowBounds(
			subscription.period_start,
			subscription.period_end,
			storedCadence(item.reset_interval, item.reset_interval_count),
			new Date(subscription.db_now),
		);
		const start = window.start.toISOString();
		const end = window.end.toISOString();
		if (item.allocation_scope === "entity" && subscription.entity_id === null) {
			throw new Error("Entity-scoped plan allocations require an entity-scoped subscription");
		}
		// Adopt a grant made for the whole provider period before its item was split into reset
		// windows, without replenishing it or moving any ledger/hold row.
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
		// An expiry counts from the window start and never outlives the window.
		const expiry = storedExpiresAt(window.start, item);
		const expiresAt = expiry === null || window.end < expiry ? end : expiry.toISOString();
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
			WHERE s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND COALESCE(s.current_period_start, s.starts_at) <= now()
				AND COALESCE(s.current_period_end, s.expires_at) > now()
				AND (s.expires_at IS NULL OR s.expires_at > now())
				AND EXISTS (
					SELECT 1 FROM plan_items pi
					JOIN plan_versions pv ON pv.project_id = pi.project_id AND pv.id = pi.plan_version_id
					WHERE pi.project_id = s.project_id AND pi.plan_version_id = s.plan_version_id
						AND pi.item_kind = 'allocation' AND ${resetSplitsBillingPeriodSql("pi", "pv", { start: drizzleSql`COALESCE(s.current_period_start, s.starts_at)`, end: drizzleSql`COALESCE(s.current_period_end, s.expires_at)` })}
						AND NOT EXISTS (
							SELECT 1 FROM balance_allocations a
							WHERE a.project_id = s.project_id AND a.subscription_id = s.id AND a.plan_item_id = pi.id
								AND a.source_kind = 'subscription'
								AND a.period_start_at <= now() AND a.period_end_at > now()
								AND NOT (
									a.period_start_at = COALESCE(s.current_period_start, s.starts_at)
									AND a.period_end_at = COALESCE(s.current_period_end, s.expires_at)
									AND a.period_end_at > ((a.period_start_at AT TIME ZONE 'UTC') + ${resetIntervalSql("pi")}) AT TIME ZONE 'UTC'
								)
						)
				)
			ORDER BY s.id LIMIT ${limit}
		), locked_customers AS MATERIALIZED (
			SELECT c.project_id, c.id FROM customers c
			JOIN (SELECT DISTINCT project_id, customer_id FROM candidates) candidate
				ON candidate.project_id = c.project_id AND candidate.customer_id = c.id
			ORDER BY c.id FOR NO KEY UPDATE OF c
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
		const result = await materializeSubscriptionResetAllocations(executor, row.project_id, row.id);
		if (result.granted + result.transitioned > 0) {
			changed.push({ ...result, projectId: row.project_id, customerId: row.customer_id });
		}
	}
	return changed;
}
