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

/**
 * Usage of the outgoing allowances whose window covers now, the current reset window or, without a
 * reset, the period, and for a lifetime allowance its whole lifetime, is written as consumed
 * quantity on the incoming allowance for the current window, so a mid-period change does not reset
 * consumption.
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
		const requested = allocationUnits(origin.consumed);
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
	}
}

function allocationUnits(value: string): bigint {
	return decimalToUnits(databaseDecimal(value, "allocation quantity"), allocationScale);
}
