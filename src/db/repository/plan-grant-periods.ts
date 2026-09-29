import { sql as drizzleSql } from "drizzle-orm";
import type { CadenceUnit } from "../../shared/cadence";
import { planGrantWindowBounds, storedCadence } from "./meter-limit-windows";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

/**
 * Creates the allowances of the reset window the grant is in now, then records when the next one
 * begins. Items without a reset get one allowance for the whole grant. Every allowance expires by
 * the grant end, and elapsed windows are never created afterwards. An item that already has an
 * allowance for the window, such as one a default plan kept across a version change, gets no second.
 */
export async function materializePlanGrantPeriod(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
): Promise<void> {
	const grant = await executeOne<{
		customer_id: string;
		plan_version_id: string | number | bigint;
		starts_at: Date | string;
		ends_at: Date | string | null;
		db_now: Date | string;
	}>(
		executor,
		drizzleSql`
			SELECT g.customer_id, g.plan_version_id, g.starts_at, g.ends_at, now() AS db_now
			FROM plan_grants g
			WHERE g.project_id = ${projectId} AND g.id = ${grantId}::uuid AND g.status = 'active'
		`,
	);
	if (grant === null) return;
	const items = await executeRows<{
		id: string | number | bigint;
		feature_id: string | number | bigint;
		quantity: string;
		reset_interval: CadenceUnit | null;
		reset_interval_count: number;
		expires_after_seconds: number | null;
	}>(
		executor,
		drizzleSql`
			SELECT item.id, item.feature_id, item.quantity::text AS quantity, item.reset_interval,
				item.reset_interval_count, item.expires_after_seconds
			FROM plan_items item
			WHERE item.project_id = ${projectId}
				AND item.plan_version_id = ${String(grant.plan_version_id)}::bigint
				AND item.item_kind = 'allocation'
				AND item.allocation_scope = 'account'
			ORDER BY item.id
		`,
	);
	const now = new Date(grant.db_now);
	const startsAt = new Date(grant.starts_at);
	const endsAt = grant.ends_at === null ? null : new Date(grant.ends_at);
	let nextPeriodAt: Date | null = null;
	const allocations = items.map((item) => {
		const window: { start: Date; end: Date | null } =
			item.reset_interval === null
				? { start: startsAt, end: endsAt }
				: planGrantWindowBounds(
						startsAt,
						endsAt,
						storedCadence(item.reset_interval, item.reset_interval_count),
						now,
					);
		if (
			item.reset_interval !== null &&
			window.end !== null &&
			(endsAt === null || window.end < endsAt)
		) {
			nextPeriodAt = nextPeriodAt === null || window.end < nextPeriodAt ? window.end : nextPeriodAt;
		}
		const expiresAt =
			item.expires_after_seconds === null
				? window.end
				: new Date(
						Math.min(
							window.end?.getTime() ?? Number.POSITIVE_INFINITY,
							window.start.getTime() + item.expires_after_seconds * 1000,
						),
					);
		const window_key = item.reset_interval === null ? "once" : window.start.toISOString();
		return drizzleSql`(
			${projectId}::uuid,
			${grant.customer_id}::uuid,
			${String(item.feature_id)}::bigint,
			${String(item.id)}::bigint,
			${grantId}::uuid,
			'reward',
			${`plan_grant:${grantId}:${String(item.id)}:${window_key}`},
			${item.quantity}::numeric,
			${window.start.toISOString()}::timestamptz,
			${window.end?.toISOString() ?? null}::timestamptz,
			${expiresAt?.toISOString() ?? null}::timestamptz
		)`;
	});
	if (allocations.length > 0) {
		await executeRows(
			executor,
			drizzleSql`
				INSERT INTO balance_allocations (
					project_id, customer_id, feature_id, plan_item_id, plan_grant_id, source_kind,
					source_key, quantity, period_start_at, period_end_at, expires_at
				)
				SELECT *
				FROM (VALUES ${drizzleSql.join(allocations, drizzleSql`, `)}) AS candidate (
					project_id, customer_id, feature_id, plan_item_id, plan_grant_id, source_kind,
					source_key, quantity, period_start_at, period_end_at, expires_at
				)
				WHERE NOT EXISTS (
					SELECT 1 FROM balance_allocations kept
					WHERE kept.project_id = candidate.project_id
						AND kept.plan_grant_id = candidate.plan_grant_id
						AND kept.plan_item_id = candidate.plan_item_id
						AND kept.period_start_at = candidate.period_start_at
				)
				ON CONFLICT (project_id, feature_id, source_kind, source_key) DO NOTHING
			`,
		);
	}
	const next: Date | null = nextPeriodAt;
	await executeRows(
		executor,
		drizzleSql`
			UPDATE plan_grants
			SET next_period_at = ${next === null ? null : (next as Date).toISOString()}::timestamptz,
				updated_at = now()
			WHERE project_id = ${projectId} AND id = ${grantId}::uuid AND status = 'active'
		`,
	);
}

/** Ends every allowance of the grant that is still live. */
export async function clampPlanGrantAllocations(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations SET expires_at = now(), updated_at = now()
			WHERE project_id = ${projectId}
				AND plan_grant_id = ${grantId}::uuid
				AND (expires_at IS NULL OR expires_at > now())
		`,
	);
}
