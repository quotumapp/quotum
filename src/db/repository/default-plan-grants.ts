import { sql as drizzleSql } from "drizzle-orm";
import { activeBaseGrantSql, fundingBaseSubscriptionSql } from "./base-plan-sources";
import { defaultPlanTargetSql, previousDefaultGrantSql } from "./default-plan-sql";
import { clampPlanGrantAllocations, resumeDefaultPlanAllowances } from "./plan-grant-windows";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

/** The actor recorded on grants the catalog's default plan starts, moves and ends. */
export const defaultPlanActor = "catalog:default-plan";

/** The published default plan: the marked plan's active version and the marker's keys. */
export interface DefaultPlanTarget {
	planId: string;
	planVersionId: string;
	entitlementKeys: string[];
	revision: number;
}

export type DefaultPlanChange = "started" | "moved" | "superseded" | "ended";

export interface DefaultPlanOutcome {
	change: DefaultPlanChange;
	grantId: string;
	/** The catalog revision whose default plan the account now follows, or null without one. */
	revision: number | null;
}

interface DefaultPlanStateRow {
	target_plan_id: string | null;
	target_plan_version_id: string | null;
	target_entitlement_keys: string[] | null;
	target_revision: number | null;
	grant_id: string | null;
	grant_plan_version_id: string | null;
	grant_entitlement_keys: string[] | null;
	funding_subscription_id: string | null;
	base_grant_id: string | null;
	previous_grant_id: string | null;
}

/** The target of the project's published catalog, or null when it marks no usable default. */
export async function readDefaultPlanTarget(
	executor: QueryExecutor,
	projectId: string,
): Promise<DefaultPlanTarget | null> {
	const row = await executeOne<{
		plan_id: string;
		plan_version_id: string;
		entitlement_keys: string[];
		revision: number;
	}>(executor, drizzleSql`${defaultPlanTargetSql(projectId)}`);
	return row === null
		? null
		: {
				planId: row.plan_id,
				planVersionId: row.plan_version_id,
				entitlementKeys: row.entitlement_keys,
				revision: row.revision,
			};
}

export function sameDefaultPlanTarget(
	left: DefaultPlanTarget | null,
	right: DefaultPlanTarget | null,
): boolean {
	return (
		left?.planId === right?.planId &&
		left?.planVersionId === right?.planVersionId &&
		JSON.stringify(left?.entitlementKeys ?? null) === JSON.stringify(right?.entitlementKeys ?? null)
	);
}

/**
 * Brings one account's default-plan grant in line with the catalog, under the caller's lock on the
 * customer: starts it for an account without a base plan, supersedes it when a paid base plan or a
 * trial takes over, moves it to the plan's current version or keys, and ends it when the catalog
 * drops the marker. It reads the account's state in one statement and writes only on a change.
 *
 * A grant that replaces an earlier default-plan grant starts where that one started and takes over
 * the allowances it left in the windows still running, so an account that falls back within a
 * window resumes what was left of it, and its meter limits keep counting the same window.
 */
export async function reconcileDefaultPlanGrant(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<DefaultPlanOutcome | null> {
	const state = await executeOne<DefaultPlanStateRow>(
		executor,
		drizzleSql`
			SELECT
				target.plan_id AS target_plan_id,
				target.plan_version_id AS target_plan_version_id,
				target.entitlement_keys AS target_entitlement_keys,
				target.revision AS target_revision,
				held.id AS grant_id,
				held.plan_version_id::text AS grant_plan_version_id,
				held.entitlement_keys AS grant_entitlement_keys,
				${fundingBaseSubscriptionSql(projectId, drizzleSql`${customerId}::uuid`)}
					AS funding_subscription_id,
				${activeBaseGrantSql(projectId, drizzleSql`${customerId}::uuid`)} AS base_grant_id,
				previous.id AS previous_grant_id
			FROM (SELECT 1) anchor
			LEFT JOIN (${defaultPlanTargetSql(projectId)}) target ON true
			LEFT JOIN plan_grants held
				ON held.project_id = ${projectId}
				AND held.customer_id = ${customerId}::uuid
				AND held.origin = 'default'
				AND held.status = 'active'
			LEFT JOIN LATERAL (
				${previousDefaultGrantSql(projectId, drizzleSql`${customerId}::uuid`)}
			) previous ON true
		`,
	);
	if (state === null) return null;
	const target: DefaultPlanTarget | null =
		state.target_plan_id === null ||
		state.target_plan_version_id === null ||
		state.target_revision === null
			? null
			: {
					planId: state.target_plan_id,
					planVersionId: state.target_plan_version_id,
					entitlementKeys: state.target_entitlement_keys ?? [],
					revision: state.target_revision,
				};
	const heldBase = state.funding_subscription_id !== null || state.base_grant_id !== null;
	const revision = target?.revision ?? null;
	if (state.grant_id !== null) {
		const grantId = state.grant_id;
		if (heldBase) {
			await supersedeGrant(executor, projectId, grantId, {
				subscriptionId: state.funding_subscription_id,
				planGrantId: state.funding_subscription_id === null ? state.base_grant_id : null,
			});
			return { change: "superseded", grantId, revision };
		}
		if (target === null) {
			await endGrant(executor, projectId, grantId);
			return { change: "ended", grantId, revision };
		}
		const versionChanged = state.grant_plan_version_id !== target.planVersionId;
		const keysChanged =
			JSON.stringify(state.grant_entitlement_keys ?? []) !== JSON.stringify(target.entitlementKeys);
		if (!versionChanged && !keysChanged) return null;
		await moveGrant(executor, projectId, grantId, target, versionChanged);
		return { change: "moved", grantId, revision };
	}
	if (heldBase || target === null) return null;
	const previousGrantId = state.previous_grant_id;
	const started = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			INSERT INTO plan_grants (
				project_id, customer_id, plan_id, plan_version_id, plan_kind, origin, status, starts_at,
				entitlement_keys, actor, metadata
			)
			SELECT
				${projectId}, ${customerId}::uuid, ${target.planId}::bigint, ${target.planVersionId}::bigint,
				'base', 'default', 'active',
				COALESCE(
					(SELECT starts_at FROM plan_grants WHERE project_id = ${projectId} AND id = ${previousGrantId}::uuid),
					now()
				),
				ARRAY(SELECT jsonb_array_elements_text(${jsonb(target.entitlementKeys)})),
				${defaultPlanActor},
				${jsonb({
					catalogRevision: target.revision,
					...(previousGrantId === null ? {} : { resumesPlanGrantId: previousGrantId }),
				})}
			-- An elapsed trial the worker has not recorded yet still holds the account's one active
			-- base grant; the default plan starts when that trial is recorded as expired.
			ON CONFLICT (project_id, customer_id) WHERE status = 'active' AND plan_kind = 'base'
			DO NOTHING
			RETURNING id
		`,
	);
	if (started === null) return null;
	if (previousGrantId !== null) {
		await resumeDefaultPlanAllowances(
			executor,
			projectId,
			previousGrantId,
			started.id,
			target.planVersionId,
		);
	}
	return { change: "started", grantId: started.id, revision };
}

/** Supersedes the account's default-plan grant with a trial whose row is inserted afterwards. */
export async function supersedeDefaultPlanGrant(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	byPlanGrantId: string,
): Promise<void> {
	const held = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			SELECT id FROM plan_grants
			WHERE project_id = ${projectId}
				AND customer_id = ${customerId}::uuid
				AND origin = 'default'
				AND status = 'active'
			FOR UPDATE
		`,
	);
	if (held === null) return;
	await supersedeGrant(executor, projectId, held.id, {
		subscriptionId: null,
		planGrantId: byPlanGrantId,
	});
}

async function supersedeGrant(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
	by: { subscriptionId: string | null; planGrantId: string | null },
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			UPDATE plan_grants
			SET status = 'superseded',
				ended_at = now(),
				superseded_by_subscription_id = ${by.subscriptionId}::uuid,
				superseded_by_plan_grant_id = ${by.planGrantId}::uuid,
				updated_at = now()
			WHERE project_id = ${projectId} AND id = ${grantId}::uuid AND status = 'active'
			RETURNING id
		`,
	);
	await clampPlanGrantAllocations(executor, projectId, grantId);
}

async function endGrant(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			UPDATE plan_grants
			SET status = 'ended',
				ended_at = now(),
				end_actor = ${defaultPlanActor},
				end_reason = 'default_plan_removed',
				updated_at = now()
			WHERE project_id = ${projectId} AND id = ${grantId}::uuid AND status = 'active'
			RETURNING id
		`,
	);
	await clampPlanGrantAllocations(executor, projectId, grantId);
}

/**
 * Moves the grant to the plan's current version or keys in place, keeping its id and start, so its
 * windows keep their anchor. A live allowance whose feature the new version still allocates stays
 * for the rest of its window: on the same reset it becomes the new item's allowance, and on another
 * reset it keeps its own window, and the new reset's quantity starts where it ends (see
 * `PlanGrantWindow.start`). An allowance whose feature the new version drops ends. New quantities
 * apply from the next window a write creates, so republishing the plan never refills what the
 * window already gave: an allowance a move ended because its version dropped the feature is
 * reopened, not granted again, when a later version adds the feature back within the window (see
 * `openPlanGrantWindows`).
 */
async function moveGrant(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
	target: DefaultPlanTarget,
	versionChanged: boolean,
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			UPDATE plan_grants
			SET plan_id = ${target.planId}::bigint,
				plan_version_id = ${target.planVersionId}::bigint,
				entitlement_keys = ARRAY(SELECT jsonb_array_elements_text(${jsonb(target.entitlementKeys)})),
				metadata = metadata || ${jsonb({ catalogRevision: target.revision })},
				updated_at = now()
			WHERE project_id = ${projectId} AND id = ${grantId}::uuid AND status = 'active'
			RETURNING id
		`,
	);
	if (!versionChanged) return;
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations allocation
			SET plan_item_id = kept.id, updated_at = now()
			FROM plan_items previous, plan_items kept
			WHERE allocation.project_id = ${projectId}
				AND allocation.plan_grant_id = ${grantId}::uuid
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
				AND previous.project_id = allocation.project_id
				AND previous.id = allocation.plan_item_id
				AND kept.project_id = allocation.project_id
				AND kept.plan_version_id = ${target.planVersionId}::bigint
				AND kept.item_kind = 'allocation'
				AND kept.allocation_scope = 'account'
				AND kept.feature_id = allocation.feature_id
				AND kept.reset_interval IS NOT DISTINCT FROM previous.reset_interval
				AND kept.reset_interval_count = previous.reset_interval_count
		`,
	);
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations allocation
			SET expires_at = now(), updated_at = now()
			WHERE allocation.project_id = ${projectId}
				AND allocation.plan_grant_id = ${grantId}::uuid
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
				AND NOT EXISTS (
					SELECT 1 FROM plan_items item
					WHERE item.project_id = allocation.project_id
						AND item.plan_version_id = ${target.planVersionId}::bigint
						AND item.item_kind = 'allocation'
						AND item.allocation_scope = 'account'
						AND item.feature_id = allocation.feature_id
				)
		`,
	);
}
