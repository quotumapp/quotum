import { sql as drizzleSql } from "drizzle-orm";
import { databaseDecimal, decimalToUnits, unitsToDecimal } from "../../billing/decimal";
import type { CadenceUnit } from "../../shared/cadence";
import { defaultPlanReadGrantSql } from "./default-plan-sql";
import {
	meterLimitWindowBounds,
	optionalStoredCadence,
	planGrantWindowBounds,
	storedCadence,
} from "./meter-limit-windows";
import { executeRows } from "./query";
import type { QueryExecutor } from "./types";

export interface MeterLimitRow {
	plan_item_id: string | number | bigint;
	/** Exactly one of the subscription and the plan grant is set. */
	subscription_id: string | null;
	plan_grant_id: string | null;
	quantity: unknown;
	overage_policy: "blocked" | "allowed";
	reset_interval: CadenceUnit;
	reset_interval_count: number;
	billing_interval: CadenceUnit | null;
	billing_interval_count: number;
	period_start_at: Date | string;
	period_end_at: Date | string | null;
	plan_kind: "base" | "addon";
	/** When the subscription or grant was recorded, which orders sources of one kind. */
	sort_at: Date | string;
}

/**
 * The meter limits that apply to the account's feature: a paying subscription's, a plan grant's,
 * or the default plan's when the account would start it on its next write. A null account is one
 * Quotum has not recorded yet.
 */
export function queryMeterLimitRows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	feature: { id: string | number | bigint },
): Promise<MeterLimitRow[]> {
	const customer = drizzleSql`${customerId}::uuid`;
	return executeRows<MeterLimitRow>(
		executor,
		// A paying subscription's limit comes before a plan grant's, which has no payment method and
		// so never allows overage.
		drizzleSql`
			SELECT
				plan_item_id,
				subscription_id,
				plan_grant_id,
				quantity,
				overage_policy,
				reset_interval,
				reset_interval_count,
				billing_interval,
				billing_interval_count,
				period_start_at,
				period_end_at,
				(
					SELECT version.plan_kind
					FROM plan_items item
					JOIN plan_versions version
						ON version.project_id = item.project_id AND version.id = item.plan_version_id
					WHERE item.project_id = ${projectId} AND item.id = sources.plan_item_id
				) AS plan_kind,
				sort_at
			FROM (
				SELECT
					pi.id AS plan_item_id,
					s.id AS subscription_id,
					NULL::uuid AS plan_grant_id,
					pi.quantity,
					pi.overage_policy,
					pi.reset_interval,
					pi.reset_interval_count,
					pv.billing_interval,
					pv.billing_interval_count,
					COALESCE(s.current_period_start, s.starts_at) AS period_start_at,
					COALESCE(s.current_period_end, s.expires_at) AS period_end_at,
					0 AS source_rank,
					s.created_at AS sort_at,
					s.id::text AS sort_id
				FROM subscriptions s
				JOIN plan_items pi
					ON pi.project_id = s.project_id
					AND pi.plan_version_id = s.plan_version_id
				JOIN plan_versions pv
					ON pv.project_id = pi.project_id
					AND pv.id = pi.plan_version_id
				WHERE s.project_id = ${projectId}
					AND s.customer_id = ${customer}
					AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (s.expires_at IS NULL OR s.expires_at > now())
					AND pi.feature_id = ${String(feature.id)}
					AND pi.item_kind = 'meter_limit'

				UNION ALL

				SELECT
					pi.id AS plan_item_id,
					NULL::uuid AS subscription_id,
					g.id AS plan_grant_id,
					pi.quantity,
					'blocked'::text AS overage_policy,
					pi.reset_interval,
					pi.reset_interval_count,
					pv.billing_interval,
					pv.billing_interval_count,
					g.starts_at AS period_start_at,
					g.ends_at AS period_end_at,
					1 AS source_rank,
					g.created_at AS sort_at,
					g.id::text AS sort_id
				FROM plan_grants g
				JOIN plan_items pi
					ON pi.project_id = g.project_id
					AND pi.plan_version_id = g.plan_version_id
				JOIN plan_versions pv
					ON pv.project_id = pi.project_id
					AND pv.id = pi.plan_version_id
				WHERE g.project_id = ${projectId}
					AND g.customer_id = ${customer}
					AND g.status = 'active'
					AND g.origin <> 'default'
					AND (g.ends_at IS NULL OR g.ends_at > now())
					AND pi.feature_id = ${String(feature.id)}
					AND pi.item_kind = 'meter_limit'

				UNION ALL

				-- The default plan at the version the account's next write applies (a write has caught
				-- up first, so it is the grant's own), windowed from where it started, or would start.
				SELECT
					pi.id AS plan_item_id,
					NULL::uuid AS subscription_id,
					d.grant_id AS plan_grant_id,
					pi.quantity,
					'blocked'::text AS overage_policy,
					pi.reset_interval,
					pi.reset_interval_count,
					pv.billing_interval,
					pv.billing_interval_count,
					d.anchor_at AS period_start_at,
					NULL::timestamptz AS period_end_at,
					CASE WHEN d.grant_id IS NULL THEN 2 ELSE 1 END AS source_rank,
					d.created_at AS sort_at,
					COALESCE(d.grant_id::text, '') AS sort_id
				FROM (${defaultPlanReadGrantSql(projectId, customer)}) d
				JOIN plan_items pi
					ON pi.project_id = ${projectId} AND pi.plan_version_id = d.plan_version_id
				JOIN plan_versions pv ON pv.project_id = pi.project_id AND pv.id = pi.plan_version_id
				WHERE pi.feature_id = ${String(feature.id)}
					AND pi.item_kind = 'meter_limit'
			) sources
			ORDER BY source_rank, sort_at, sort_id
		`,
	);
}

/**
 * The account's meter limit on a feature from the sources that apply to it: the anchor source, whose
 * window, overage policy and price the limit takes, and the quantity it allows.
 *
 * A paying subscription's limit comes before a plan grant's. Among paying subscriptions the base
 * plan anchors the limit (the newest, should an account hold several), or the newest add-on when
 * no base plan limits the feature. Each add-on limit that can join the anchor's window adds its
 * quantity: both are hard caps (`overage_policy` blocked) with the same reset cadence. Postpaid
 * overage is invoiced against the anchor item's own quantity, so a limit that allows it never
 * sums. Publication and add-on purchases refuse limits that cannot join; one that reaches an
 * account another way, such as a later plan change, is left out rather than failing usage.
 */
export function combineMeterLimits(
	candidates: readonly MeterLimitRow[],
	scale: number,
): { anchor: MeterLimitRow; quantity: string } | null {
	const paid = candidates.filter((row) => row.subscription_id !== null);
	if (paid.length === 0) {
		const first = candidates[0];
		return first === undefined
			? null
			: { anchor: first, quantity: databaseDecimal(first.quantity, "meter limit", scale) };
	}
	const newestFirst = [...paid].sort(
		(left, right) => new Date(right.sort_at).getTime() - new Date(left.sort_at).getTime(),
	);
	const anchor = newestFirst.find((row) => row.plan_kind === "base") ?? newestFirst[0];
	if (anchor === undefined) return null;
	let units = 0n;
	for (const row of paid) {
		if (row === anchor || (row.plan_kind === "addon" && meterLimitsJoin(anchor, row))) {
			units += decimalToUnits(databaseDecimal(row.quantity, "meter limit", scale), scale);
		}
	}
	return { anchor, quantity: unitsToDecimal(units, scale) };
}

/** Whether two meter limits can share one window: hard caps with the same reset cadence. */
export function meterLimitsJoin(
	left: Pick<MeterLimitRow, "overage_policy" | "reset_interval" | "reset_interval_count">,
	right: Pick<MeterLimitRow, "overage_policy" | "reset_interval" | "reset_interval_count">,
): boolean {
	return (
		left.overage_policy === "blocked" &&
		right.overage_policy === "blocked" &&
		left.reset_interval === right.reset_interval &&
		left.reset_interval_count === right.reset_interval_count
	);
}

/** The window the anchor source counts its limit in right now; see `meterLimitWindowBounds`. */
export function meterLimitBounds(anchor: MeterLimitRow, now: Date): { start: Date; end: Date } {
	const reset = storedCadence(anchor.reset_interval, anchor.reset_interval_count);
	// A plan grant, or the default plan an unrecorded account would get, windows from its start.
	return anchor.plan_grant_id !== null || anchor.subscription_id === null
		? planGrantWindowBounds(anchor.period_start_at, anchor.period_end_at, reset, now)
		: meterLimitWindowBounds(
				anchor.period_start_at,
				anchor.period_end_at,
				reset,
				now,
				optionalStoredCadence(anchor.billing_interval, anchor.billing_interval_count),
			);
}
