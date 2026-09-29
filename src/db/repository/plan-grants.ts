import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { decodeAdminCursor, encodeAdminCursor } from "../../admin/query";
import { NotFoundBillingError, PersistenceConflictError } from "../../billing/errors";
import {
	normalizeTrialEndInput,
	normalizeTrialStartInput,
	type PlanGrantStatus,
	type TrialEligibility,
	type TrialEndInput,
	type TrialIneligibility,
	type TrialListResult,
	type TrialMutationResult,
	type TrialRecord,
	type TrialServiceLike,
	type TrialStartInput,
	trialEndRequestHash,
	trialError,
	trialStartRequestHash,
} from "../../billing/plan-grants";
import { trialEndingNoticeLeadMs } from "../../billing/trials";
import type { BillingProvider, ProjectionTrialPayload } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import type { CadenceUnit } from "../../shared/cadence";
import { RepositoryModule } from "./base";
import { heldBasePlanSql } from "./base-plan-sources";
import { reconcileDefaultPlanGrant, supersedeDefaultPlanGrant } from "./default-plan-grants";
import {
	enqueueProjectionSyncJob,
	enqueueUsageProjection,
	recomputeCustomerEntitlements,
} from "./entitlements";
import { ensureCustomer } from "./identities";
import { clampPlanGrantAllocations, materializePlanGrantPeriod } from "./plan-grant-periods";
import { executeOne, executeRows, jsonb } from "./query";
import type { PlanGrantReconciliationResult, QueryExecutor } from "./types";
import { formatUtcTimestamp, requirePositiveLimit } from "./validation";

interface PlanGrantRow {
	id: string;
	project_id: string;
	customer_id: string;
	billing_account_id: string;
	plan_key: string;
	plan_version: number | string;
	origin: "trial" | "default";
	status: PlanGrantStatus;
	/** Null only on a default-plan grant, which has no end. */
	duration_count: number | null;
	starts_at: Date | string;
	ends_at: Date | string | null;
	ended_at: Date | string | null;
	entitlement_keys: string[];
	superseded_provider: BillingProvider | null;
	superseded_external_id: string | null;
	end_reason: string | null;
	actor: string;
	metadata: Record<string, unknown>;
	created_at: Date | string;
	cursor_created_at: string;
	request_hash: string | null;
	end_idempotency_key: string | null;
	end_request_hash: string | null;
	elapsed: boolean;
}

interface TrialPlanRow {
	plan_id: string | number | bigint;
	plan_version_id: string | number | bigint;
	plan_kind: "base" | "addon";
	trial_days: number | null;
	unsupported_items: boolean;
	default_plan: boolean;
}

/** Statuses of a subscription that still funds its plan. */
const fundingStatuses = drizzleSql`('active', 'grace_period', 'billing_retry', 'cancelled')`;

interface DefaultPlanJob {
	id: string | number;
	project_id: string;
}

/** Transactions one worker pass spends on allowance windows, and on default-plan slices. */
const maxWorkerBatches = 10;

/** Customers a default-plan slice scans for accounts whose grant must change. */
const defaultPlanScanSize = 1000;

export class PlanGrantRepository extends RepositoryModule implements TrialServiceLike {
	async startTrial(
		project: ProjectInstanceContext,
		rawInput: TrialStartInput,
	): Promise<TrialMutationResult> {
		const input = normalizeTrialStartInput(rawInput);
		const requestHash = trialStartRequestHash(input);
		// Namespaced so a caller's key can never collide with a grant another origin creates.
		const idempotencyKey = `trial_start:${input.idempotencyKey}`;
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			// The upsert locks the customer for the rest of the transaction, serializing trial starts
			// with provider events that supersede grants.
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const replay = await readPlanGrant(
				tx,
				projectId,
				drizzleSql`g.customer_id = ${customer.id} AND g.idempotency_key = ${idempotencyKey}`,
			);
			if (replay !== null) {
				if (replay.request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different trial start",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return { duplicate: true, trial: toTrialRecord(replay) };
			}
			// An elapsed grant the worker has not recorded yet must not block this start.
			await expirePlanGrantsWhere(
				tx,
				drizzleSql`g.project_id = ${projectId} AND g.customer_id = ${customer.id}`,
				100,
			);
			const plan = await resolveTrialPlan(tx, projectId, input.planKey);
			const ineligible =
				trialPlanIneligibility(plan) ??
				(await customerTrialIneligibility(tx, projectId, customer.id, plan));
			if (ineligible !== null) {
				throw trialError(ineligible, { planKey: input.planKey });
			}
			const durationDays = input.durationDays ?? positiveOrNull(plan.trial_days);
			if (durationDays === null) {
				throw trialError("TRIAL_DURATION_REQUIRED", { planKey: input.planKey });
			}
			// The trial takes the account's one active base grant from the default plan, which returns
			// when the trial ends. The foreign key to the trial is checked at commit.
			const trialId = crypto.randomUUID();
			await supersedeDefaultPlanGrant(tx, projectId, customer.id, trialId);
			const inserted = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO plan_grants (
						id, project_id, customer_id, plan_id, plan_version_id, plan_kind, origin, status,
						duration_unit, duration_count, starts_at, ends_at, entitlement_keys, actor, metadata,
						idempotency_key, request_hash
					)
					SELECT
						${trialId}::uuid, ${projectId}, ${customer.id}, ${String(plan.plan_id)}::bigint,
						${String(plan.plan_version_id)}::bigint, ${plan.plan_kind}, 'trial', 'active', 'day',
						${durationDays}, now(), now() + ${durationDays} * interval '24 hours',
						COALESCE(
							(
								SELECT array_agg(DISTINCT product.entitlement_key)
								FROM provider_plan_bindings binding
								JOIN store_products store_product
									ON store_product.project_id = binding.project_id
									AND store_product.id = binding.store_product_id
								JOIN products product
									ON product.project_id = store_product.project_id
									AND product.id = store_product.product_id
								WHERE binding.project_id = ${projectId}
									AND binding.plan_version_id = ${String(plan.plan_version_id)}::bigint
									AND binding.status = 'published'
							),
							ARRAY[]::text[]
						),
						${input.actor ?? `billing-account:${input.billingAccountId}`},
						${jsonb(input.metadata)}, ${idempotencyKey}, ${requestHash}
					RETURNING id
				`,
			);
			if (inserted === null) throw new Error("Trial could not be recorded");
			await materializePlanGrantPeriod(tx, projectId, inserted.id);
			const snapshot = await recomputeCustomerEntitlements(
				tx,
				projectId,
				customer.billing_account_id,
			);
			// A stored job, so a receiver that turned usage deliveries off still learns about it.
			await enqueueProjectionSyncJob(tx, {
				customerId: customer.id,
				idempotencyKey: `plan_grant:${inserted.id}:started`,
				reason: "usage_changed",
				payload: {
					billingAccountId: customer.billing_account_id,
					reason: "usage_changed",
					entitlements: snapshot,
				},
			});
			return { duplicate: false, trial: await requireTrialRecord(tx, projectId, inserted.id) };
		});
	}

	async endTrial(
		project: ProjectInstanceContext,
		rawInput: TrialEndInput,
	): Promise<TrialMutationResult> {
		const input = normalizeTrialEndInput(rawInput);
		const requestHash = trialEndRequestHash(input);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await executeOne<{ id: string; billing_account_id: string }>(
				tx,
				drizzleSql`
					SELECT id, billing_account_id FROM customers
					WHERE project_id = ${projectId} AND billing_account_id = ${input.billingAccountId}
					FOR UPDATE
				`,
			);
			if (customer === null) throw trialError("TRIAL_NOT_FOUND");
			const grant = await readPlanGrant(
				tx,
				projectId,
				drizzleSql`g.id = ${input.trialId}::uuid AND g.customer_id = ${customer.id} AND g.origin = 'trial'`,
			);
			if (grant === null) throw trialError("TRIAL_NOT_FOUND");
			if (grant.end_idempotency_key === input.idempotencyKey) {
				if (grant.end_request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different trial end",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return { duplicate: true, trial: toTrialRecord(grant) };
			}
			const ended = await executeOne<{ ended_at: Date | string }>(
				tx,
				drizzleSql`
					UPDATE plan_grants
					SET
						status = 'ended',
						ended_at = now(),
						next_period_at = NULL,
						end_actor = ${input.actor ?? `billing-account:${input.billingAccountId}`},
						end_reason = ${input.reason},
						end_idempotency_key = ${input.idempotencyKey},
						end_request_hash = ${requestHash},
						updated_at = now()
					WHERE project_id = ${projectId}
						AND id = ${grant.id}
						AND status = 'active'
						AND ends_at > now()
					RETURNING ended_at
				`,
			);
			if (ended === null) {
				throw trialError("TRIAL_NOT_ACTIVE", { status: toTrialRecord(grant).status });
			}
			await clampPlanGrantAllocations(tx, projectId, grant.id);
			const snapshot = await recomputeCustomerEntitlements(
				tx,
				projectId,
				customer.billing_account_id,
			);
			await enqueueProjectionSyncJob(tx, {
				customerId: customer.id,
				idempotencyKey: `plan_grant:${grant.id}:ended`,
				reason: "usage_changed",
				payload: {
					billingAccountId: customer.billing_account_id,
					reason: "usage_changed",
					entitlements: snapshot,
					trial: planGrantTrialFact(grant, "ended", ended.ended_at),
				},
			});
			return { duplicate: false, trial: await requireTrialRecord(tx, projectId, grant.id) };
		});
	}

	async listTrials(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: { limit: number; cursor: string | null },
	): Promise<TrialListResult> {
		const limit = requirePositiveLimit(options.limit);
		const projectId = project.projectInstanceId;
		const keyset =
			options.cursor === null
				? drizzleSql`true`
				: (() => {
						const cursor = decodeAdminCursor(options.cursor);
						return drizzleSql`(g.created_at, g.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
					})();
		const rows = await readPlanGrants(
			this.database,
			projectId,
			drizzleSql`c.billing_account_id = ${billingAccountId} AND g.origin = 'trial' AND ${keyset}`,
			limit + 1,
		);
		const last = rows[limit - 1];
		return {
			items: rows.slice(0, limit).map(toTrialRecord),
			nextCursor:
				rows.length > limit && last !== undefined
					? encodeAdminCursor({ createdAt: last.cursor_created_at, id: last.id })
					: null,
		};
	}

	async getTrial(
		project: ProjectInstanceContext,
		billingAccountId: string,
		trialId: string,
	): Promise<TrialRecord> {
		const grant = await readPlanGrant(
			this.database,
			project.projectInstanceId,
			drizzleSql`g.id = ${trialId}::uuid AND c.billing_account_id = ${billingAccountId} AND g.origin = 'trial'`,
		);
		if (grant === null) throw trialError("TRIAL_NOT_FOUND");
		return toTrialRecord(grant);
	}

	async trialEligibility(
		project: ProjectInstanceContext,
		billingAccountId: string,
		planKey: string,
	): Promise<TrialEligibility> {
		const projectId = project.projectInstanceId;
		const plan = await resolveTrialPlan(this.database, projectId, planKey.trim());
		const customer = await executeOne<{ id: string }>(
			this.database,
			drizzleSql`
				SELECT id FROM customers
				WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
			`,
		);
		const reason =
			trialPlanIneligibility(plan) ??
			(customer === null
				? null
				: await customerTrialIneligibility(this.database, projectId, customer.id, plan));
		return {
			planKey: planKey.trim(),
			eligible: reason === null,
			reason,
			defaultDurationDays: positiveOrNull(plan.trial_days),
		};
	}

	/**
	 * Worker pass: expires elapsed grants, which lets their accounts fall back to the default plan;
	 * materializes allowances for reset windows begun; then applies a changed default plan to the
	 * accounts of projects that published one. Allowance and default-plan work loops over several
	 * transactions, because every free account holds a grant.
	 */
	async reconcilePlanGrants(limit: number): Promise<PlanGrantReconciliationResult> {
		const cappedLimit = requirePositiveLimit(limit);
		const expired = await this.transaction((tx) =>
			expirePlanGrantsWhere(tx, drizzleSql`true`, cappedLimit),
		);
		let periods = 0;
		for (let batch = 0; batch < maxWorkerBatches; batch += 1) {
			const materialized = await this.transaction((tx) =>
				materializeDuePlanGrantPeriods(tx, cappedLimit),
			);
			periods += materialized;
			if (materialized < cappedLimit) break;
		}
		let defaultPlanGrants = 0;
		for (let batch = 0; batch < maxWorkerBatches; batch += 1) {
			const changed = await this.reconcileDefaultPlanBatch(cappedLimit);
			if (changed === null) break;
			defaultPlanGrants += changed;
		}
		return { expiredPlanGrants: expired, planGrantPeriods: periods, defaultPlanGrants };
	}

	/**
	 * Advances the oldest due default-plan pass by one slice of customers, or returns null when none
	 * is due. A failed slice rolls back, and the pass is retried with backoff from where it stood.
	 */
	private async reconcileDefaultPlanBatch(limit: number): Promise<number | null> {
		const due = await executeOne<DefaultPlanJob>(
			this.database,
			drizzleSql`
				SELECT id, project_id
				FROM default_plan_reconciliations
				WHERE status = 'pending' AND next_attempt_at <= now()
				ORDER BY next_attempt_at, id
				LIMIT 1
			`,
		);
		if (due === null) return null;
		try {
			return await this.transaction((tx) => reconcileDefaultPlanSlice(tx, due, limit));
		} catch (error) {
			await this.transaction((tx) => recordDefaultPlanFailure(tx, due, error));
			throw error;
		}
	}

	/** Worker pass: one `ending` fact per trial grant within the notice lead of its end. */
	async enqueuePlanGrantEndingNotices(
		limit: number,
	): Promise<{ noticedTrials: number; affectedCustomers: number; projectionJobs: number }> {
		const cappedLimit = requirePositiveLimit(limit);
		const leadSeconds = trialEndingNoticeLeadMs / 1000;
		return await this.transaction(async (tx) => {
			const rows = await executeRows<PlanGrantRow>(
				tx,
				drizzleSql`
				WITH candidates AS MATERIALIZED (
					SELECT g.id, g.customer_id
					FROM plan_grants g
					WHERE g.status = 'active'
						AND g.origin = 'trial'
						AND g.ending_notified_at IS NULL
						AND g.ends_at > now()
						AND g.ends_at <= now() + make_interval(secs => ${leadSeconds})
					ORDER BY g.ends_at ASC, g.id ASC
					LIMIT ${cappedLimit}
				),
				locked_customers AS MATERIALIZED (
					SELECT c.id
					FROM customers c
					JOIN (SELECT DISTINCT customer_id FROM candidates) candidate_customers
						ON candidate_customers.customer_id = c.id
					ORDER BY c.id
					FOR UPDATE OF c
				),
				due AS MATERIALIZED (
					SELECT g.id
					FROM plan_grants g
					JOIN candidates candidate ON candidate.id = g.id
					JOIN locked_customers locked_customer ON locked_customer.id = g.customer_id
					WHERE g.status = 'active'
						AND g.ending_notified_at IS NULL
						AND g.ends_at > now()
					ORDER BY g.ends_at ASC, g.id ASC
					FOR UPDATE OF g SKIP LOCKED
				)
				UPDATE plan_grants g
				SET ending_notified_at = now()
				FROM due
				WHERE g.id = due.id
				RETURNING g.id, g.project_id
			`,
			);
			const customers = new Set<string>();
			let projectionJobs = 0;
			for (const claimed of rows) {
				const grant = await requirePlanGrantRow(tx, claimed.project_id, claimed.id);
				customers.add(grant.customer_id);
				const snapshot = await recomputeCustomerEntitlements(
					tx,
					grant.project_id,
					grant.billing_account_id,
				);
				const enqueued = await enqueueProjectionSyncJob(tx, {
					customerId: grant.customer_id,
					idempotencyKey: `trial_ending:plan_grant:${grant.id}:${formatUtcTimestamp(grant.ends_at)}`,
					reason: "expiry_reconciliation",
					payload: {
						billingAccountId: grant.billing_account_id,
						reason: "expiry_reconciliation",
						entitlements: snapshot,
						trial: planGrantTrialFact(grant, "ending"),
					},
				});
				if (enqueued) projectionJobs += 1;
			}
			return { noticedTrials: rows.length, affectedCustomers: customers.size, projectionJobs };
		});
	}
}

/**
 * Ends the account's active base grants when a paid base subscription funds a plan. The customer
 * lock comes first, so a trial start either finishes before this and is superseded, or waits and
 * then finds the paid subscription. No trial fact is sent: the customer converted.
 */
export async function supersedeBasePlanGrants(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		subscriptionId: string;
		planVersionId: string;
	},
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			SELECT id FROM customers
			WHERE project_id = ${input.projectId} AND id = ${input.customerId}
			FOR UPDATE
		`,
	);
	await executeRows(
		executor,
		drizzleSql`
			WITH superseded AS (
				UPDATE plan_grants g
				SET
					status = 'superseded',
					ended_at = now(),
					next_period_at = NULL,
					superseded_by_subscription_id = ${input.subscriptionId},
					updated_at = now()
				WHERE g.project_id = ${input.projectId}
					AND g.customer_id = ${input.customerId}
					AND g.status = 'active'
					AND g.plan_kind = 'base'
					AND (g.ends_at IS NULL OR g.ends_at > now())
					AND EXISTS (
						SELECT 1 FROM plan_versions version
						WHERE version.project_id = ${input.projectId}
							AND version.id = ${input.planVersionId}::bigint
							AND version.plan_kind = 'base'
					)
				RETURNING g.id
			)
			UPDATE balance_allocations allocation
			SET expires_at = now(), updated_at = now()
			FROM superseded
			WHERE allocation.project_id = ${input.projectId}
				AND allocation.plan_grant_id = superseded.id
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
		`,
	);
}

/**
 * Whether the account has had a trial of the plan: a Quotum trial of it, or a provider
 * subscription on it that recorded trial bounds.
 */
export function planTrialUsedSql(
	projectId: string,
	customerId: DrizzleSQL,
	planId: DrizzleSQL,
): DrizzleSQL {
	return drizzleSql`(
		EXISTS (
			SELECT 1 FROM plan_grants used_grant
			WHERE used_grant.project_id = ${projectId}
				AND used_grant.customer_id = ${customerId}
				AND used_grant.plan_id = ${planId}
				AND used_grant.origin = 'trial'
		)
		OR EXISTS (
			SELECT 1 FROM subscriptions used_subscription
			JOIN plan_versions used_version
				ON used_version.project_id = used_subscription.project_id
				AND used_version.id = used_subscription.plan_version_id
			WHERE used_subscription.project_id = ${projectId}
				AND used_subscription.customer_id = ${customerId}
				AND used_version.plan_id = ${planId}
				AND used_subscription.trial_start_at IS NOT NULL
		)
	)`;
}

async function resolveTrialPlan(
	executor: QueryExecutor,
	projectId: string,
	planKey: string,
): Promise<TrialPlanRow> {
	const plan = await executeOne<TrialPlanRow>(
		executor,
		drizzleSql`
			SELECT
				p.id AS plan_id,
				version.id AS plan_version_id,
				version.plan_kind,
				version.trial_days,
				EXISTS (
					SELECT 1 FROM plan_items item
					WHERE item.project_id = version.project_id
						AND item.plan_version_id = version.id
						AND (
							item.item_kind = 'licensed_quantity'
							OR (item.item_kind = 'allocation' AND item.allocation_scope <> 'account')
						)
				) AS unsupported_items,
				-- Every account without a base plan already holds the default plan.
				EXISTS (
					SELECT 1
					FROM projects project
					JOIN catalog_default_plans marker
						ON marker.project_id = project.id
						AND marker.catalog_revision_id = project.published_catalog_revision_id
					WHERE project.id = p.project_id AND marker.plan_id = p.id
				) AS default_plan
			FROM plans p
			JOIN plan_versions version
				ON version.project_id = p.project_id AND version.id = p.active_version_id
			WHERE p.project_id = ${projectId}
				AND p.key = ${planKey}
				AND p.active
				AND version.status = 'published'
				AND version.visibility = 'public'
		`,
	);
	if (plan === null) {
		throw new NotFoundBillingError(
			`Active plan ${planKey} was not found`,
			"BILLING_PLAN_NOT_FOUND",
		);
	}
	return plan;
}

function trialPlanIneligibility(plan: TrialPlanRow): TrialIneligibility | null {
	return plan.plan_kind !== "base" || plan.unsupported_items || plan.default_plan
		? "TRIAL_PLAN_NOT_ELIGIBLE"
		: null;
}

async function customerTrialIneligibility(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	plan: TrialPlanRow,
): Promise<TrialIneligibility | null> {
	const row = await executeOne<{
		active_grant: boolean;
		paid_base: boolean;
		trial_used: boolean;
	}>(
		executor,
		drizzleSql`
			SELECT
				EXISTS (
					SELECT 1 FROM plan_grants g
					WHERE g.project_id = ${projectId}
						AND g.customer_id = ${customerId}::uuid
						AND g.status = 'active'
						AND g.plan_kind = 'base'
						AND g.ends_at > now()
				) AS active_grant,
				EXISTS (
					SELECT 1 FROM subscriptions s
					JOIN plan_versions version
						ON version.project_id = s.project_id AND version.id = s.plan_version_id
					WHERE s.project_id = ${projectId}
						AND s.customer_id = ${customerId}::uuid
						AND version.plan_kind = 'base'
						AND s.status IN ${fundingStatuses}
						AND (s.expires_at IS NULL OR s.expires_at > now())
				) AS paid_base,
				${planTrialUsedSql(projectId, drizzleSql`${customerId}::uuid`, drizzleSql`${String(plan.plan_id)}::bigint`)} AS trial_used
		`,
	);
	if (row?.active_grant === true) return "TRIAL_ALREADY_ACTIVE";
	if (row?.paid_base === true) return "TRIAL_BASE_PLAN_ACTIVE";
	if (row?.trial_used === true) return "TRIAL_ALREADY_USED";
	return null;
}

/**
 * Records elapsed grants as expired, recomputes each account and delivers an
 * `expiry_reconciliation` projection; a trial's carries the `ended` fact. Readers already stop a
 * grant at its end, so this only makes the state explicit.
 */
async function expirePlanGrantsWhere(
	executor: QueryExecutor,
	scope: DrizzleSQL,
	limit: number,
): Promise<number> {
	const rows = await executeRows<{ id: string; project_id: string }>(
		executor,
		drizzleSql`
		WITH candidates AS MATERIALIZED (
			SELECT g.id, g.customer_id
			FROM plan_grants g
			WHERE g.status = 'active' AND g.ends_at <= now() AND ${scope}
			ORDER BY g.ends_at ASC, g.id ASC
			LIMIT ${limit}
		),
		locked_customers AS MATERIALIZED (
			SELECT c.id
			FROM customers c
			JOIN (SELECT DISTINCT customer_id FROM candidates) candidate_customers
				ON candidate_customers.customer_id = c.id
			ORDER BY c.id
			FOR UPDATE OF c
		),
		due AS MATERIALIZED (
			SELECT g.id
			FROM plan_grants g
			JOIN candidates candidate ON candidate.id = g.id
			JOIN locked_customers locked_customer ON locked_customer.id = g.customer_id
			WHERE g.status = 'active' AND g.ends_at <= now()
			ORDER BY g.ends_at ASC, g.id ASC
			FOR UPDATE OF g SKIP LOCKED
		)
		UPDATE plan_grants g
		SET status = 'expired', ended_at = g.ends_at, next_period_at = NULL, updated_at = now()
		FROM due
		WHERE g.id = due.id
		RETURNING g.id, g.project_id
	`,
	);
	for (const expired of rows) {
		const grant = await requirePlanGrantRow(executor, expired.project_id, expired.id);
		const snapshot = await recomputeCustomerEntitlements(
			executor,
			grant.project_id,
			grant.billing_account_id,
		);
		await enqueueProjectionSyncJob(executor, {
			customerId: grant.customer_id,
			idempotencyKey: `expiry_reconciliation:plan_grant:${grant.id}:${formatUtcTimestamp(grant.ends_at)}`,
			reason: "expiry_reconciliation",
			payload: {
				billingAccountId: grant.billing_account_id,
				reason: "expiry_reconciliation",
				entitlements: snapshot,
				...(grant.origin === "trial" ? { trial: planGrantTrialFact(grant, "ended") } : {}),
			},
		});
	}
	return rows.length;
}

async function materializeDuePlanGrantPeriods(
	executor: QueryExecutor,
	limit: number,
): Promise<number> {
	const rows = await executeRows<{ id: string; project_id: string; customer_id: string }>(
		executor,
		drizzleSql`
		WITH candidates AS MATERIALIZED (
			SELECT g.id, g.customer_id
			FROM plan_grants g
			WHERE g.status = 'active' AND g.next_period_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now())
			ORDER BY g.next_period_at ASC, g.id ASC
			LIMIT ${limit}
		),
		locked_customers AS MATERIALIZED (
			SELECT c.id
			FROM customers c
			JOIN (SELECT DISTINCT customer_id FROM candidates) candidate_customers
				ON candidate_customers.customer_id = c.id
			ORDER BY c.id
			FOR UPDATE OF c
		)
		SELECT g.id, g.project_id, g.customer_id
		FROM plan_grants g
		JOIN candidates candidate ON candidate.id = g.id
		JOIN locked_customers locked_customer ON locked_customer.id = g.customer_id
		WHERE g.status = 'active' AND g.next_period_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now())
		ORDER BY g.next_period_at ASC, g.id ASC
		FOR UPDATE OF g SKIP LOCKED
	`,
	);
	for (const row of rows) {
		await materializePlanGrantPeriod(executor, row.project_id, row.id);
		await enqueueUsageProjection(executor, {
			projectId: row.project_id,
			customerId: row.customer_id,
		});
	}
	return rows.length;
}

/**
 * One slice of a default-plan pass: the next customers by id whose default-plan grant must start,
 * move, end or give way, each under its own lock, with a stored projection per change.
 */
async function reconcileDefaultPlanSlice(
	executor: QueryExecutor,
	due: DefaultPlanJob,
	limit: number,
): Promise<number> {
	// Another worker holding the pass, or a publish that superseded it, leaves nothing to do here.
	const job = await executeOne<DefaultPlanJob & { after_customer_id: string | null }>(
		executor,
		drizzleSql`
			SELECT id, project_id, after_customer_id
			FROM default_plan_reconciliations
			WHERE project_id = ${due.project_id}
				AND id = ${String(due.id)}::bigint
				AND status = 'pending'
			FOR UPDATE SKIP LOCKED
		`,
	);
	if (job === null) return 0;
	const projectId = job.project_id;
	const scanned = await executeRows<{ id: string }>(
		executor,
		drizzleSql`
			SELECT c.id
			FROM customers c
			WHERE c.project_id = ${projectId}
				AND (${job.after_customer_id}::uuid IS NULL OR c.id > ${job.after_customer_id}::uuid)
			ORDER BY c.id
			LIMIT ${defaultPlanScanSize}
		`,
	);
	const candidates =
		scanned.length === 0
			? []
			: await executeRows<{ id: string; billing_account_id: string }>(
					executor,
					drizzleSql`
						SELECT c.id, c.billing_account_id
						FROM customers c
						LEFT JOIN plan_grants held
							ON held.project_id = c.project_id
							AND held.customer_id = c.id
							AND held.origin = 'default'
							AND held.status = 'active'
						LEFT JOIN (
							SELECT marker.plan_id, plan.active_version_id AS plan_version_id,
								marker.entitlement_keys
							FROM projects project
							JOIN catalog_default_plans marker
								ON marker.project_id = project.id
								AND marker.catalog_revision_id = project.published_catalog_revision_id
							JOIN plans plan
								ON plan.project_id = marker.project_id AND plan.id = marker.plan_id AND plan.active
							JOIN plan_versions version
								ON version.project_id = plan.project_id
								AND version.id = plan.active_version_id
								AND version.status = 'published'
								AND version.plan_kind = 'base'
							WHERE project.id = ${projectId}
						) target ON true
						WHERE c.project_id = ${projectId}
							AND c.id IN (
								SELECT jsonb_array_elements_text(${jsonb(scanned.map((row) => row.id))})::uuid
							)
							AND (
								(held.id IS NULL AND target.plan_id IS NOT NULL
									AND NOT ${heldBasePlanSql(projectId, drizzleSql`c.id`)})
								OR (held.id IS NOT NULL AND (
									target.plan_id IS NULL
									OR held.plan_version_id <> target.plan_version_id
									OR held.entitlement_keys <> target.entitlement_keys
									OR ${heldBasePlanSql(projectId, drizzleSql`c.id`)}
								))
							)
						ORDER BY c.id
						LIMIT ${limit + 1}
					`,
				);
	const handled = candidates.slice(0, limit);
	let changed = 0;
	for (const customer of handled) {
		await executeOne(
			executor,
			drizzleSql`
				SELECT id FROM customers WHERE project_id = ${projectId} AND id = ${customer.id} FOR UPDATE
			`,
		);
		const outcome = await reconcileDefaultPlanGrant(executor, projectId, customer.id);
		if (outcome === null) continue;
		changed += 1;
		const snapshot = await recomputeCustomerEntitlements(
			executor,
			projectId,
			customer.billing_account_id,
		);
		await enqueueProjectionSyncJob(executor, {
			customerId: customer.id,
			idempotencyKey:
				outcome.change === "moved"
					? `plan_grant:${outcome.grantId}:moved:${String(job.id)}`
					: `plan_grant:${outcome.grantId}:${outcome.change}`,
			reason: "usage_changed",
			payload: {
				billingAccountId: customer.billing_account_id,
				reason: "usage_changed",
				entitlements: snapshot,
			},
		});
	}
	// More candidates than one slice takes: resume after the last one handled, not the scan end.
	const cursor =
		candidates.length > limit ? (handled.at(-1)?.id ?? null) : (scanned.at(-1)?.id ?? null);
	const completed = candidates.length <= limit && scanned.length < defaultPlanScanSize;
	await executeOne(
		executor,
		drizzleSql`
			UPDATE default_plan_reconciliations
			SET after_customer_id = COALESCE(${cursor}::uuid, after_customer_id),
				customers_checked = customers_checked + ${
					candidates.length > limit
						? scanned.filter((row) => row.id <= (cursor ?? "")).length
						: scanned.length
				},
				grants_changed = grants_changed + ${changed},
				status = CASE WHEN ${completed} THEN 'completed' ELSE status END,
				completed_at = CASE WHEN ${completed} THEN now() ELSE NULL END,
				attempts = 0,
				last_error = NULL,
				next_attempt_at = now(),
				updated_at = now()
			WHERE project_id = ${projectId} AND id = ${String(job.id)}::bigint
			RETURNING id
		`,
	);
	return changed;
}

/** Backs off a default-plan pass after one of its slices failed. */
async function recordDefaultPlanFailure(
	executor: QueryExecutor,
	job: DefaultPlanJob,
	error: unknown,
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			UPDATE default_plan_reconciliations
			SET attempts = attempts + 1,
				last_error = ${error instanceof Error ? error.message.slice(0, 500) : "failed"},
				next_attempt_at = now() + LEAST(power(2, attempts) * interval '30 seconds', interval '1 hour'),
				updated_at = now()
			WHERE project_id = ${job.project_id}
				AND id = ${String(job.id)}::bigint
				AND status = 'pending'
			RETURNING id
		`,
	);
}

function planGrantSelect(projectId: string, condition: DrizzleSQL): DrizzleSQL {
	return drizzleSql`
		SELECT
			g.id,
			g.project_id,
			g.customer_id,
			c.billing_account_id,
			pl.key AS plan_key,
			version.version AS plan_version,
			g.origin,
			g.status,
			g.duration_count,
			g.starts_at,
			g.ends_at,
			g.ended_at,
			g.entitlement_keys,
			superseding.provider AS superseded_provider,
			superseding.external_subscription_id AS superseded_external_id,
			g.end_reason,
			g.actor,
			g.metadata,
			g.created_at,
			to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
			g.request_hash,
			g.end_idempotency_key,
			g.end_request_hash,
			g.ends_at <= now() AS elapsed
		FROM plan_grants g
		JOIN customers c ON c.project_id = g.project_id AND c.id = g.customer_id
		JOIN plans pl ON pl.project_id = g.project_id AND pl.id = g.plan_id
		JOIN plan_versions version ON version.project_id = g.project_id AND version.id = g.plan_version_id
		LEFT JOIN subscriptions superseding
			ON superseding.project_id = g.project_id
			AND superseding.id = g.superseded_by_subscription_id
		WHERE g.project_id = ${projectId} AND ${condition}
	`;
}

async function readPlanGrant(
	executor: QueryExecutor,
	projectId: string,
	condition: DrizzleSQL,
): Promise<PlanGrantRow | null> {
	return await executeOne<PlanGrantRow>(
		executor,
		drizzleSql`${planGrantSelect(projectId, condition)} LIMIT 1`,
	);
}

async function readPlanGrants(
	executor: QueryExecutor,
	projectId: string,
	condition: DrizzleSQL,
	limit: number,
): Promise<PlanGrantRow[]> {
	return await executeRows<PlanGrantRow>(
		executor,
		drizzleSql`${planGrantSelect(projectId, condition)} ORDER BY g.created_at DESC, g.id DESC LIMIT ${limit}`,
	);
}

async function requirePlanGrantRow(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
): Promise<PlanGrantRow> {
	const grant = await readPlanGrant(executor, projectId, drizzleSql`g.id = ${grantId}::uuid`);
	if (grant === null) throw new Error(`plan grant ${grantId} was not found`);
	return grant;
}

async function requireTrialRecord(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
): Promise<TrialRecord> {
	return toTrialRecord(await requirePlanGrantRow(executor, projectId, grantId));
}

function toTrialRecord(row: PlanGrantRow): TrialRecord {
	// Every read that reaches here filters on the trial origin; a default-plan grant has no term.
	if (row.origin !== "trial" || row.ends_at === null || row.duration_count === null) {
		throw new Error(`plan grant ${row.id} is not a trial`);
	}
	return {
		id: row.id,
		billingAccountId: row.billing_account_id,
		planKey: row.plan_key,
		planVersion: Number(row.plan_version),
		status: row.status === "active" && row.elapsed ? "expired" : row.status,
		startsAt: formatUtcTimestamp(row.starts_at),
		endsAt: formatUtcTimestamp(row.ends_at),
		endedAt:
			row.ended_at === null
				? row.status === "active" && row.elapsed
					? formatUtcTimestamp(row.ends_at)
					: null
				: formatUtcTimestamp(row.ended_at),
		durationDays: row.duration_count,
		entitlementKeys: [...row.entitlement_keys].sort(),
		supersededBy:
			row.superseded_provider === null || row.superseded_external_id === null
				? null
				: { provider: row.superseded_provider, externalSubscriptionId: row.superseded_external_id },
		endReason: row.end_reason,
		actor: row.actor,
		metadata: row.metadata,
		createdAt: formatUtcTimestamp(row.created_at),
	};
}

function planGrantTrialFact(
	grant: PlanGrantRow,
	event: "ending" | "ended",
	endedAt: Date | string | null = null,
): ProjectionTrialPayload {
	return {
		event,
		source: "plan_grant",
		planGrantId: grant.id,
		planKey: grant.plan_key,
		trialStartsAt: formatUtcTimestamp(grant.starts_at),
		trialEndsAt: formatUtcTimestamp(endedAt ?? grant.ends_at),
		autoRenew: false,
	};
}

function positiveOrNull(value: number | null): number | null {
	return value !== null && value > 0 ? value : null;
}
