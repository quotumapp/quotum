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
