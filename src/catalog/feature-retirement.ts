import { sql as drizzleSql } from "drizzle-orm";
import { BillingError } from "../billing/errors";
import { executeRows, jsonb } from "../db/repository/query";
import type { QueryExecutor } from "../db/repository/types";

type PlanGrantOrigin = "trial" | "promotion";

type HolderRow = {
	feature_key: string;
	count: number | string;
} & (
	| { kind: "subscription"; plan_key: string; version: number }
	| { kind: "plan_grant"; plan_key: string; version: number; origin: PlanGrantOrigin }
	| { kind: "promotion_feature_grant"; promotion_key: string }
);

type FeatureHolder = { count: number } & (
	| { kind: "subscription"; planKey: string; planVersion: number }
	| { kind: "plan_grant"; planKey: string; planVersion: number; origin: PlanGrantOrigin }
	| { kind: "promotion_feature_grant"; promotionKey: string }
);

/**
 * Publishing does not move subscriptions, trials or promotional plan grants off their pinned
 * versions, nor take back redeemed promotion credits. Retiring their feature would make it
 * impossible to check or spend. Default-plan grants instead follow the catalog's current marker,
 * including the features it drops, so their stored versions must not block that change.
 * Only newly retired features are passed here; earlier retirements stay retired.
 */
export async function assertRetiringFeaturesAreNotHeld(
	executor: QueryExecutor,
	projectId: string,
	featureKeys: readonly string[],
): Promise<void> {
	if (featureKeys.length === 0) return;
	const rows = await executeRows<HolderRow>(
		executor,
		drizzleSql`
			WITH retiring_features AS (
				SELECT id, key FROM features
				WHERE project_id = ${projectId}
					AND key IN (SELECT jsonb_array_elements_text(${jsonb([...featureKeys])}))
			), plan_sources AS (
				SELECT subscription.id, subscription.plan_version_id, 'subscription'::text AS kind,
					NULL::text AS origin, ARRAY[]::text[] AS entitlement_keys
				FROM subscriptions subscription
				WHERE subscription.project_id = ${projectId}
					AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (subscription.expires_at IS NULL OR subscription.expires_at > now())

				UNION ALL

				SELECT grant_source.id, grant_source.plan_version_id, 'plan_grant'::text,
					grant_source.origin, grant_source.entitlement_keys
				FROM plan_grants grant_source
				WHERE grant_source.project_id = ${projectId}
					AND grant_source.status = 'active'
					AND grant_source.origin <> 'default'
					AND (grant_source.ends_at IS NULL OR grant_source.ends_at > now())
			), holders AS (
				SELECT feature.key AS feature_key, source.kind, source.origin,
					plan.key AS plan_key, version.version, NULL::text AS promotion_key,
					count(DISTINCT source.id)::integer AS count
				FROM plan_sources source
				JOIN plan_versions version
					ON version.project_id = ${projectId} AND version.id = source.plan_version_id
				JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
				JOIN retiring_features feature
					ON feature.key = ANY(source.entitlement_keys)
					OR EXISTS (
						SELECT 1 FROM plan_items item
						WHERE item.project_id = ${projectId}
							AND item.plan_version_id = version.id AND item.feature_id = feature.id
					)
				GROUP BY feature.key, source.kind, source.origin, plan.key, version.version

				UNION ALL

				SELECT feature.key, 'promotion_feature_grant'::text, NULL::text, NULL::text,
					NULL::integer, promotion.key, count(DISTINCT redemption.id)::integer
				FROM balance_allocations allocation
				JOIN retiring_features feature ON feature.id = allocation.feature_id
				JOIN promotion_redemptions redemption
					ON redemption.project_id = allocation.project_id
					AND redemption.id = allocation.promotion_redemption_id
				JOIN promotions promotion
					ON promotion.project_id = redemption.project_id AND promotion.id = redemption.promotion_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.source_kind = 'reward'
					AND allocation.reversed_at IS NULL
					AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
					-- Held credits still belong to a holder even when none are free to spend.
					AND allocation.quantity > allocation.consumed_quantity + allocation.reversed_quantity
				GROUP BY feature.key, promotion.key
			)
			SELECT * FROM holders
			ORDER BY feature_key, kind, origin, plan_key, version, promotion_key
		`,
	);
	const [first] = rows;
	if (first === undefined) return;
	const holders = rows.filter((row) => row.feature_key === first.feature_key).map(toFeatureHolder);
	throw new BillingError(
		retirementMessage(first.feature_key, holders),
		"FEATURE_RETIREMENT_BLOCKED",
		409,
		{ classification: "persistence_conflict", details: { featureKey: first.feature_key, holders } },
	);
}

function toFeatureHolder(row: HolderRow): FeatureHolder {
	const count = Number(row.count);
	if (row.kind === "promotion_feature_grant") {
		return { kind: row.kind, promotionKey: row.promotion_key, count };
	}
	const plan = { planKey: row.plan_key, planVersion: row.version, count };
	return row.kind === "subscription"
		? { kind: row.kind, ...plan }
		: { kind: row.kind, origin: row.origin, ...plan };
}

function retirementMessage(featureKey: string, holders: readonly FeatureHolder[]): string {
	if (holders.every((holder) => holder.kind === "subscription")) {
		const subscriptions = holders.reduce((total, holder) => total + holder.count, 0);
		const versions = holders
			.map((holder) => `${holder.planKey} version ${holder.planVersion}`)
			.join(", ");
		return `Feature ${featureKey} cannot be retired: ${
			subscriptions === 1
				? "1 live subscription still holds"
				: `${subscriptions} live subscriptions still hold`
		} it through plan ${versions}; migrate them to a version without it, or retire it after they end`;
	}
	const sources = holders.map((holder) => {
		if (holder.kind === "promotion_feature_grant") {
			return `${holder.count} redeemed feature grant${holder.count === 1 ? "" : "s"} from promotion ${holder.promotionKey}`;
		}
		const kind = holder.kind === "subscription" ? "subscription" : `${holder.origin} plan grant`;
		return `${holder.count} live ${kind}${holder.count === 1 ? "" : "s"} through plan ${holder.planKey} version ${holder.planVersion}`;
	});
	return `Feature ${featureKey} cannot be retired: held by ${sources.join(", ")}; migrate subscriptions, end plan grants, or consume, revoke or let promotion credits expire before retiring it`;
}
