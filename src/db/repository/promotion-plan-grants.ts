import { sql as drizzleSql } from "drizzle-orm";
import { type PromotionErrorCode, promotionError } from "../../billing/promotions";
import type { ProjectionPayload } from "../../billing/types";
import { supersedeDefaultPlanGrant } from "./default-plan-grants";
import { enqueueProjectionSyncJob, recomputeCustomerEntitlements } from "./entitlements";
import {
	activeBaseGrantSql,
	endedPlanGrantFacts,
	endPlanGrantInTx,
	expireCustomerPlanGrants,
	paidBasePlanSql,
	planCannotBeGranted,
	publishedEntitlementKeysSql,
	readGrantablePlan,
} from "./plan-grants";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

/** What a `plan_grant` promotion gives: which plan, and for how long. */
export interface PromotionPlanGrantTerms {
	planKey: string;
	durationUnit: "day" | "month";
	durationCount: number;
}

/**
 * Why an account cannot be given the promotion's plan now, or null. Read-only, for validation:
 * an account Quotum has not recorded holds nothing that could refuse it.
 */
export async function promotionPlanGrantIneligibility(
	executor: QueryExecutor,
	projectId: string,
	input: { planKey: string; billingAccountId: string },
): Promise<PromotionErrorCode | null> {
	const plan = await readGrantablePlan(executor, projectId, input.planKey);
	if (plan === null || planCannotBeGranted(plan)) return "PROMOTION_PLAN_NOT_ELIGIBLE";
	const customer = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			SELECT id FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${input.billingAccountId}
		`,
	);
	return customer === null ? null : await heldBasePlanRefusal(executor, projectId, customer.id);
}

/**
 * Gives the account the promotion's plan for its term, after the redemption took its use. The
 * grant pins the plan's active published version and supersedes only the default plan, which
 * returns when the grant ends. A refusal throws, so the transaction gives the use back.
 */
export async function grantPromotionPlanInTx(
	tx: QueryExecutor,
	input: {
		projectId: string;
		customer: { id: string; billing_account_id: string };
		redemptionId: string;
		terms: PromotionPlanGrantTerms;
		actor: string;
		requestHash: string;
	},
): Promise<void> {
	const { projectId, customer, terms } = input;
	// An elapsed grant the worker has not recorded yet must not block this one.
	await expireCustomerPlanGrants(tx, projectId, customer.id);
	const plan = await readGrantablePlan(tx, projectId, terms.planKey);
	if (plan === null || planCannotBeGranted(plan)) {
		throw promotionError("PROMOTION_PLAN_NOT_ELIGIBLE");
	}
	const refusal = await heldBasePlanRefusal(tx, projectId, customer.id);
	if (refusal !== null) throw promotionError(refusal);
	// The foreign key from the superseded default-plan grant to this one is checked at commit.
	const grantId = crypto.randomUUID();
	await supersedeDefaultPlanGrant(tx, projectId, customer.id, grantId);
	const term =
		terms.durationUnit === "month"
			? drizzleSql`make_interval(months => ${terms.durationCount}::integer)`
			: drizzleSql`${terms.durationCount} * interval '24 hours'`;
	const inserted = await executeOne<{ id: string }>(
		tx,
		drizzleSql`
			INSERT INTO plan_grants (
				id, project_id, customer_id, plan_id, plan_version_id, plan_kind, origin, status,
				duration_unit, duration_count, starts_at, ends_at, entitlement_keys, actor,
				idempotency_key, request_hash, promotion_redemption_id
			)
			SELECT
				${grantId}::uuid, ${projectId}, ${customer.id}, ${String(plan.plan_id)}::bigint,
				${String(plan.plan_version_id)}::bigint, ${plan.plan_kind}, 'promotion', 'active',
				${terms.durationUnit}, ${terms.durationCount}, now(), now() + ${term},
				${publishedEntitlementKeysSql(projectId, String(plan.plan_version_id))},
				${input.actor}, ${`promotion:${input.redemptionId}`}, ${input.requestHash},
				${input.redemptionId}::uuid
			RETURNING id
		`,
	);
	if (inserted === null) throw new Error("Promotional plan grant could not be recorded");
	await deliverPlanGrantChange(tx, projectId, customer, inserted.id, "started");
}

/**
 * Ends the grant a redemption gave, when it is still running, and delivers the change. A grant
 * that already expired or gave way to a paid plan is left as it stands.
 */
export async function endPromotionPlanGrantInTx(
	tx: QueryExecutor,
	input: {
		projectId: string;
		redemptionId: string;
		actor: string;
		reason: string;
		idempotencyKey: string;
		requestHash: string;
	},
): Promise<void> {
	const grant = await executeOne<{ id: string; customer_id: string; billing_account_id: string }>(
		tx,
		drizzleSql`
			SELECT g.id, g.customer_id, c.billing_account_id
			FROM plan_grants g
			JOIN customers c ON c.project_id = g.project_id AND c.id = g.customer_id
			WHERE g.project_id = ${input.projectId}
				AND g.promotion_redemption_id = ${input.redemptionId}::uuid
			FOR UPDATE OF g
		`,
	);
	if (grant === null) return;
	const endedAt = await endPlanGrantInTx(tx, {
		projectId: input.projectId,
		grantId: grant.id,
		actor: input.actor,
		reason: input.reason,
		idempotencyKey: input.idempotencyKey,
		requestHash: input.requestHash,
	});
	if (endedAt === null) return;
	await deliverPlanGrantChange(
		tx,
		input.projectId,
		{ id: grant.customer_id, billing_account_id: grant.billing_account_id },
		grant.id,
		"ended",
		await endedPlanGrantFacts(tx, input.projectId, grant.id, endedAt),
	);
}

/** A paid base plan, a trial or another promotional grant refuses a new grant; nothing stacks. */
async function heldBasePlanRefusal(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<PromotionErrorCode | null> {
	const row = await executeOne<{ active_grant: boolean; paid_base: boolean }>(
		executor,
		drizzleSql`
			SELECT
				${activeBaseGrantSql(projectId, drizzleSql`${customerId}::uuid`)} AS active_grant,
				${paidBasePlanSql(projectId, drizzleSql`${customerId}::uuid`)} AS paid_base
		`,
	);
	if (row?.active_grant === true) return "PROMOTION_PLAN_GRANT_ACTIVE";
	if (row?.paid_base === true) return "PROMOTION_BASE_PLAN_ACTIVE";
	return null;
}

/** A stored job, so a receiver that turned usage deliveries off still learns about the grant. */
async function deliverPlanGrantChange(
	tx: QueryExecutor,
	projectId: string,
	customer: { id: string; billing_account_id: string },
	grantId: string,
	change: "started" | "ended",
	facts: Pick<ProjectionPayload, "planGrant"> = {},
): Promise<void> {
	const snapshot = await recomputeCustomerEntitlements(tx, projectId, customer.billing_account_id);
	await enqueueProjectionSyncJob(tx, {
		customerId: customer.id,
		idempotencyKey: `plan_grant:${grantId}:${change}`,
		reason: "usage_changed",
		payload: {
			billingAccountId: customer.billing_account_id,
			reason: "usage_changed",
			entitlements: snapshot,
			...facts,
		},
	});
}
