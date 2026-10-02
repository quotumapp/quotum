import { sql as drizzleSql } from "drizzle-orm";
import { databaseDecimal, decimalToUnits, unitsToDecimal } from "../../billing/decimal";
import {
	governingMeterLimitScope,
	type MeterLimitScopeSelector,
	meterLimitScopeSelector,
} from "./meter-limit-scope";
import {
	combineMeterLimits,
	type MeterLimitScope,
	meterLimitBounds,
	queryMeterLimitRows,
} from "./meter-limit-sources";
import { executeRows } from "./query";
import type { QueryExecutor, TransactionalQueryExecutor } from "./types";
import { type MixedScopeAccount, readMixedScopeAccounts } from "./usage-scopes-report";

/**
 * The stopped-service transition to declared meter-limit scope (PC-04). `snapshot` runs on the
 * restored database before `quotum migrate` and reads only columns both schemas have; `verify` runs
 * after it and checks, against the snapshot, that nothing moved and that every hold and every
 * correction will count where the declared scope enforces. The service starts only once `verify`
 * passes.
 */

export const usageScopesSnapshotVersion = 1;

export interface SnapshotWindow {
	id: string;
	projectId: string;
	customerId: string;
	featureId: string;
	entityId: string | null;
	filterKey: string | null;
	windowStartAt: string;
	windowEndAt: string;
	usage: string;
	subscriptionId: string | null;
	anchorPlanItemId: string | null;
}

export interface SnapshotHold {
	id: string;
	projectId: string;
	usageWindowId: string;
	heldQuantity: string;
}

export interface SnapshotInvoicePeriod {
	id: string;
	projectId: string;
	status: string;
	subscriptionId: string;
	planItemId: string;
	periodStartAt: string;
	periodEndAt: string;
	usageQuantity: string;
	includedQuantity: string;
	billableQuantity: string;
	amountMinor: string;
}

/** A closed window group no invoice period has billed yet, as the materializer would sum it. */
export interface SnapshotUnbilledGroup {
	projectId: string;
	subscriptionId: string;
	planItemId: string;
	windowStartAt: string;
	windowEndAt: string;
	usage: string;
}

export interface UsageScopesSnapshot {
	version: typeof usageScopesSnapshotVersion;
	takenAt: string;
	windows: SnapshotWindow[];
	holds: SnapshotHold[];
	invoicePeriods: SnapshotInvoicePeriod[];
	unbilledGroups: SnapshotUnbilledGroup[];
}

export interface TransitionCheck {
	name: string;
	passed: boolean;
	/** What failed, or for an informational finding what was found; bounded for printing. */
	details: string[];
	/** How many details there were in all. */
	total: number;
}

export interface OverCapScopeSet {
	customerId: string;
	featureId: string;
	/** The names the report uses: project instance, billing account, feature and external entity. */
	projectKey: string;
	billingAccountId: string;
	featureKey: string;
	entityExternalId: string | null;
	scope: MeterLimitScope;
	entityId: string | null;
	windowStartAt: string;
	windowEndAt: string;
	usage: string;
	held: string;
	limit: string;
}

export interface UsageScopesVerification {
	passed: boolean;
	checks: TransitionCheck[];
	/** Hard caps that usage plus holds already exceed: denied while no room is left, not failures. */
	overCap: OverCapScopeSet[];
}

/** A snapshot file that is not one this release wrote. */
export class UsageScopesSnapshotError extends Error {}

const detailLimit = 20;

/** Reads the snapshot inside one read-only, repeatable-read transaction. */
export async function readUsageScopesSnapshot(
	database: TransactionalQueryExecutor,
): Promise<UsageScopesSnapshot> {
	return await database.transaction(async (tx) => {
		await executeRows(tx, drizzleSql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
		const [clock] = await executeRows<{ now: Date | string }>(tx, drizzleSql`SELECT now() AS now`);
		const takenAt = iso(clock?.now ?? new Date());
		return {
			version: usageScopesSnapshotVersion,
			takenAt,
			windows: await readWindows(tx),
			holds: await readHolds(tx),
			invoicePeriods: await readInvoicePeriods(tx),
			unbilledGroups: await readUnbilledGroups(tx, takenAt),
		};
	});
}

/** Parses a snapshot file, refusing one this release did not write. */
export function parseUsageScopesSnapshot(text: string): UsageScopesSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UsageScopesSnapshotError("The baseline is not a JSON snapshot.");
	}
	const snapshot = parsed as Partial<UsageScopesSnapshot> | null;
	if (
		snapshot === null ||
		typeof snapshot !== "object" ||
		snapshot.version !== usageScopesSnapshotVersion ||
		!Array.isArray(snapshot.windows) ||
		!Array.isArray(snapshot.holds) ||
		!Array.isArray(snapshot.invoicePeriods) ||
		!Array.isArray(snapshot.unbilledGroups)
	) {
		throw new UsageScopesSnapshotError(
			`The baseline is not a version ${usageScopesSnapshotVersion} usage scopes snapshot.`,
		);
	}
	return snapshot as UsageScopesSnapshot;
}

/** Verifies the migrated database against the snapshot, inside one read-only transaction. */
export async function verifyUsageScopesTransition(
	database: TransactionalQueryExecutor,
	baseline: UsageScopesSnapshot,
): Promise<UsageScopesVerification> {
	return await database.transaction(async (tx) => {
		await executeRows(tx, drizzleSql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
		const windows = await readWindows(tx);
		const scoped = await readScopedOpenWindows(tx);
		const governing = await governingScopes(tx, scoped);
		const checks = [
			checkUsageTotals(baseline.windows, windows),
			await checkHolds(tx, baseline.holds, scoped, governing),
			await checkCorrectionRouting(tx, scoped, governing),
			// Windows that closed during the transition are not usage the snapshot could have seen.
			checkInvoiceAttribution(
				baseline,
				await readInvoicePeriods(tx),
				await readUnbilledGroups(tx, baseline.takenAt),
			),
			checkNoCapacityGain(scoped, governing),
			await checkBlockers(tx, scoped, governing),
		];
		return {
			passed: checks.every((check) => check.passed),
			checks,
			overCap: overCapSets(scoped, governing),
		};
	});
}

function readWindows(executor: QueryExecutor): Promise<SnapshotWindow[]> {
	return executeRows<SnapshotWindow>(
		executor,
		drizzleSql`
			SELECT
				id::text AS "id",
				project_id::text AS "projectId",
				customer_id::text AS "customerId",
				feature_id::text AS "featureId",
				entity_id::text AS "entityId",
				filter_key AS "filterKey",
				to_char(window_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "windowStartAt",
				to_char(window_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "windowEndAt",
				usage::text AS "usage",
				subscription_id::text AS "subscriptionId",
				anchor_plan_item_id::text AS "anchorPlanItemId"
			FROM usage_windows
			ORDER BY id
		`,
	);
}

function readHolds(executor: QueryExecutor): Promise<SnapshotHold[]> {
	return executeRows<SnapshotHold>(
		executor,
		drizzleSql`
			SELECT id::text AS "id", project_id::text AS "projectId",
				usage_window_id::text AS "usageWindowId", held_quantity::text AS "heldQuantity"
			FROM reservations
			WHERE status = 'active' AND usage_window_id IS NOT NULL
			ORDER BY id
		`,
	);
}

function readInvoicePeriods(executor: QueryExecutor): Promise<SnapshotInvoicePeriod[]> {
	return executeRows<SnapshotInvoicePeriod>(
		executor,
		drizzleSql`
			SELECT id::text AS "id", project_id::text AS "projectId", status,
				subscription_id::text AS "subscriptionId",
				plan_item_id::text AS "planItemId",
				to_char(period_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "periodStartAt",
				to_char(period_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "periodEndAt",
				usage_quantity::text AS "usageQuantity", included_quantity::text AS "includedQuantity",
				billable_quantity::text AS "billableQuantity", amount_minor::text AS "amountMinor"
			FROM usage_invoice_periods
			WHERE status IN ('pending', 'processing')
			ORDER BY id
		`,
	);
}

/** Closed window groups no invoice period bills, as of `asOf` (the snapshot's time). */
function readUnbilledGroups(
	executor: QueryExecutor,
	asOf: string,
): Promise<SnapshotUnbilledGroup[]> {
	return executeRows<SnapshotUnbilledGroup>(
		executor,
		drizzleSql`
			SELECT
				usage_window.project_id::text AS "projectId",
				usage_window.subscription_id::text AS "subscriptionId",
				usage_window.anchor_plan_item_id::text AS "planItemId",
				to_char(usage_window.window_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "windowStartAt",
				to_char(usage_window.window_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "windowEndAt",
				sum(usage_window.usage)::text AS "usage"
			FROM usage_windows usage_window
			WHERE usage_window.window_end_at <= ${asOf}::timestamptz
				AND usage_window.subscription_id IS NOT NULL
				AND usage_window.anchor_plan_item_id IS NOT NULL
				AND NOT EXISTS (
					SELECT 1 FROM usage_invoice_periods period
					WHERE period.project_id = usage_window.project_id
						AND period.subscription_id = usage_window.subscription_id
						AND period.plan_item_id = usage_window.anchor_plan_item_id
						AND period.period_start_at = usage_window.window_start_at
						AND period.period_end_at = usage_window.window_end_at
				)
			GROUP BY usage_window.project_id, usage_window.subscription_id,
				usage_window.anchor_plan_item_id, usage_window.window_start_at, usage_window.window_end_at
			ORDER BY 1, 2, 3, 4
		`,
	);
}

/** An open window row with its scope and active holds, as the migrated schema holds it. */
interface ScopedWindow extends SnapshotWindow {
	scope: MeterLimitScope | null;
	held: string;
	projectKey: string;
	billingAccountId: string;
	featureKey: string;
	entityExternalId: string | null;
}

function readScopedOpenWindows(executor: QueryExecutor): Promise<ScopedWindow[]> {
	return executeRows<ScopedWindow>(
		executor,
		drizzleSql`
			SELECT
				usage_window.id::text AS "id",
				usage_window.project_id::text AS "projectId",
				usage_window.customer_id::text AS "customerId",
				usage_window.feature_id::text AS "featureId",
				usage_window.entity_id::text AS "entityId",
				usage_window.filter_key AS "filterKey",
				to_char(usage_window.window_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "windowStartAt",
				to_char(usage_window.window_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS "windowEndAt",
				usage_window.usage::text AS "usage",
				usage_window.subscription_id::text AS "subscriptionId",
				usage_window.anchor_plan_item_id::text AS "anchorPlanItemId",
				usage_window.scope,
				project.key AS "projectKey",
				customer.billing_account_id AS "billingAccountId",
				feature.key AS "featureKey",
				entity.external_id AS "entityExternalId",
				COALESCE((
					SELECT sum(reservation.held_quantity)
					FROM reservations reservation
					WHERE reservation.project_id = usage_window.project_id
						AND reservation.usage_window_id = usage_window.id
						AND reservation.status = 'active'
				), 0)::text AS "held"
			FROM usage_windows usage_window
			JOIN projects project ON project.id = usage_window.project_id
			JOIN customers customer
				ON customer.project_id = usage_window.project_id AND customer.id = usage_window.customer_id
			JOIN features feature
				ON feature.project_id = usage_window.project_id AND feature.id = usage_window.feature_id
			LEFT JOIN entities entity
				ON entity.project_id = usage_window.project_id AND entity.id = usage_window.entity_id
			WHERE usage_window.window_end_at > now()
			ORDER BY usage_window.id
		`,
	);
}

/** The limit each open window group (customer, feature, bounds) counts under, or null. */
interface GroupLimit {
	declared: MeterLimitScope;
	scope: MeterLimitScope;
	limit: string;
	overagePolicy: "blocked" | "allowed";
	/** Whether the group's bounds are the limit's current window, which enforcement counts. */
	current: boolean;
}

function groupKey(
	row: Pick<SnapshotWindow, "customerId" | "featureId" | "windowStartAt" | "windowEndAt">,
) {
	return `${row.customerId}|${row.featureId}|${row.windowStartAt}|${row.windowEndAt}`;
}

async function governingScopes(
	executor: QueryExecutor,
	rows: readonly ScopedWindow[],
): Promise<Map<string, GroupLimit | null>> {
	const groups = new Map<string, GroupLimit | null>();
	const sources = new Map<string, Awaited<ReturnType<typeof queryMeterLimitRows>>>();
	const now = new Date();
	for (const row of rows) {
		const key = groupKey(row);
		if (groups.has(key)) continue;
		const account = `${row.projectId}|${row.customerId}|${row.featureId}`;
		const candidates =
			sources.get(account) ??
			(await queryMeterLimitRows(executor, row.projectId, row.customerId, { id: row.featureId }));
		sources.set(account, candidates);
		const scale = await featureScale(executor, row.projectId, row.featureId);
		const combined = combineMeterLimits(candidates, scale);
		if (combined === null) {
			groups.set(key, null);
			continue;
		}
		const declared = combined.anchor.allocation_scope;
		const bounds = {
			windowStartAt: new Date(row.windowStartAt),
			windowEndAt: new Date(row.windowEndAt),
		};
		const scope = await governingMeterLimitScope(
			executor,
			{ projectId: row.projectId, customerId: row.customerId, featureId: row.featureId, ...bounds },
			declared,
		);
		const current = meterLimitBounds(combined.anchor, now);
		groups.set(key, {
			declared,
			scope,
			limit: combined.quantity,
			overagePolicy: combined.anchor.overage_policy,
			current:
				current.start.getTime() === bounds.windowStartAt.getTime() &&
				current.end.getTime() === bounds.windowEndAt.getTime(),
		});
	}
	return groups;
}

const scales = new WeakMap<QueryExecutor, Map<string, number>>();

async function featureScale(
	executor: QueryExecutor,
	projectId: string,
	featureId: string,
): Promise<number> {
	const cached = scales.get(executor) ?? new Map<string, number>();
	scales.set(executor, cached);
	const known = cached.get(featureId);
	if (known !== undefined) return known;
	const [row] = await executeRows<{ credit_scale: number }>(
		executor,
		drizzleSql`
			SELECT credit_scale FROM features
			WHERE project_id = ${projectId}::uuid AND id = ${featureId}::bigint
		`,
	);
	const scale = Number(row?.credit_scale ?? 9);
	cached.set(featureId, scale);
	return scale;
}

/** Whether `row` belongs to the scope set `selector` gathers, the rule `scopeSetSql` encodes. */
export function inScopeSet(
	row: Pick<ScopedWindow, "entityId" | "scope">,
	selector: MeterLimitScopeSelector,
): boolean {
	if (selector.scope === "account") return true;
	if (selector.entityId !== null) return row.entityId === selector.entityId;
	return row.entityId === null && (row.scope === null || row.scope === "entity");
}

/** The scope set a row counts in under its group's governing scope. */
function selectorOf(
	row: Pick<ScopedWindow, "entityId">,
	limit: GroupLimit,
): MeterLimitScopeSelector {
	return meterLimitScopeSelector(limit.scope, row.entityId);
}

function checkUsageTotals(
	baseline: readonly SnapshotWindow[],
	current: readonly SnapshotWindow[],
): TransitionCheck {
	const details: string[] = [];
	const byId = new Map(current.map((row) => [row.id, row]));
	for (const before of baseline) {
		const after = byId.get(before.id);
		if (after === undefined) {
			details.push(`Window ${before.id} is missing.`);
			continue;
		}
		for (const field of [
			"customerId",
			"featureId",
			"entityId",
			"filterKey",
			"windowStartAt",
			"windowEndAt",
			"subscriptionId",
			"anchorPlanItemId",
		] as const) {
			if (before[field] !== after[field]) {
				details.push(`Window ${before.id} changed ${field}: ${before[field]} to ${after[field]}.`);
			}
		}
		if (!sameDecimal(before.usage, after.usage)) {
			details.push(`Window ${before.id} usage changed from ${before.usage} to ${after.usage}.`);
		}
		byId.delete(before.id);
	}
	for (const extra of byId.values()) {
		details.push(`Window ${extra.id} was written after the snapshot.`);
	}
	const sums = (rows: readonly SnapshotWindow[]) => {
		const totals = new Map<string, bigint>();
		for (const row of rows) {
			const key = `${row.subscriptionId}|${row.anchorPlanItemId}|${row.windowStartAt}|${row.windowEndAt}`;
			totals.set(
				key,
				(totals.get(key) ?? 0n) + decimalToUnits(databaseDecimal(row.usage, "usage"), 9),
			);
		}
		return totals;
	};
	const before = sums(baseline);
	const after = sums(current);
	for (const [key, units] of before) {
		if (after.get(key) !== units) {
			details.push(
				`Usage of subscription, plan item and window ${key} no longer sums to ${unitsToDecimal(units, 9)}.`,
			);
		}
	}
	return result("usage totals", details);
}

async function checkHolds(
	executor: QueryExecutor,
	baseline: readonly SnapshotHold[],
	scoped: readonly ScopedWindow[],
	governing: ReadonlyMap<string, GroupLimit | null>,
): Promise<TransitionCheck> {
	const details: string[] = [];
	const current = await readHolds(executor);
	const byId = new Map(current.map((hold) => [hold.id, hold]));
	const rows = new Map(scoped.map((row) => [row.id, row]));
	const entities = await reservationEntities(executor);
	for (const before of baseline) {
		const after = byId.get(before.id);
		if (after === undefined) {
			details.push(`Hold ${before.id} is no longer active.`);
			continue;
		}
		byId.delete(before.id);
		if (after.usageWindowId !== before.usageWindowId) {
			details.push(
				`Hold ${before.id} moved from window ${before.usageWindowId} to ${after.usageWindowId}.`,
			);
		}
		if (!sameDecimal(after.heldQuantity, before.heldQuantity)) {
			details.push(
				`Hold ${before.id} changed from ${before.heldQuantity} to ${after.heldQuantity}.`,
			);
		}
		const row = rows.get(after.usageWindowId);
		// A hold on a closed window settles as a late confirmation; the declared scope does not count it.
		if (row === undefined) continue;
		const limit = governing.get(groupKey(row));
		if (limit === null || limit === undefined) continue;
		const selector = meterLimitScopeSelector(
			limit.scope,
			entities.get(`${after.projectId}|${after.id}`) ?? null,
		);
		if (!inScopeSet(row, selector)) {
			details.push(
				`Hold ${after.id} sits on window ${row.id}, outside the ${selector.scope} scope set its account counts.`,
			);
		}
	}
	for (const extra of byId.values()) {
		details.push(`Hold ${extra.id} was taken after the snapshot.`);
	}
	return result("active holds", details);
}

async function reservationEntities(executor: QueryExecutor): Promise<Map<string, string | null>> {
	const rows = await executeRows<{ id: string; project_id: string; entity_id: string | null }>(
		executor,
		drizzleSql`
			SELECT id::text, project_id::text, entity_id::text FROM reservations
			WHERE status = 'active' AND usage_window_id IS NOT NULL
		`,
	);
	return new Map(rows.map((row) => [`${row.project_id}|${row.id}`, row.entity_id]));
}

async function checkCorrectionRouting(
	executor: QueryExecutor,
	scoped: readonly ScopedWindow[],
	governing: ReadonlyMap<string, GroupLimit | null>,
): Promise<TransitionCheck> {
	const details: string[] = [];
	if (scoped.length === 0) return result("correction routing", details);
	const earliest = scoped.reduce(
		(min, row) => (row.windowStartAt < min ? row.windowStartAt : min),
		scoped[0]?.windowStartAt ?? new Date().toISOString(),
	);
	const rows = new Map(scoped.map((row) => [row.id, row]));
	// Bounded to the open windows' start so partition pruning reads only their months.
	const events = await executeRows<{
		id: string;
		project_id: string;
		customer_id: string;
		meter_feature_id: string;
		entity_id: string | null;
		window_id: string;
		window_start_at: string | null;
		window_end_at: string | null;
	}>(
		executor,
		drizzleSql`
			SELECT
				event.id::text,
				event.project_id::text,
				event.customer_id::text,
				event.meter_feature_id::text,
				event.entity_id::text,
				event.metadata->>'usageWindowId' AS window_id,
				event.metadata->>'usageWindowStartAt' AS window_start_at,
				event.metadata->>'usageWindowEndAt' AS window_end_at
			FROM usage_events event
			WHERE event.recorded_at >= ${earliest}::timestamptz
				AND event.operation IN ('consume', 'confirm')
				AND event.metadata ? 'usageWindowId'
				AND EXISTS (
					SELECT 1 FROM usage_windows usage_window
					WHERE usage_window.project_id = event.project_id
						AND usage_window.id = (event.metadata->>'usageWindowId')::bigint
						AND usage_window.window_end_at > now()
				)
		`,
	);
	for (const event of events) {
		const row = rows.get(event.window_id);
		if (row === undefined) continue;
		if (
			row.projectId !== event.project_id ||
			row.customerId !== event.customer_id ||
			row.featureId !== event.meter_feature_id
		) {
			details.push(`Event ${event.id} names window ${row.id} of another account or feature.`);
			continue;
		}
		if (
			event.window_start_at === null ||
			event.window_end_at === null ||
			new Date(event.window_start_at).getTime() !== new Date(row.windowStartAt).getTime() ||
			new Date(event.window_end_at).getTime() !== new Date(row.windowEndAt).getTime()
		) {
			details.push(`Event ${event.id} names window ${row.id} with other bounds.`);
			continue;
		}
		const limit = governing.get(groupKey(row));
		if (limit === null || limit === undefined) continue;
		const selector = meterLimitScopeSelector(limit.scope, event.entity_id);
		if (!inScopeSet(row, selector)) {
			details.push(
				`Event ${event.id} names window ${row.id}, outside the ${selector.scope} scope set it counts in, so a correction would not free capacity there.`,
			);
		}
	}
	return result("correction routing", details);
}

function checkInvoiceAttribution(
	baseline: UsageScopesSnapshot,
	periods: readonly SnapshotInvoicePeriod[],
	unbilled: readonly SnapshotUnbilledGroup[],
): TransitionCheck {
	const details: string[] = [];
	const periodsById = new Map(periods.map((period) => [period.id, period]));
	for (const before of baseline.invoicePeriods) {
		const after = periodsById.get(before.id);
		if (after === undefined) {
			details.push(`Invoice period ${before.id} is no longer pending or processing.`);
			continue;
		}
		periodsById.delete(before.id);
		if (JSON.stringify(normalized(before)) !== JSON.stringify(normalized(after))) {
			details.push(`Invoice period ${before.id} changed.`);
		}
	}
	for (const extra of periodsById.values()) {
		details.push(`Invoice period ${extra.id} appeared after the snapshot.`);
	}
	const key = (group: SnapshotUnbilledGroup) =>
		`${group.projectId}|${group.subscriptionId}|${group.planItemId}|${group.windowStartAt}|${group.windowEndAt}`;
	const groups = new Map(unbilled.map((group) => [key(group), group]));
	for (const before of baseline.unbilledGroups) {
		const after = groups.get(key(before));
		if (after === undefined || !sameDecimal(after.usage, before.usage)) {
			details.push(
				`Unbilled usage of ${key(before)} would invoice ${after?.usage ?? "nothing"} instead of ${before.usage}.`,
			);
		}
		groups.delete(key(before));
	}
	for (const extra of groups.keys()) {
		details.push(`Unbilled usage of ${extra} appeared after the snapshot.`);
	}
	return result("invoice attribution", details);
}

/** Every scope set's sum against each of its rows; a sum of usages never shrinks below one. */
function checkNoCapacityGain(
	scoped: readonly ScopedWindow[],
	governing: ReadonlyMap<string, GroupLimit | null>,
): TransitionCheck {
	const details: string[] = [];
	for (const set of scopeSets(scoped, governing)) {
		const total = set.rows.reduce((sum, row) => sum + units(row.usage), 0n);
		for (const row of set.rows) {
			if (units(row.usage) > total) {
				details.push(`Window ${row.id} counts more than its scope set ${set.key}.`);
			}
		}
	}
	return result("no capacity gain", details);
}

async function checkBlockers(
	executor: QueryExecutor,
	scoped: readonly ScopedWindow[],
	governing: ReadonlyMap<string, GroupLimit | null>,
): Promise<TransitionCheck> {
	const details: string[] = [];
	const projects = [...new Set(scoped.map((row) => row.projectId))];
	const all = await executeRows<{ id: string }>(
		executor,
		drizzleSql`SELECT id::text FROM projects ORDER BY id`,
	);
	for (const project of new Set([...projects, ...all.map((row) => row.id)])) {
		const mixed: MixedScopeAccount[] = await readMixedScopeAccounts(executor, project);
		for (const account of mixed) {
			details.push(
				`Account ${account.billingAccountId} holds mixed scopes on ${account.featureKey}: ${account.sources
					.map((source) => `${source.plan} v${source.version} (${source.scope})`)
					.join(", ")}.`,
			);
		}
	}
	for (const row of scoped) {
		if (governing.get(groupKey(row)) === null && (units(row.usage) > 0n || units(row.held) > 0n)) {
			details.push(
				`Window ${row.id} is open with ${row.usage} used and ${row.held} held, but no meter limit applies to it now.`,
			);
		}
	}
	return result("blockers", details);
}

interface ScopeSet {
	key: string;
	limit: GroupLimit;
	selector: MeterLimitScopeSelector;
	rows: ScopedWindow[];
}

/** Open rows grouped into the scope sets enforcement sums, for the limit's current window only. */
function scopeSets(
	scoped: readonly ScopedWindow[],
	governing: ReadonlyMap<string, GroupLimit | null>,
): ScopeSet[] {
	const sets = new Map<string, ScopeSet>();
	for (const row of scoped) {
		const limit = governing.get(groupKey(row));
		if (limit === null || limit === undefined || !limit.current) continue;
		// A no-entity account row under a declared entity scope only governs while it holds usage;
		// otherwise it belongs to no entity's set.
		if (limit.scope === "entity" && row.entityId === null && row.scope === "account") continue;
		const selector = selectorOf(row, limit);
		const key = `${groupKey(row)}|${selector.scope}|${selector.entityId ?? ""}`;
		const set = sets.get(key) ?? { key, limit, selector, rows: [] };
		set.rows.push(row);
		sets.set(key, set);
	}
	return [...sets.values()];
}

function overCapSets(
	scoped: readonly ScopedWindow[],
	governing: ReadonlyMap<string, GroupLimit | null>,
): OverCapScopeSet[] {
	return scopeSets(scoped, governing).flatMap((set) => {
		if (set.limit.overagePolicy !== "blocked") return [];
		const usage = set.rows.reduce((sum, row) => sum + units(row.usage), 0n);
		const held = set.rows.reduce((sum, row) => sum + units(row.held), 0n);
		if (usage + held <= units(set.limit.limit)) return [];
		const [first] = set.rows;
		if (first === undefined) return [];
		return [
			{
				customerId: first.customerId,
				featureId: first.featureId,
				projectKey: first.projectKey,
				billingAccountId: first.billingAccountId,
				featureKey: first.featureKey,
				entityExternalId:
					set.selector.entityId === null
						? null
						: (set.rows.find((row) => row.entityId === set.selector.entityId)?.entityExternalId ??
							null),
				scope: set.selector.scope,
				entityId: set.selector.entityId,
				windowStartAt: first.windowStartAt,
				windowEndAt: first.windowEndAt,
				usage: unitsToDecimal(usage, 9),
				held: unitsToDecimal(held, 9),
				limit: set.limit.limit,
			},
		];
	});
}

function normalized(period: SnapshotInvoicePeriod) {
	return {
		...period,
		usageQuantity: unitsToDecimal(units(period.usageQuantity), 9),
		includedQuantity: unitsToDecimal(units(period.includedQuantity), 9),
		billableQuantity: unitsToDecimal(units(period.billableQuantity), 9),
	};
}

function result(name: string, details: string[]): TransitionCheck {
	return {
		name,
		passed: details.length === 0,
		details: details.slice(0, detailLimit),
		total: details.length,
	};
}

function units(value: string): bigint {
	return decimalToUnits(databaseDecimal(value, "quantity"), 9);
}

function sameDecimal(left: string, right: string): boolean {
	return units(left) === units(right);
}

function iso(value: Date | string): string {
	return new Date(value).toISOString();
}
