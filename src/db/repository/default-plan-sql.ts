import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { heldBasePlanSql } from "./base-plan-sources";

/** The published default plan's target row, for joining into other reads. */
export function defaultPlanTargetSql(projectId: string): DrizzleSQL {
	return drizzleSql`
		SELECT
			marker.plan_id::text AS plan_id,
			plan.active_version_id::text AS plan_version_id,
			marker.entitlement_keys,
			revision.revision
		FROM projects project
		JOIN catalog_revisions revision
			ON revision.project_id = project.id AND revision.id = project.published_catalog_revision_id
		JOIN catalog_default_plans marker
			ON marker.project_id = revision.project_id AND marker.catalog_revision_id = revision.id
		JOIN plans plan
			ON plan.project_id = marker.project_id AND plan.id = marker.plan_id AND plan.active
		JOIN plan_versions version
			ON version.project_id = plan.project_id
			AND version.id = plan.active_version_id
			AND version.status = 'published'
			AND version.plan_kind = 'base'
		WHERE project.id = ${projectId}
	`;
}

/**
 * The account's latest default-plan grant in any state, as a lateral subquery with `id` and
 * `starts_at`. A grant that replaces it starts where it started, so the windows keep their anchor.
 */
export function previousDefaultGrantSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`
		SELECT previous.id, previous.starts_at
		FROM plan_grants previous
		WHERE previous.project_id = ${projectId}
			AND previous.customer_id = ${customerId}
			AND previous.origin = 'default'
		ORDER BY previous.created_at DESC, previous.id DESC
		LIMIT 1
	`;
}

/**
 * Whether the account would start the default plan on its next write: the catalog marks one, and
 * the account holds neither a grant of it nor a base plan. An account Quotum has not recorded
 * (a null id) always would, when the catalog marks one.
 */
export function defaultPlanPendingSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`(
		EXISTS (${defaultPlanTargetSql(projectId)})
		AND NOT EXISTS (
			SELECT 1 FROM plan_grants held
			WHERE held.project_id = ${projectId}
				AND held.customer_id = ${customerId}
				AND held.origin = 'default'
				AND held.status = 'active'
		)
		AND NOT ${heldBasePlanSql(projectId, customerId)}
	)`;
}

/**
 * The default plan version reads count for the account, as a scalar subquery: the published
 * default plan's, when the catalog marks one and the account holds no base plan, and null
 * otherwise. That is the version the account's next write applies, whether its grant already
 * holds it, a publish changed it and the pass has not reached the account yet, or the account has
 * not started the plan, so a read answers as that write will. A null account is one Quotum has not
 * recorded yet.
 */
export function defaultPlanReadVersionSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`(
		SELECT target.plan_version_id::bigint
		FROM (${defaultPlanTargetSql(projectId)}) target
		WHERE NOT ${heldBasePlanSql(projectId, customerId)}
	)`;
}

/**
 * The default plan as reads count it, as a subquery of one row or none (see
 * `defaultPlanReadVersionSql`): `grant_id` (null for an account that would start it), the
 * `plan_version_id` the account's next write applies, `anchor_at` where its windows start (the
 * grant's start, or its previous default-plan grant's, or now), `allocations_grant_id` whose
 * allowances it holds in them, and `created_at` for ordering (now for a grant not started yet).
 */
export function defaultPlanReadGrantSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`
		SELECT held.id AS grant_id, version.plan_version_id,
			COALESCE(held.starts_at, previous.starts_at, now()) AS anchor_at,
			COALESCE(held.id, previous.id) AS allocations_grant_id,
			COALESCE(held.created_at, now()) AS created_at
		FROM (SELECT ${defaultPlanReadVersionSql(projectId, customerId)} AS plan_version_id) version
		LEFT JOIN plan_grants held
			ON held.project_id = ${projectId}
			AND held.customer_id = ${customerId}
			AND held.origin = 'default'
			AND held.status = 'active'
		LEFT JOIN LATERAL (${previousDefaultGrantSql(projectId, customerId)}) previous ON true
		WHERE version.plan_version_id IS NOT NULL
	`;
}

/**
 * Whether a live allocation is an allowance of the account's default-plan grant that its next
 * write ends: the catalog dropped the marker, a base plan took over, or the version reads count
 * no longer allocates its feature on the same reset. Reads leave such an allowance out, as that
 * write will (see `reconcileDefaultPlanGrant`). Takes the allocation's table alias.
 */
export function defaultPlanAllowanceEndingSql(
	projectId: string,
	allocation: DrizzleSQL,
): DrizzleSQL {
	return drizzleSql`EXISTS (
		SELECT 1
		FROM plan_grants held
		JOIN plan_items allocated
			ON allocated.project_id = held.project_id AND allocated.id = ${allocation}.plan_item_id
		WHERE held.project_id = ${projectId}
			AND held.id = ${allocation}.plan_grant_id
			AND held.origin = 'default'
			AND held.status = 'active'
			AND NOT EXISTS (
				SELECT 1 FROM plan_items kept
				WHERE kept.project_id = held.project_id
					AND kept.plan_version_id = ${defaultPlanReadVersionSql(projectId, drizzleSql`held.customer_id`)}
					AND kept.item_kind = 'allocation'
					AND kept.allocation_scope = 'account'
					AND kept.feature_id = allocated.feature_id
					AND kept.reset_interval IS NOT DISTINCT FROM allocated.reset_interval
					AND kept.reset_interval_count = allocated.reset_interval_count
			)
	)`;
}

/**
 * Whether the account's default-plan grant differs from what the catalog asks for: one to start,
 * one to supersede because a base plan took over, or one to move or end after a publish.
 */
export function defaultPlanOutOfDateSql(projectId: string, customerId: DrizzleSQL): DrizzleSQL {
	return drizzleSql`(
		${defaultPlanPendingSql(projectId, customerId)}
		OR EXISTS (
			SELECT 1
			FROM plan_grants held
			LEFT JOIN (${defaultPlanTargetSql(projectId)}) target ON true
			WHERE held.project_id = ${projectId}
				AND held.customer_id = ${customerId}
				AND held.origin = 'default'
				AND held.status = 'active'
				AND (
					target.plan_id IS NULL
					OR held.plan_version_id <> target.plan_version_id::bigint
					OR held.entitlement_keys <> target.entitlement_keys
					OR ${heldBasePlanSql(projectId, customerId)}
				)
		)
	)`;
}
