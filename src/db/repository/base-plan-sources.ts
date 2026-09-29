import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";

/** Statuses of a subscription that still funds its plan. */
export const fundingSubscriptionStatuses = drizzleSql`('active', 'grace_period', 'billing_retry', 'cancelled')`;

/**
 * The customer's oldest funding subscription to a base plan version, or recorded before plan
 * versions (which carries none), as a scalar subquery; null when there is none.
 */
export function fundingBaseSubscriptionSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`(
		SELECT s.id
		FROM subscriptions s
		LEFT JOIN plan_versions version
			ON version.project_id = s.project_id AND version.id = s.plan_version_id
		WHERE s.project_id = ${projectId}
			AND s.customer_id = ${customerId}
			AND s.status IN ${fundingSubscriptionStatuses}
			AND (s.expires_at IS NULL OR s.expires_at > now())
			AND (s.plan_version_id IS NULL OR version.plan_kind = 'base')
		ORDER BY s.created_at, s.id
		LIMIT 1
	)`;
}

/**
 * The customer's active base plan grant other than the default plan, such as a trial, as a scalar
 * subquery; null when there is none. An elapsed grant the worker has not recorded yet is left out.
 */
export function activeBaseGrantSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`(
		SELECT g.id
		FROM plan_grants g
		WHERE g.project_id = ${projectId}
			AND g.customer_id = ${customerId}
			AND g.origin <> 'default'
			AND g.status = 'active'
			AND g.plan_kind = 'base'
			AND g.ends_at > now()
		LIMIT 1
	)`;
}

/**
 * Whether a customer already holds a base plan, so the default plan does not apply: a funding
 * subscription to a base plan version, a funding subscription recorded before plan versions (which
 * carries none), or an active base plan grant such as a trial.
 */
export function heldBasePlanSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`(
		${fundingBaseSubscriptionSql(projectId, customerId)} IS NOT NULL
		OR ${activeBaseGrantSql(projectId, customerId)} IS NOT NULL
	)`;
}
