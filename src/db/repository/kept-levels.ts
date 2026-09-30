import { sql as drizzleSql } from "drizzle-orm";
import { lifetimeItemSql, resetSplitsBillingPeriodSql } from "./cadence-sql";
import { executeRows } from "./query";
import type { QueryExecutor } from "./types";

/**
 * A non-consumable meter's usage is a level, such as projects in use, not spend. At a switch to a
 * version that allocates the same feature in the same scope, the outgoing allowance that holds the
 * level moves to the incoming version's item instead of ending, so the level stays and corrections
 * keep lowering it on the same row. Its quantity becomes the larger of the incoming allowance and
 * the level: a level above the new allowance is kept, and nothing is added on top of it.
 *
 * When several live allowances hold one level (allowances stacked before lifetime grants), each
 * keeps what it holds and the one holding most also takes the incoming allowance's headroom, so the
 * group grants the larger of the two once. Allowances that hold nothing, and features the incoming
 * version does not allocate, end with the outgoing version as before.
 */
export async function keepNonConsumableLevels(
	executor: QueryExecutor,
	input: {
		projectId: string;
		subscriptionId: string;
		outgoingPlanVersionId: string;
		incomingPlanVersionId: string;
		periodStartAt: Date;
		periodEndAt: Date | null;
	},
): Promise<void> {
	const periodStart = input.periodStartAt.toISOString();
	const periodEnd = input.periodEndAt?.toISOString() ?? null;
	await executeRows(
		executor,
		drizzleSql`
			WITH incoming AS (
				SELECT pi.id, pi.feature_id, pi.allocation_scope, pi.quantity, pi.reset_interval,
					pi.expires_after_seconds, ${lifetimeItemSql("pi")} AS lifetime
				FROM plan_items pi
				JOIN plan_versions pv ON pv.project_id = pi.project_id AND pv.id = pi.plan_version_id
				WHERE pi.project_id = ${input.projectId}
					AND pi.plan_version_id = ${input.incomingPlanVersionId}::bigint
					AND pi.item_kind = 'allocation'
					-- Items granted per reset window inside the period keep their own windows.
					AND NOT ${resetSplitsBillingPeriodSql("pi", "pv")}
			),
			levels AS (
				SELECT allocation.id, incoming.id AS item_id, incoming.quantity AS item_quantity,
					incoming.reset_interval, incoming.expires_after_seconds, incoming.lifetime,
					allocation.consumed_quantity + allocation.held_quantity AS level,
					allocation.reversed_quantity,
					sum(allocation.consumed_quantity + allocation.held_quantity)
						OVER (PARTITION BY allocation.feature_id, allocation.entity_id) AS group_level,
					row_number() OVER (
						PARTITION BY allocation.feature_id, allocation.entity_id
						ORDER BY allocation.consumed_quantity + allocation.held_quantity DESC, allocation.id
					) AS rank
				FROM balance_allocations allocation
				JOIN plan_items item
					ON item.project_id = allocation.project_id AND item.id = allocation.plan_item_id
				JOIN features feature
					ON feature.project_id = allocation.project_id AND feature.id = allocation.feature_id
				JOIN incoming
					ON incoming.feature_id = allocation.feature_id
					AND (incoming.allocation_scope = 'entity') = (allocation.entity_id IS NOT NULL)
				WHERE allocation.project_id = ${input.projectId}
					AND allocation.subscription_id = ${input.subscriptionId}
					AND allocation.source_kind = 'subscription'
					AND allocation.reversed_at IS NULL
					AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
					AND item.plan_version_id = ${input.outgoingPlanVersionId}::bigint
					AND feature.meter_kind = 'non_consumable'
			)
			UPDATE balance_allocations allocation
			SET plan_item_id = levels.item_id,
				quantity = levels.level + levels.reversed_quantity
					+ CASE
						WHEN levels.rank = 1 THEN GREATEST(levels.item_quantity - levels.group_level, 0)
						ELSE 0
					END,
				period_start_at = ${periodStart}::timestamptz,
				period_end_at = CASE WHEN levels.lifetime THEN NULL ELSE ${periodEnd}::timestamptz END,
				expires_at = CASE
					WHEN levels.expires_after_seconds IS NOT NULL AND ${periodEnd}::timestamptz IS NOT NULL
						THEN LEAST(
							${periodEnd}::timestamptz,
							${periodStart}::timestamptz + levels.expires_after_seconds * interval '1 second'
						)
					WHEN levels.expires_after_seconds IS NOT NULL
						THEN ${periodStart}::timestamptz + levels.expires_after_seconds * interval '1 second'
					WHEN levels.reset_interval IS NOT NULL THEN ${periodEnd}::timestamptz
					ELSE NULL
				END,
				updated_at = now()
			FROM levels
			WHERE allocation.project_id = ${input.projectId}
				AND allocation.id = levels.id
				AND levels.group_level > 0
				AND (levels.level > 0 OR levels.rank = 1)
		`,
	);
}

/**
 * An allowance a switch kept above its item's quantity, to hold a level the new version does not
 * allow, shrinks back as the level falls: to the item's quantity, or to the level while it is
 * higher. The new version's allowance then caps the level again. Other allowances never exceed
 * their item's quantity, so this leaves them as they are.
 */
export async function shrinkKeptLevels(
	executor: QueryExecutor,
	projectId: string,
	allocationIds: readonly string[],
): Promise<void> {
	if (allocationIds.length === 0) return;
	const ids = drizzleSql.join(
		allocationIds.map((id) => drizzleSql`${id}::bigint`),
		drizzleSql`, `,
	);
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations allocation
			SET quantity = GREATEST(
					item.quantity,
					allocation.consumed_quantity + allocation.held_quantity + allocation.reversed_quantity
				),
				updated_at = now()
			FROM plan_items item, features feature
			WHERE allocation.project_id = ${projectId}
				AND allocation.id IN (${ids})
				AND allocation.source_kind = 'subscription'
				AND item.project_id = allocation.project_id
				AND item.id = allocation.plan_item_id
				AND feature.project_id = allocation.project_id
				AND feature.id = allocation.feature_id
				AND feature.meter_kind = 'non_consumable'
				AND allocation.quantity > GREATEST(
					item.quantity,
					allocation.consumed_quantity + allocation.held_quantity + allocation.reversed_quantity
				)
		`,
	);
}
