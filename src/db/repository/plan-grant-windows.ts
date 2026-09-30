import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import type { CadenceUnit } from "../../shared/cadence";
import { defaultPlanReadGrantSql } from "./default-plan-sql";
import { planGrantWindowBounds, storedCadence } from "./meter-limit-windows";
import { executeRows } from "./query";
import type { QueryExecutor } from "./types";

/**
 * The reset window an account-wide allocation item of a plan grant is in now. A write creates its
 * allowance the first time the account spends in it; until then reads count the allowance as if
 * it existed, so an idle account costs nothing at a reset and never reads an empty window.
 */
export interface PlanGrantWindow {
	/** Null for the default plan the account starts holding on its next write. */
	grantId: string | null;
	featureId: string;
	featureKey: string;
	unit: string;
	scale: number;
	planItemId: string;
	quantity: string;
	/**
	 * Where the window's allowance starts: the reset window's start, or, when the grant holds an
	 * allowance of the feature from another reset that ends inside this window, where that one
	 * ends. Changing a reset never refills a window: the allowance it already gave runs to its end
	 * and the new reset's quantity starts there. A start after now is a window not open yet.
	 */
	start: Date;
	end: Date | null;
	expiresAt: Date | null;
	/** `once` for an item without a reset, otherwise the window start. */
	windowKey: string;
	/**
	 * The window's allowance as a write created it. For the default plan the account has not
	 * started yet, the allowance the grant it will replace left in this same window.
	 */
	allocation: WindowAllocation | null;
	/** The allowance's row, when a write created it. */
	allocationId: string | null;
	/**
	 * Whether the grant's allowance ended before its window did, because a version the grant moved
	 * to dropped the feature, and the version it holds now has the feature again on the same reset.
	 * The window already gave that allowance, so reads count what was left of it and the account's
	 * next write in the window reopens it with its use kept, instead of granting it again.
	 */
	resumes: boolean;
}

export interface WindowAllocation {
	quantity: string;
	reversed: string;
	consumed: string;
	held: string;
}

/** An allowance reads count before any write created it. */
export interface PendingAllowance extends WindowAllocation {
	featureId: string;
	featureKey: string;
	unit: string;
	scale: number;
	expiresAt: Date | null;
}

interface WindowRow {
	grant_id: string | null;
	anchor_at: Date | string;
	ends_at: Date | string | null;
	plan_item_id: string | number | bigint;
	feature_id: string | number | bigint;
	feature_key: string;
	unit: string;
	credit_scale: number;
	quantity: string;
	reset_interval: CadenceUnit | null;
	reset_interval_count: number;
	expires_after_seconds: number | null;
	latest_id: string | number | bigint | null;
	latest_period_start_at: Date | string | null;
	latest_expires_at: Date | string | null;
	latest_reversed_at: Date | string | null;
	latest_quantity: string | null;
	latest_reversed: string | null;
	latest_consumed: string | null;
	latest_held: string | null;
	other_reset_ends_at: Date | string | null;
	db_now: Date | string;
}

/**
 * The current window of every account-wide allocation item of the account's active plan grants,
 * optionally for one feature. With `pendingDefault`, which reads pass, the default plan counts as
 * the account's next write will leave it (see `defaultPlanReadVersionSql`): at the version that
 * write applies, not at all when that write ends it, and, for an account that would start it,
 * anchored where its previous default-plan grant was, or now. A null account is one Quotum has not
 * recorded yet.
 */
export async function readPlanGrantWindows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	options: { featureId: string | null; pendingDefault: boolean },
): Promise<{ windows: PlanGrantWindow[]; now: Date }> {
	const customer = drizzleSql`${customerId}::uuid`;
	const rows = await executeRows<WindowRow>(
		executor,
		drizzleSql`
			WITH sources AS (
				SELECT g.id AS grant_id, g.plan_version_id, g.starts_at AS anchor_at, g.ends_at,
					g.id AS allocations_grant_id
				FROM plan_grants g
				WHERE g.project_id = ${projectId}
					AND g.customer_id = ${customer}
					AND g.status = 'active'
					AND (g.ends_at IS NULL OR g.ends_at > now())
					${options.pendingDefault ? drizzleSql`AND g.origin <> 'default'` : drizzleSql``}
				${
					options.pendingDefault
						? drizzleSql`
							UNION ALL
							SELECT d.grant_id, d.plan_version_id, d.anchor_at, NULL::timestamptz,
								d.allocations_grant_id
							FROM (${defaultPlanReadGrantSql(projectId, customer)}) d
						`
						: drizzleSql``
				}
			)
			SELECT source.grant_id, source.anchor_at, source.ends_at, item.id AS plan_item_id,
				item.feature_id, feature.key AS feature_key, feature.unit, feature.credit_scale,
				item.quantity::text AS quantity, item.reset_interval,
				item.reset_interval_count, item.expires_after_seconds,
				latest.id AS latest_id,
				latest.period_start_at AS latest_period_start_at,
				latest.expires_at AS latest_expires_at,
				latest.reversed_at AS latest_reversed_at,
				latest.quantity::text AS latest_quantity,
				latest.reversed_quantity::text AS latest_reversed,
				latest.consumed_quantity::text AS latest_consumed,
				latest.held_quantity::text AS latest_held,
				other_reset.ends_at AS other_reset_ends_at,
				now() AS db_now
			FROM sources source
			JOIN plan_items item
				ON item.project_id = ${projectId}
				AND item.plan_version_id = source.plan_version_id
				AND item.item_kind = 'allocation'
				AND item.allocation_scope = 'account'
				${options.featureId === null ? drizzleSql`` : drizzleSql`AND item.feature_id = ${options.featureId}::bigint`}
			JOIN features feature ON feature.project_id = item.project_id AND feature.id = item.feature_id
			-- The grant's latest allowance of the feature on the same reset. A version move keeps an
			-- allowance only when the reset stays, so one on another reset never stands in for it.
			LEFT JOIN LATERAL (
				SELECT allocation.id, allocation.period_start_at, allocation.expires_at,
					allocation.reversed_at, allocation.quantity, allocation.reversed_quantity,
					allocation.consumed_quantity, allocation.held_quantity
				FROM balance_allocations allocation
				JOIN plan_items allocated
					ON allocated.project_id = allocation.project_id AND allocated.id = allocation.plan_item_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.plan_grant_id = source.allocations_grant_id
					AND allocation.feature_id = item.feature_id
					AND allocated.reset_interval IS NOT DISTINCT FROM item.reset_interval
					AND allocated.reset_interval_count = item.reset_interval_count
				ORDER BY allocation.period_start_at DESC
				LIMIT 1
			) latest ON true
			-- When the grant's allowances of the feature on another reset end: a version move that
			-- changes the reset keeps the allowance the window already gave, and the new reset's
			-- quantity starts where it ends. An account that has not started its grant yet holds none.
			LEFT JOIN LATERAL (
				SELECT max(allocation.expires_at) AS ends_at
				FROM balance_allocations allocation
				JOIN plan_items allocated
					ON allocated.project_id = allocation.project_id AND allocated.id = allocation.plan_item_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.plan_grant_id = source.grant_id
					AND allocation.feature_id = item.feature_id
					AND (
						allocated.reset_interval IS DISTINCT FROM item.reset_interval
						OR allocated.reset_interval_count <> item.reset_interval_count
					)
			) other_reset ON true
			ORDER BY source.grant_id NULLS LAST, item.id
		`,
	);
	const now = new Date(rows[0]?.db_now ?? Date.now());
	return { windows: rows.map((row) => toWindow(row, now)), now };
}

function toWindow(row: WindowRow, now: Date): PlanGrantWindow {
	const anchor = new Date(row.anchor_at);
	const endsAt = row.ends_at === null ? null : new Date(row.ends_at);
	const reset: { start: Date; end: Date | null } =
		row.reset_interval === null
			? { start: anchor, end: endsAt }
			: planGrantWindowBounds(
					anchor,
					endsAt,
					storedCadence(row.reset_interval, row.reset_interval_count),
					now,
				);
	const otherResetEndsAt =
		row.other_reset_ends_at === null ? null : new Date(row.other_reset_ends_at);
	const window = {
		start:
			otherResetEndsAt !== null && otherResetEndsAt > reset.start ? otherResetEndsAt : reset.start,
		end: reset.end,
	};
	const expiresAt =
		row.expires_after_seconds === null
			? window.end
			: new Date(
					Math.min(
						window.end?.getTime() ?? Number.POSITIVE_INFINITY,
						window.start.getTime() + row.expires_after_seconds * 1000,
					),
				);
	const created =
		row.latest_period_start_at !== null &&
		new Date(row.latest_period_start_at).getTime() === window.start.getTime();
	const resumes =
		created &&
		row.grant_id !== null &&
		row.latest_reversed_at === null &&
		row.latest_expires_at !== null &&
		new Date(row.latest_expires_at) <= now &&
		(expiresAt === null || expiresAt > now);
	return {
		grantId: row.grant_id,
		featureId: String(row.feature_id),
		featureKey: row.feature_key,
		unit: row.unit,
		scale: Number(row.credit_scale),
		planItemId: String(row.plan_item_id),
		quantity: row.quantity,
		start: window.start,
		end: window.end,
		expiresAt,
		windowKey: row.reset_interval === null ? "once" : window.start.toISOString(),
		allocation: created
			? {
					quantity: row.latest_quantity ?? "0",
					reversed: row.latest_reversed ?? "0",
					consumed: row.latest_consumed ?? "0",
					held: row.latest_held ?? "0",
				}
			: null,
		allocationId: created && row.latest_id !== null ? String(row.latest_id) : null,
		resumes,
	};
}

/**
 * What reads add to the account's allocations: each current window of its plan grants that no
 * write has created yet, in full, what is left of an allowance a write will reopen, and the default
 * plan it would start, with what its previous default-plan grant left in the same window. A window
 * whose allowance would have expired, or that opens later (see `PlanGrantWindow.start`), adds
 * nothing.
 */
export async function readPendingAllowances(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	featureId: string | null,
): Promise<PendingAllowance[]> {
	const { windows, now } = await readPlanGrantWindows(executor, projectId, customerId, {
		featureId,
		pendingDefault: true,
	});
	return windows.flatMap((window) => {
		if (window.start > now) return [];
		if (window.expiresAt !== null && window.expiresAt <= now) return [];
		if (window.grantId !== null && window.allocation !== null && !window.resumes) return [];
		const allocation = window.allocation ?? {
			quantity: window.quantity,
			reversed: "0",
			consumed: "0",
			held: "0",
		};
		return [
			{
				...allocation,
				featureId: window.featureId,
				featureKey: window.featureKey,
				unit: window.unit,
				scale: window.scale,
				expiresAt: window.expiresAt,
			},
		];
	});
}

/**
 * Creates the allowances of the account's plan grants for the windows they are in now, for one
 * feature, before a write locks its allocations, and reopens one a version move ended early when
 * the grant's version holds the feature again (see `PlanGrantWindow.resumes`). Every change to a
 * grant locks the customer first, so sharing that lock here orders this after a supersede, end or
 * version move that began first, and before one that begins later, which then sees these rows.
 * Returns how many it created or reopened.
 */
export async function openPlanGrantWindows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	featureId: string,
): Promise<number> {
	const missing = (candidates: PlanGrantWindow[], now: Date) =>
		candidates.filter(
			(window) =>
				window.grantId !== null &&
				window.start <= now &&
				(window.allocation === null || window.resumes) &&
				(window.expiresAt === null || window.expiresAt > now),
		);
	const first = await readPlanGrantWindows(executor, projectId, customerId, {
		featureId,
		pendingDefault: false,
	});
	const due = missing(first.windows, first.now);
	if (due.length === 0) return 0;
	await executeRows(
		executor,
		drizzleSql`
			SELECT id FROM customers WHERE project_id = ${projectId} AND id = ${customerId} FOR SHARE
		`,
	);
	const locked = await readPlanGrantWindows(executor, projectId, customerId, {
		featureId,
		pendingDefault: false,
	});
	const dueNow = missing(locked.windows, locked.now);
	const open = dueNow.filter((window) => !window.resumes);
	const reopened = await reopenPlanGrantAllowances(
		executor,
		projectId,
		dueNow.filter((window) => window.resumes),
	);
	if (open.length === 0) return reopened;
	const inserted = await executeRows<{ id: string }>(
		executor,
		drizzleSql`
			INSERT INTO balance_allocations (
				project_id, customer_id, feature_id, plan_item_id, plan_grant_id, source_kind,
				source_key, quantity, period_start_at, period_end_at, expires_at
			)
			SELECT *
			FROM (VALUES ${drizzleSql.join(
				open.map((window) => windowValues(projectId, customerId, window)),
				drizzleSql`, `,
			)}) AS candidate (
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
			RETURNING id
		`,
	);
	return inserted.length + reopened;
}

/**
 * Reopens allowances a version move ended before their window did, now that the grant's version
 * holds the feature again: each keeps its quantity and use, moves to the version's item and expires
 * when that item's allowance for the window would. A concurrent write that reopened it first leaves
 * nothing to do here.
 */
async function reopenPlanGrantAllowances(
	executor: QueryExecutor,
	projectId: string,
	windows: PlanGrantWindow[],
): Promise<number> {
	if (windows.length === 0) return 0;
	const reopened = await executeRows<{ id: string }>(
		executor,
		drizzleSql`
			UPDATE balance_allocations allocation
			SET plan_item_id = candidate.plan_item_id,
				expires_at = candidate.expires_at,
				updated_at = now()
			FROM (VALUES ${drizzleSql.join(
				windows.map(
					(window) => drizzleSql`(
						${window.allocationId}::bigint,
						${window.planItemId}::bigint,
						${window.expiresAt?.toISOString() ?? null}::timestamptz
					)`,
				),
				drizzleSql`, `,
			)}) AS candidate (id, plan_item_id, expires_at)
			WHERE allocation.project_id = ${projectId}
				AND allocation.id = candidate.id
				AND allocation.reversed_at IS NULL
				AND allocation.expires_at <= now()
			RETURNING allocation.id
		`,
	);
	return reopened.length;
}

function windowValues(projectId: string, customerId: string, window: PlanGrantWindow): DrizzleSQL {
	return drizzleSql`(
		${projectId}::uuid,
		${customerId}::uuid,
		${window.featureId}::bigint,
		${window.planItemId}::bigint,
		${window.grantId}::uuid,
		'reward',
		${`plan_grant:${window.grantId}:${window.planItemId}:${window.windowKey}`},
		${window.quantity}::numeric,
		${window.start.toISOString()}::timestamptz,
		${window.end?.toISOString() ?? null}::timestamptz,
		${window.expiresAt?.toISOString() ?? null}::timestamptz
	)`;
}

/**
 * Hands a default-plan grant the allowances its predecessor left in the windows still running, so
 * falling back within a window resumes what was left of it instead of refilling it. Only an
 * allowance whose feature keeps the same reset on the version the grant holds is carried; it
 * expires when its window's allowance would.
 */
export async function resumeDefaultPlanAllowances(
	executor: QueryExecutor,
	projectId: string,
	fromGrantId: string,
	toGrantId: string,
	planVersionId: string,
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations allocation
			SET plan_grant_id = ${toGrantId}::uuid,
				plan_item_id = item.id,
				expires_at = CASE
					WHEN item.expires_after_seconds IS NULL THEN allocation.period_end_at
					ELSE LEAST(
						allocation.period_end_at,
						allocation.period_start_at + item.expires_after_seconds * interval '1 second'
					)
				END,
				updated_at = now()
			FROM plan_items previous, plan_items item
			WHERE allocation.project_id = ${projectId}
				AND allocation.plan_grant_id = ${fromGrantId}::uuid
				AND allocation.period_start_at <= now()
				AND (allocation.period_end_at IS NULL OR allocation.period_end_at > now())
				AND previous.project_id = allocation.project_id
				AND previous.id = allocation.plan_item_id
				AND item.project_id = allocation.project_id
				AND item.plan_version_id = ${planVersionId}::bigint
				AND item.item_kind = 'allocation'
				AND item.allocation_scope = 'account'
				AND item.feature_id = allocation.feature_id
				AND item.reset_interval IS NOT DISTINCT FROM previous.reset_interval
				AND item.reset_interval_count = previous.reset_interval_count
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
