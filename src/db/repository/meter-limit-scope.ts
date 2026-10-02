import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { databaseDecimal } from "../../billing/decimal";
import type { MeterLimitScope } from "./meter-limit-sources";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

/**
 * Declared meter-limit scope (PC-04). A meter limit counts usage in a **scope set**: the open usage
 * windows of one customer, feature and window bounds that its declared scope gathers.
 *
 * - `account`: every row, whatever its entity, filter or scope.
 * - `entity` for entity E: every row of E.
 * - `entity` for usage without an entity: the rows without an entity that were not written under
 *   the account scope (the no-entity bucket, which is not the account aggregate).
 *
 * Writes go to one row per scope set, written with no filter; rows are never rewritten, so each
 * keeps the usage, subscription and plan item it was recorded against, and invoicing and corrections
 * read them as before. Rows written before declared scopes (`scope` NULL) belong where their entity
 * places them.
 */

/** The rows a limit counts for one write or read. */
export interface MeterLimitScopeSelector {
	scope: MeterLimitScope;
	/** The entity of an entity-scoped set; null for the account and the no-entity bucket. */
	entityId: string | null;
}

export interface MeterLimitWindowBounds {
	projectId: string;
	customerId: string;
	featureId: string;
	windowStartAt: Date;
	windowEndAt: Date;
}

/** The scope set a limit counts in for usage of `entityId` under `scope`. */
export function meterLimitScopeSelector(
	scope: MeterLimitScope,
	entityId: string | null,
): MeterLimitScopeSelector {
	return { scope, entityId: scope === "entity" ? entityId : null };
}

/** The SQL condition selecting a scope set's rows from `usage_windows` aliased as `alias`. */
export function scopeSetSql(alias: DrizzleSQL, selector: MeterLimitScopeSelector): DrizzleSQL {
	if (selector.scope === "account") return drizzleSql`TRUE`;
	if (selector.entityId !== null)
		return drizzleSql`${alias}.entity_id = ${selector.entityId}::bigint`;
	return drizzleSql`(${alias}.entity_id IS NULL AND (${alias}.scope IS NULL OR ${alias}.scope = 'entity'))`;
}

/**
 * The scope a write or read counts in. A change from account to entity scope inside an open window
 * is a split the account row cannot attribute to entities, so while the window holds an account row
 * with usage or an active hold the account aggregate keeps governing; the entity rule starts with
 * the next window. A change from entity to account takes effect at once: the account set already
 * contains every entity's rows.
 */
export async function governingMeterLimitScope(
	executor: QueryExecutor,
	window: MeterLimitWindowBounds,
	declared: MeterLimitScope,
): Promise<MeterLimitScope> {
	if (declared === "account") return "account";
	const row = await executeOne<{ held: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1
				FROM usage_windows account_row
				WHERE account_row.project_id = ${window.projectId}
					AND account_row.customer_id = ${window.customerId}
					AND account_row.feature_id = ${window.featureId}::bigint
					AND account_row.window_start_at = ${window.windowStartAt.toISOString()}::timestamptz
					AND account_row.window_end_at = ${window.windowEndAt.toISOString()}::timestamptz
					AND account_row.scope = 'account'
					AND (
						account_row.usage > 0
						OR EXISTS (
							SELECT 1
							FROM reservations reservation
							WHERE reservation.project_id = account_row.project_id
								AND reservation.usage_window_id = account_row.id
								AND reservation.status = 'active'
								AND reservation.expires_at > now()
						)
					)
			) AS held
		`,
	);
	return row?.held === true ? "account" : "entity";
}

/** The usage and active holds a scope set counts, optionally leaving one reservation out. */
export async function readScopeSetExposure(
	executor: QueryExecutor,
	window: MeterLimitWindowBounds,
	selector: MeterLimitScopeSelector,
	excludeReservationId: string | null = null,
): Promise<{ usage: string; held: string }> {
	const row = await executeOne<{ usage: unknown; held: unknown }>(
		executor,
		drizzleSql`
			SELECT
				COALESCE(sum(scoped.usage), 0)::text AS usage,
				COALESCE(sum(holds.held), 0)::text AS held
			FROM usage_windows scoped
			LEFT JOIN LATERAL (
				SELECT sum(reservation.held_quantity) AS held
				FROM reservations reservation
				WHERE reservation.project_id = scoped.project_id
					AND reservation.usage_window_id = scoped.id
					AND reservation.status = 'active'
					AND reservation.expires_at > now()
					AND (
						${excludeReservationId}::uuid IS NULL
						OR reservation.id <> ${excludeReservationId}::uuid
					)
			) holds ON true
			WHERE scoped.project_id = ${window.projectId}
				AND scoped.customer_id = ${window.customerId}
				AND scoped.feature_id = ${window.featureId}::bigint
				AND scoped.window_start_at = ${window.windowStartAt.toISOString()}::timestamptz
				AND scoped.window_end_at = ${window.windowEndAt.toISOString()}::timestamptz
				AND ${scopeSetSql(drizzleSql`scoped`, selector)}
		`,
	);
	return {
		usage: databaseDecimal(row?.usage ?? "0", "scope usage"),
		held: databaseDecimal(row?.held ?? "0", "scope holds"),
	};
}
