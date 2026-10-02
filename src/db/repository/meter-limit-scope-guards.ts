import { sql as drizzleSql } from "drizzle-orm";
import { BillingError } from "../../billing/errors";
import { executeRows } from "./query";
import type { QueryExecutor } from "./types";

/**
 * The features on which a plan version's meter limits, or unlimited usage items, would meet a limit
 * of a different declared scope that the account's other live subscriptions already hold (PC-04);
 * two unlimited items have no cap to combine and never conflict. An
 * account cap and an entity cap on one feature have no agreed combination, so every path that could
 * make an account hold both refuses it.
 *
 * Base plans are mutually exclusive, so a base version never conflicts with another base; a
 * subscription being changed is left out with `excludeSubscriptionId`, and so is any other
 * subscription to the same plan.
 */
export async function meterLimitScopeConflicts(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customer: { customerId: string } | { billingAccountId: string };
		planVersionId: string;
		excludeSubscriptionId?: string | null;
	},
): Promise<string[]> {
	const customer =
		"customerId" in input.customer
			? drizzleSql`subscription.customer_id = ${input.customer.customerId}::uuid`
			: drizzleSql`subscription.customer_id = (
					SELECT customer.id FROM customers customer
					WHERE customer.project_id = ${input.projectId}
						AND customer.billing_account_id = ${input.customer.billingAccountId}
				)`;
	const rows = await executeRows<{ key: string }>(
		executor,
		drizzleSql`
			SELECT DISTINCT feature.key
			FROM plan_items target
			JOIN plan_versions target_version
				ON target_version.project_id = target.project_id
				AND target_version.id = target.plan_version_id
			JOIN features feature
				ON feature.project_id = target.project_id AND feature.id = target.feature_id
			JOIN subscriptions subscription
				ON subscription.project_id = target.project_id
				AND ${customer}
				AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND (subscription.expires_at IS NULL OR subscription.expires_at > now())
				AND (
					${input.excludeSubscriptionId ?? null}::uuid IS NULL
					OR subscription.id <> ${input.excludeSubscriptionId ?? null}::uuid
				)
			JOIN plan_versions held_version
				ON held_version.project_id = subscription.project_id
				AND held_version.id = subscription.plan_version_id
			JOIN plan_items held
				ON held.project_id = held_version.project_id
				AND held.plan_version_id = held_version.id
				AND held.feature_id = target.feature_id
				AND held.item_kind IN ('meter_limit', 'unlimited_usage')
			WHERE target.project_id = ${input.projectId}
				AND target.plan_version_id = ${input.planVersionId}::bigint
				AND target.item_kind IN ('meter_limit', 'unlimited_usage')
				-- Two unlimited sources have no cap to combine; a pair with a meter limit does.
				AND NOT (held.item_kind = 'unlimited_usage' AND target.item_kind = 'unlimited_usage')
				AND held.allocation_scope <> target.allocation_scope
				AND held_version.plan_id <> target_version.plan_id
				AND NOT (target_version.plan_kind = 'base' AND held_version.plan_kind = 'base')
			ORDER BY feature.key
		`,
	);
	return rows.map((row) => row.key);
}

/** The refusal for a purchase or plan change whose meter limits would mix declared scopes. */
export function meterLimitScopeConflictError(featureKeys: readonly string[]): BillingError {
	return new BillingError(
		`The plan's meter limits on ${featureKeys.join(", ")} declare a different scope than the limits this billing account already holds`,
		"ADDON_METER_LIMIT_CONFLICT",
		409,
		{ details: { reason: "scope", featureKeys: [...featureKeys] } },
	);
}
