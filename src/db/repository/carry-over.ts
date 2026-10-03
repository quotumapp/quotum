import { sql as drizzleSql } from "drizzle-orm";
import { databaseDecimal, decimalToUnits, unitsToDecimal } from "../../billing/decimal";
import type { CadenceUnit } from "../../shared/cadence";
import { lifetimeItemSql } from "./cadence-sql";
import { planGrantWindowBounds, storedCadence } from "./meter-limit-windows";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

/** Allocation quantities are NUMERIC(28, 9); arithmetic on them uses that scale. */
const allocationScale = 9;

export interface CarryOverInput {
	projectId: string;
	customerId: string;
	subscriptionId: string;
	changeId: string;
	outgoingPlanVersionId: string;
	incomingPlanVersionId: string;
	balances: string[];
	usages: string[];
	periodStartAt: Date;
	periodEndAt: Date | null;
}

/**
 * Carries what an immediate plan change named into the incoming version, before the outgoing
 * allowances end (DEC-08). It runs once, in the sync that records the change's switch.
 */
export async function carryOverAllowances(
	executor: QueryExecutor,
	input: CarryOverInput,
): Promise<void> {
	if (input.balances.length > 0) await carryOverBalances(executor, input);
	if (input.usages.length > 0) await carryOverUsage(executor, input);
}

/**
 * Unused quantity of each live outgoing allowance becomes a one-off `carry_over` allocation. It
 * expires at the end of the incoming item's first reset window, or at the billing period's end when
 * that item does not reset or the incoming version lacks the feature. What a lifetime allowance
 * (no reset, no expiry) left never expires: the carry keeps the lifetime the outgoing version
 * granted. Held quantity stays on the outgoing allowance, where its reservation settles.
 */
async function carryOverBalances(executor: QueryExecutor, input: CarryOverInput): Promise<void> {
	const origins = await executeRows<{
		id: string | number;
		feature_id: string | number;
		entity_id: string | number | null;
		unused: string;
		reset_interval: CadenceUnit | null;
		reset_interval_count: number | null;
		lifetime: boolean;
		db_now: Date | string;
	}>(
		executor,
		drizzleSql`
			SELECT allocation.id, allocation.feature_id, allocation.entity_id,
				(allocation.quantity - allocation.reversed_quantity - allocation.consumed_quantity
					- allocation.held_quantity)::text AS unused,
				incoming.reset_interval, incoming.reset_interval_count,
				${lifetimeItemSql("outgoing")} AS lifetime, now() AS db_now
			FROM balance_allocations allocation
			JOIN plan_items outgoing
				ON outgoing.project_id = allocation.project_id
				AND outgoing.id = allocation.plan_item_id
				AND outgoing.plan_version_id = ${input.outgoingPlanVersionId}::bigint
			JOIN features feature
				ON feature.project_id = allocation.project_id AND feature.id = allocation.feature_id
			LEFT JOIN plan_items incoming
				ON incoming.project_id = allocation.project_id
				AND incoming.plan_version_id = ${input.incomingPlanVersionId}::bigint
				AND incoming.feature_id = allocation.feature_id
				AND incoming.item_kind = 'allocation'
			WHERE allocation.project_id = ${input.projectId}
				AND allocation.subscription_id = ${input.subscriptionId}
				AND allocation.source_kind = 'subscription'
				AND allocation.reversed_at IS NULL
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
				AND feature.key IN (SELECT jsonb_array_elements_text(${jsonb(input.balances)}))
			ORDER BY allocation.id
			FOR UPDATE OF allocation
		`,
	);
	for (const origin of origins) {
		if (allocationUnits(origin.unused) <= 0n) continue;
		const expiresAt = carriedExpiry(input, origin);
		await executeOne(
			executor,
			drizzleSql`
				INSERT INTO balance_allocations (
					project_id, customer_id, entity_id, feature_id, subscription_id, source_kind,
					source_key, quantity, period_start_at, period_end_at, expires_at,
					carry_over_origin_allocation_id
				)
				VALUES (
					${input.projectId}, ${input.customerId}, ${origin.entity_id === null ? null : String(origin.entity_id)}::bigint,
					${String(origin.feature_id)}::bigint, ${input.subscriptionId}, 'carry_over',
					${`carry_over:${input.changeId}:${String(origin.id)}`}, ${origin.unused}::numeric,
					now(), ${expiresAt}::timestamptz, ${expiresAt}::timestamptz,
					${String(origin.id)}::bigint
				)
				ON CONFLICT (project_id, feature_id, source_kind, source_key) DO NOTHING
				RETURNING id
			`,
		);
	}
}

function carriedExpiry(
	input: CarryOverInput,
	origin: {
		reset_interval: CadenceUnit | null;
		reset_interval_count: number | null;
		lifetime: boolean;
		db_now: Date | string;
	},
): string | null {
	if (origin.lifetime || input.periodEndAt === null) return null;
	if (origin.reset_interval === null) return input.periodEndAt.toISOString();
	return planGrantWindowBounds(
		input.periodStartAt,
		input.periodEndAt,
		storedCadence(origin.reset_interval, origin.reset_interval_count ?? 1),
		new Date(origin.db_now),
	).end.toISOString();
}

/** A carry recorded in `carried_usages`: usage written onto `to` from `from`'s consumption. */
export interface CarriedUsageEdge {
	from: string;
	to: string;
	applied: bigint;
}

/**
 * Usage two allowances already share. Replay carries in change order: each allowance holds a
 * quantity of each distinct usage portion, identified by the edge that first carried it. A carry
 * copies only portions its target lacks; any remainder is previously uncarried use of its source.
 * A capped carry copies a prefix of a portion, so later overlap is the smaller held quantity.
 * Summing paths instead loses this identity when carries form cycles or share a common ancestor.
 */
export function sharedCarriedUsage(
	edges: readonly CarriedUsageEdge[],
	origin: string,
	target: string,
): bigint {
	const holdings = new Map<string, Map<number, bigint>>();
	for (const [portion, edge] of edges.entries()) {
		if (edge.applied <= 0n) continue;
		const from = holdings.get(edge.from) ?? new Map<number, bigint>();
		const to = holdings.get(edge.to) ?? new Map<number, bigint>();
		holdings.set(edge.from, from);
		holdings.set(edge.to, to);
		let remaining = edge.applied;
		for (const [id, quantity] of from) {
			const held = to.get(id) ?? 0n;
			const missing = quantity - held;
			if (missing <= 0n) continue;
			const copied = missing < remaining ? missing : remaining;
			to.set(id, held + copied);
			remaining -= copied;
			if (remaining === 0n) break;
		}
		if (remaining > 0n) {
			from.set(portion, remaining);
			to.set(portion, remaining);
		}
	}
	let shared = 0n;
	const incoming = holdings.get(target);
	for (const [portion, quantity] of holdings.get(origin) ?? []) {
		const held = incoming?.get(portion) ?? 0n;
		shared += quantity < held ? quantity : held;
	}
	return shared;
}

/** The recorded carries onto a subscription's allowances. */
async function carriedUsageEdges(
	executor: QueryExecutor,
	projectId: string,
	subscriptionId: string,
): Promise<CarriedUsageEdge[]> {
	const rows = await executeRows<{
		from_allocation_id: string | number;
		to_allocation_id: string | number;
		applied: string;
	}>(
		executor,
		drizzleSql`
			SELECT carried.from_allocation_id, carried.to_allocation_id,
				carried.applied_quantity::text AS applied
			FROM carried_usages carried
			JOIN subscription_changes change
				ON change.project_id = carried.project_id AND change.id = carried.subscription_change_id
			JOIN balance_allocations allocation
				ON allocation.project_id = carried.project_id
				AND allocation.id = carried.to_allocation_id
			WHERE carried.project_id = ${projectId}
				AND allocation.subscription_id = ${subscriptionId}
				AND carried.applied_quantity > 0
			ORDER BY change.created_at, change.id, carried.from_allocation_id
		`,
	);
	return rows.map((row) => ({
		from: String(row.from_allocation_id),
		to: String(row.to_allocation_id),
		applied: allocationUnits(row.applied),
	}));
}

/**
 * For a preview, the usage per feature that an immediate change from one version to another would
 * not carry because the incoming version's allowance for this period already holds it: the
 * allowance a return resumes, matched by feature and scope the way the carry picks its target.
 */
export async function usageHeldByIncomingAllowances(
	executor: QueryExecutor,
	input: {
		projectId: string;
		subscriptionId: string;
		outgoingPlanVersionId: string;
		incomingPlanVersionId: string;
	},
): Promise<Map<string, bigint>> {
	const rows = await executeRows<{
		id: string | number;
		feature_id: string | number;
		entity_id: string | number | null;
		consumed: string;
		incoming: boolean;
	}>(
		executor,
		drizzleSql`
			SELECT allocation.id, allocation.feature_id, allocation.entity_id,
				allocation.consumed_quantity::text AS consumed,
				item.plan_version_id = ${input.incomingPlanVersionId}::bigint AS incoming
			FROM balance_allocations allocation
			JOIN plan_items item
				ON item.project_id = allocation.project_id AND item.id = allocation.plan_item_id
			WHERE allocation.project_id = ${input.projectId}
				AND allocation.subscription_id = ${input.subscriptionId}
				AND allocation.source_kind = 'subscription'
				AND allocation.reversed_at IS NULL
				AND item.plan_version_id IN (
					${input.outgoingPlanVersionId}::bigint, ${input.incomingPlanVersionId}::bigint
				)
				AND (allocation.period_start_at IS NULL OR allocation.period_start_at <= now())
				AND (allocation.period_end_at IS NULL OR allocation.period_end_at > now())
				AND (
					item.plan_version_id = ${input.incomingPlanVersionId}::bigint
					OR allocation.expires_at IS NULL
					OR allocation.expires_at > now()
				)
			ORDER BY allocation.id
		`,
	);
	const held = new Map<string, bigint>();
	if (!rows.some((row) => row.incoming)) return held;
	const edges = await carriedUsageEdges(executor, input.projectId, input.subscriptionId);
	for (const origin of rows) {
		if (origin.incoming) continue;
		const target = rows.find(
			(row) =>
				row.incoming &&
				String(row.feature_id) === String(origin.feature_id) &&
				String(row.entity_id) === String(origin.entity_id),
		);
		if (target === undefined) continue;
		const consumed = allocationUnits(origin.consumed);
		const shared = sharedCarriedUsage(edges, String(origin.id), String(target.id));
		const feature = String(origin.feature_id);
		held.set(feature, (held.get(feature) ?? 0n) + (shared < consumed ? shared : consumed));
	}
	return held;
}

/**
 * Usage of the outgoing allowances whose window covers now, the current reset window or, without a
 * reset, the period, and for a lifetime allowance its whole lifetime, is written as consumed
 * quantity on the incoming allowance for the current window, so a mid-period change does not reset
 * consumption. Usage the incoming allowance already holds, because a return resumed it after
 * earlier carries, is not written again.
 * It is capped at what the incoming allowance can still hold; the rest is forgiven, not charged,
 * and each carry is recorded in `carried_usages`.
 */
async function carryOverUsage(executor: QueryExecutor, input: CarryOverInput): Promise<void> {
	const origins = await executeRows<{
		id: string | number;
		feature_id: string | number;
		entity_id: string | number | null;
		consumed: string;
	}>(
		executor,
		drizzleSql`
			SELECT allocation.id, allocation.feature_id, allocation.entity_id,
				allocation.consumed_quantity::text AS consumed
			FROM balance_allocations allocation
			JOIN plan_items outgoing
				ON outgoing.project_id = allocation.project_id
				AND outgoing.id = allocation.plan_item_id
				AND outgoing.plan_version_id = ${input.outgoingPlanVersionId}::bigint
			JOIN features feature
				ON feature.project_id = allocation.project_id AND feature.id = allocation.feature_id
			WHERE allocation.project_id = ${input.projectId}
				AND allocation.subscription_id = ${input.subscriptionId}
				AND allocation.source_kind = 'subscription'
				AND allocation.reversed_at IS NULL
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
				AND (allocation.period_start_at IS NULL OR allocation.period_start_at <= now())
				AND (allocation.period_end_at IS NULL OR allocation.period_end_at > now())
				AND allocation.consumed_quantity > 0
				AND feature.key IN (SELECT jsonb_array_elements_text(${jsonb(input.usages)}))
			ORDER BY allocation.id
			FOR UPDATE OF allocation
		`,
	);
	if (origins.length === 0) return;
	const edges = await carriedUsageEdges(executor, input.projectId, input.subscriptionId);
	for (const origin of origins) {
		const target = await executeOne<{ id: string | number; room: string }>(
			executor,
			drizzleSql`
				SELECT allocation.id,
					GREATEST(allocation.quantity - allocation.reversed_quantity
						- allocation.consumed_quantity - allocation.held_quantity, 0)::text AS room
				FROM balance_allocations allocation
				JOIN plan_items incoming
					ON incoming.project_id = allocation.project_id
					AND incoming.id = allocation.plan_item_id
					AND incoming.plan_version_id = ${input.incomingPlanVersionId}::bigint
				WHERE allocation.project_id = ${input.projectId}
					AND allocation.subscription_id = ${input.subscriptionId}
					AND allocation.source_kind = 'subscription'
					AND allocation.feature_id = ${String(origin.feature_id)}::bigint
					AND allocation.entity_id IS NOT DISTINCT FROM ${origin.entity_id === null ? null : String(origin.entity_id)}::bigint
					AND allocation.reversed_at IS NULL
					AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
					AND (allocation.period_start_at IS NULL OR allocation.period_start_at <= now())
					AND (allocation.period_end_at IS NULL OR allocation.period_end_at > now())
				ORDER BY allocation.id
				LIMIT 1
				FOR UPDATE OF allocation
			`,
		);
		// The incoming version does not allocate the feature, so there is nothing to deduct from.
		if (target === null) continue;
		const consumed = allocationUnits(origin.consumed);
		const shared = sharedCarriedUsage(edges, String(origin.id), String(target.id));
		const requested = consumed > shared ? consumed - shared : 0n;
		// Everything the outgoing allowance consumed is already counted on the returning allowance.
		if (requested === 0n) continue;
		const room = allocationUnits(target.room);
		const applied = requested < room ? requested : room;
		if (applied > 0n) {
			await executeOne(
				executor,
				drizzleSql`
					UPDATE balance_allocations
					SET consumed_quantity = consumed_quantity + ${unitsToDecimal(applied, allocationScale)}::numeric,
						updated_at = now()
					WHERE project_id = ${input.projectId} AND id = ${String(target.id)}::bigint
					RETURNING id
				`,
			);
		}
		await executeOne(
			executor,
			drizzleSql`
				INSERT INTO carried_usages (
					project_id, subscription_change_id, from_allocation_id, to_allocation_id,
					requested_quantity, applied_quantity
				)
				VALUES (
					${input.projectId}, ${input.changeId}::uuid, ${String(origin.id)}::bigint,
					${String(target.id)}::bigint, ${unitsToDecimal(requested, allocationScale)}::numeric,
					${unitsToDecimal(applied, allocationScale)}::numeric
				)
				ON CONFLICT (project_id, subscription_change_id, from_allocation_id) DO NOTHING
				RETURNING from_allocation_id
			`,
		);
		edges.push({ from: String(origin.id), to: String(target.id), applied });
	}
}

function allocationUnits(value: string): bigint {
	return decimalToUnits(databaseDecimal(value, "allocation quantity"), allocationScale);
}
