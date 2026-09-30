import { sql as drizzleSql } from "drizzle-orm";
import {
	databaseDecimal,
	decimalToUnits,
	signedDecimalToUnits,
	unitsToDecimal,
} from "../../billing/decimal";
import type {
	EntitlementSnapshot,
	ProjectionJobPayload,
	ProjectionPayload,
	ProjectionSyncReason,
} from "../../billing/types";
import { reconcileDefaultPlanGrant } from "./default-plan-grants";
import {
	defaultPlanAllowanceEndingSql,
	defaultPlanReadVersionSql,
	defaultPlanTargetSql,
} from "./default-plan-sql";
import { combineMeterLimits, meterLimitBounds, queryMeterLimitRows } from "./meter-limit-sources";
import { type PendingAllowance, readPendingAllowances } from "./plan-grant-windows";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";
import { requireNonBlank, toIsoStringOrNull } from "./validation";

export async function getEntitlementSnapshot(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<EntitlementSnapshot> {
	const customer = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		SELECT c.id
		FROM customers c
		WHERE c.project_id = ${projectId}
			AND c.billing_account_id = ${billingAccountId}
		LIMIT 1
	`,
	);
	const [stored, pending] = await Promise.all([
		customer === null ? Promise.resolve([]) : readEntitlementRows(executor, projectId, customer.id),
		readPendingDefaultEntitlements(executor, projectId, customer?.id ?? null),
	]);
	return {
		billingAccountId,
		generatedAt: new Date().toISOString(),
		entitlements: withPendingEntitlements(stored, pending),
	};
}

/**
 * Source statuses under which a subscription, purchase or plan grant still runs. An entitlement a
 * running source no longer grants (a key the source dropped, or a period that passed before Quotum
 * recorded its end) reports `inactive`, so an inactive entitlement never reads as running.
 */
const runningSourceStatuses = ["active", "grace_period", "billing_retry", "cancelled", "completed"];

/**
 * An inactive entitlement's metadata: a running source status reads as `inactive`. Metadata is a
 * JSON column, so anything without a string `status` passes through unchanged.
 */
export function inactiveEntitlementMetadata(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	const status: unknown = metadata?.status;
	return typeof status === "string" && runningSourceStatuses.includes(status)
		? { ...metadata, status: "inactive" }
		: metadata;
}

interface PendingDefaultEntitlements {
	/** The marker's keys, when the account reads as holding the default plan. */
	held: EntitlementSnapshot["entitlements"];
	/**
	 * Stored keys of the account's default-plan grant that its next write deactivates, with the
	 * status that write leaves: `ended` when it ends the grant, `inactive` when the grant runs on
	 * without the key.
	 */
	ending: Array<{ key: string; status: "ended" | "inactive" }>;
}

/**
 * The default plan's entitlements as the account's next write will leave them, which a read
 * reports (see `defaultPlanReadVersionSql`): the marker's keys, active and without an end, for an
 * account without a base plan, and the stored keys of its default-plan grant that write
 * deactivates, because the catalog dropped the marker or the key. A null account is one Quotum
 * has not recorded yet.
 */
async function readPendingDefaultEntitlements(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
): Promise<PendingDefaultEntitlements> {
	const customer = drizzleSql`${customerId}::uuid`;
	const [held, ending] = await Promise.all([
		executeRows<{ key: string; plan_key: string }>(
			executor,
			drizzleSql`
				SELECT DISTINCT entitlement.key, plan.key AS plan_key
				FROM (${defaultPlanTargetSql(projectId)}) target
				JOIN plans plan ON plan.project_id = ${projectId} AND plan.id = target.plan_id::bigint
				CROSS JOIN LATERAL unnest(target.entitlement_keys) AS entitlement(key)
				WHERE ${defaultPlanReadVersionSql(projectId, customer)} IS NOT NULL
				ORDER BY entitlement.key
			`,
		),
		customerId === null
			? Promise.resolve([])
			: executeRows<{ key: string; still_held: boolean }>(
					executor,
					drizzleSql`
						SELECT
							e.entitlement_key AS key,
							${defaultPlanReadVersionSql(projectId, customer)} IS NOT NULL AS still_held
						FROM entitlements e
						JOIN plan_grants grant_source
							ON grant_source.project_id = e.project_id
							AND grant_source.id = e.source_plan_grant_id
							AND grant_source.origin = 'default'
							AND grant_source.status = 'active'
						WHERE e.project_id = ${projectId}
							AND e.customer_id = ${customer}
							AND e.active
							AND NOT EXISTS (
								SELECT 1 FROM (${defaultPlanTargetSql(projectId)}) target
								WHERE e.entitlement_key = ANY(target.entitlement_keys)
									AND ${defaultPlanReadVersionSql(projectId, customer)} IS NOT NULL
							)
					`,
				),
	]);
	return {
		held: held.map((row) => ({
			key: row.key,
			active: true,
			expiresAt: null,
			metadata: {
				source: "plan_grant",
				origin: "default",
				status: "active",
				planKey: row.plan_key,
			},
		})),
		ending: ending.map((row) => ({
			key: row.key,
			status: row.still_held ? "inactive" : "ended",
		})),
	};
}

/**
 * Applies the default plan's pending entitlements to the stored ones: a key the account's next
 * write deactivates reads inactive, and a held key stands in for a stored one only where that is
 * inactive or missing.
 */
function withPendingEntitlements(
	stored: EntitlementSnapshot["entitlements"],
	pending: PendingDefaultEntitlements,
): EntitlementSnapshot["entitlements"] {
	if (pending.held.length === 0 && pending.ending.length === 0) return stored;
	const ending = new Map(pending.ending.map((entry) => [entry.key, entry.status]));
	const byKey = new Map(
		stored.map((entry) => {
			const status = ending.get(entry.key);
			return [
				entry.key,
				status === undefined
					? entry
					: { ...entry, active: false, metadata: { ...entry.metadata, status } },
			];
		}),
	);
	for (const entry of pending.held) {
		if (byKey.get(entry.key)?.active !== true) byKey.set(entry.key, entry);
	}
	return [...byKey.values()].sort((left, right) =>
		left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
	);
}

/** The customer's entitlement entries as they stand; one statement. */
export async function readEntitlementRows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<EntitlementSnapshot["entitlements"]> {
	const rows = await executeRows<{
		key: string;
		active: boolean;
		expires_at: unknown;
		metadata: Record<string, unknown>;
	}>(
		executor,
		drizzleSql`
		SELECT
			e.entitlement_key AS key,
			e.active AND (
				e.source_purchase_id IS NOT NULL
				OR (
					e.source_subscription_id IS NOT NULL
					AND e.expires_at IS NOT NULL
					AND e.expires_at > now()
				)
				-- A default-plan grant has no end; a trial's ends when its expiry passes.
				OR (
					e.source_plan_grant_id IS NOT NULL
					AND (e.expires_at IS NULL OR e.expires_at > now())
				)
			) AS active,
			e.expires_at,
			e.metadata
		FROM entitlements e
		WHERE e.project_id = ${projectId}
			AND e.customer_id = ${customerId}
		ORDER BY e.entitlement_key
	`,
	);
	return rows.map((row) => ({
		key: row.key,
		active: row.active,
		expiresAt: toIsoStringOrNull(row.expires_at),
		// A row whose period passed before a recompute, or one deactivated before inactive rows
		// recorded their source's status, still carries a running status.
		metadata: row.active ? row.metadata : inactiveEntitlementMetadata(row.metadata),
	}));
}

/** Advances the customer's projection sequence; a higher value carries fresher state. */
export async function nextProjectionSequence(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<{ sequence: number; billingAccountId: string }> {
	const row = await executeOne<{
		projection_sequence: string | number | bigint;
		billing_account_id: string;
	}>(
		executor,
		drizzleSql`
		UPDATE customers
		SET projection_sequence = projection_sequence + 1, updated_at = now()
		WHERE project_id = ${projectId} AND id = ${customerId}
		RETURNING projection_sequence, billing_account_id
	`,
	);
	if (row === null) {
		throw new Error(`projection sequence customer ${customerId} was not found`);
	}
	return { sequence: Number(row.projection_sequence), billingAccountId: row.billing_account_id };
}

export function usageProjectionKey(customerId: string): string {
	return `usage:${customerId}`;
}

/**
 * Coalesces usage-driven projections: one job per customer, without a stored payload, delivered
 * after the project's debounce with the state current at delivery. A pending job keeps its earlier
 * due time (or its backoff when retrying); a processing job is flagged for one follow-up delivery.
 */
export async function enqueueUsageProjection(
	executor: QueryExecutor,
	input: { projectId: string; customerId: string },
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
		INSERT INTO projection_sync_jobs (
			project_id, customer_id, idempotency_key, reason, payload, status, next_attempt_at
		)
		VALUES (
			${input.projectId},
			${input.customerId},
			${usageProjectionKey(input.customerId)},
			'usage_changed',
			NULL,
			'pending',
			now() + make_interval(secs => COALESCE(
				(SELECT projection_usage_debounce_ms FROM metering_settings WHERE project_id = ${input.projectId}),
				1000
			) / 1000.0)
		)
		ON CONFLICT (project_id, idempotency_key) DO UPDATE SET
			status = CASE
				WHEN projection_sync_jobs.status = 'processing' THEN 'processing'
				ELSE 'pending'
			END,
			reprojection_requested = projection_sync_jobs.status = 'processing',
			attempts = CASE
				WHEN projection_sync_jobs.status = 'pending' THEN projection_sync_jobs.attempts
				ELSE 0
			END,
			last_error = CASE
				WHEN projection_sync_jobs.status = 'pending' THEN projection_sync_jobs.last_error
				ELSE NULL
			END,
			next_attempt_at = CASE
				WHEN projection_sync_jobs.status = 'processing' THEN projection_sync_jobs.next_attempt_at
				WHEN projection_sync_jobs.status = 'pending' AND projection_sync_jobs.attempts > 0
					THEN projection_sync_jobs.next_attempt_at
				WHEN projection_sync_jobs.status = 'pending'
					THEN LEAST(projection_sync_jobs.next_attempt_at, EXCLUDED.next_attempt_at)
				ELSE EXCLUDED.next_attempt_at
			END,
			locked_at = CASE
				WHEN projection_sync_jobs.status = 'processing' THEN projection_sync_jobs.locked_at
				ELSE NULL
			END,
			locked_by = CASE
				WHEN projection_sync_jobs.status = 'processing' THEN projection_sync_jobs.locked_by
				ELSE NULL
			END,
			updated_at = now()
		RETURNING id
	`,
	);
}

export async function recomputeCustomerEntitlements(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<EntitlementSnapshot> {
	const customer = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		SELECT c.id
		FROM customers c
		WHERE c.project_id = ${projectId}
			AND c.billing_account_id = ${billingAccountId}
		FOR NO KEY UPDATE
	`,
	);
	if (customer === null) {
		return { billingAccountId, generatedAt: new Date().toISOString(), entitlements: [] };
	}
	// Every place a base plan starts or ends recomputes here, so the default plan follows it:
	// an account that loses its last base plan falls back to it without a caller action.
	await reconcileDefaultPlanGrant(executor, projectId, customer.id);

	await executeRows(
		executor,
		drizzleSql`
		WITH active_sources AS (
			SELECT
				s.project_id,
				s.customer_id,
				p.entitlement_key,
				s.expires_at,
				s.id AS source_subscription_id,
				NULL::uuid AS source_purchase_id,
				NULL::uuid AS source_plan_grant_id,
				jsonb_build_object(
					'source', 'subscription',
					'status', s.status,
					'provider', s.provider,
					'channel', s.channel,
					'productId', s.product_id,
					'storeProductId', s.store_product_id
				) || CASE
					-- Trial bounds are provider facts kept after the trial ends, so a receiver compares
					-- trialEndsAt with its own clock instead of relying on a stored trialing flag.
					WHEN s.trial_end_at IS NULL THEN '{}'::jsonb
					ELSE jsonb_build_object(
						'trialStartsAt', to_char(s.trial_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
						'trialEndsAt', to_char(s.trial_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
					)
				END AS metadata,
				1 AS source_priority,
				COALESCE(s.expires_at, s.starts_at) AS source_sort_at,
				s.id AS source_sort_id
			FROM subscriptions s
			JOIN products p ON p.id = s.product_id AND p.project_id = s.project_id
			WHERE s.customer_id = ${customer.id}
				AND s.project_id = ${projectId}
				AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND s.expires_at IS NOT NULL
				AND s.expires_at > now()

			UNION ALL

			SELECT
				pu.project_id,
				pu.customer_id,
				p.entitlement_key,
				NULL::timestamptz AS expires_at,
				NULL::uuid AS source_subscription_id,
				pu.id AS source_purchase_id,
				NULL::uuid AS source_plan_grant_id,
				jsonb_build_object(
					'source', 'purchase',
					'status', pu.status,
					'provider', pu.provider,
					'channel', pu.channel,
					'purchaseKind', pu.purchase_kind,
					'transactionId', pu.transaction_id,
					'productId', pu.product_id,
					'storeProductId', pu.store_product_id
				) AS metadata,
				2 AS source_priority,
				pu.purchased_at AS source_sort_at,
				pu.id AS source_sort_id
			FROM purchases pu
			JOIN products p ON p.id = pu.product_id AND p.project_id = pu.project_id
			WHERE pu.customer_id = ${customer.id}
				AND pu.project_id = ${projectId}
				AND pu.status = 'completed'
				AND pu.purchase_kind = 'non_consumable'
				AND pu.invalidated_at IS NULL

			UNION ALL

			SELECT
				g.project_id,
				g.customer_id,
				grant_key.entitlement_key,
				g.ends_at AS expires_at,
				NULL::uuid AS source_subscription_id,
				NULL::uuid AS source_purchase_id,
				g.id AS source_plan_grant_id,
				jsonb_build_object(
					'source', 'plan_grant',
					'origin', g.origin,
					'status', g.status,
					'planKey', pl.key,
					'planGrantId', g.id
				) || CASE
					WHEN g.origin = 'trial' THEN jsonb_build_object(
						'trialStartsAt', to_char(g.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
						'trialEndsAt', to_char(g.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
					)
					ELSE '{}'::jsonb
				END AS metadata,
				3 AS source_priority,
				g.ends_at AS source_sort_at,
				g.id AS source_sort_id
			FROM plan_grants g
			CROSS JOIN LATERAL unnest(g.entitlement_keys) AS grant_key(entitlement_key)
			JOIN plans pl ON pl.project_id = g.project_id AND pl.id = g.plan_id
			WHERE g.customer_id = ${customer.id}
				AND g.project_id = ${projectId}
				AND g.status = 'active'
				AND (g.ends_at IS NULL OR g.ends_at > now())
		),
		ranked_sources AS (
			SELECT
				active_sources.*,
				ROW_NUMBER() OVER (
					PARTITION BY entitlement_key
					-- A paid source always wins over a plan grant, however long the grant runs.
					ORDER BY
						source_plan_grant_id IS NOT NULL ASC,
						expires_at IS NULL DESC,
						expires_at DESC NULLS LAST,
						source_priority ASC,
						source_sort_at DESC,
						source_sort_id ASC
				) AS entitlement_rank
			FROM active_sources
		),
		active_entitlements AS (
			SELECT
				project_id,
				customer_id,
				entitlement_key,
				expires_at,
				source_subscription_id,
				source_purchase_id,
				source_plan_grant_id,
				metadata
			FROM ranked_sources
			WHERE entitlement_rank = 1
		),
		upserted AS (
			INSERT INTO entitlements (
				project_id,
				customer_id,
				entitlement_key,
				active,
				expires_at,
				source_subscription_id,
				source_purchase_id,
				source_plan_grant_id,
				metadata,
				computed_at
			)
			SELECT
				project_id,
				customer_id,
				entitlement_key,
				true,
				expires_at,
				source_subscription_id,
				source_purchase_id,
				source_plan_grant_id,
				metadata,
				now()
			FROM active_entitlements
			ON CONFLICT (project_id, customer_id, entitlement_key) DO UPDATE SET
				active = true,
				expires_at = EXCLUDED.expires_at,
				source_subscription_id = EXCLUDED.source_subscription_id,
				source_purchase_id = EXCLUDED.source_purchase_id,
				source_plan_grant_id = EXCLUDED.source_plan_grant_id,
				metadata = EXCLUDED.metadata,
				computed_at = now(),
				updated_at = now()
			RETURNING entitlement_key
		)
		UPDATE entitlements e
		SET
			active = false,
			-- The entitlement keeps its last source's metadata with that source's current status:
			-- why it ended (expired, refunded, ended, superseded, …), or inactive while the source
			-- still runs without it. SET reads the source ids before this statement clears them.
			metadata = e.metadata || COALESCE((
				SELECT jsonb_build_object(
					'status',
					CASE
						WHEN last_source.status IN (SELECT jsonb_array_elements_text(${jsonb(runningSourceStatuses)}))
							THEN 'inactive'
						ELSE last_source.status
					END
				)
				FROM (
					SELECT COALESCE(
						(
							SELECT s.status FROM subscriptions s
							WHERE s.project_id = e.project_id AND s.id = e.source_subscription_id
						),
						(
							SELECT pu.status FROM purchases pu
							WHERE pu.project_id = e.project_id AND pu.id = e.source_purchase_id
						),
						(
							SELECT g.status FROM plan_grants g
							WHERE g.project_id = e.project_id AND g.id = e.source_plan_grant_id
						),
						e.metadata->>'status'
					) AS status
				) last_source
				WHERE last_source.status IS NOT NULL
			), '{}'::jsonb),
			source_subscription_id = NULL,
			source_purchase_id = NULL,
			source_plan_grant_id = NULL,
			computed_at = now(),
			updated_at = now()
		WHERE e.customer_id = ${customer.id}
			AND e.project_id = ${projectId}
			AND NOT EXISTS (
				SELECT 1
				FROM active_entitlements ae
				WHERE ae.entitlement_key = e.entitlement_key
			)
	`,
	);

	return await getEntitlementSnapshot(executor, projectId, billingAccountId);
}

export async function enqueueProjectionSyncJob(
	executor: QueryExecutor,
	input: {
		customerId: string;
		idempotencyKey: string;
		reason: ProjectionSyncReason;
		payload: Omit<ProjectionPayload, "generatedAt" | "balances">;
	},
): Promise<boolean> {
	requireNonBlank(input.idempotencyKey, "p_idempotency_key");
	const customer = await executeOne<{ project_id: string }>(
		executor,
		drizzleSql`
		SELECT c.project_id
		FROM customers c
		WHERE c.id = ${input.customerId}
	`,
	);
	if (customer === null) {
		throw new Error(`projection sync job customer ${input.customerId} was not found`);
	}
	const [{ sequence }, balances] = await Promise.all([
		nextProjectionSequence(executor, customer.project_id, input.customerId),
		readProjectionBalances(executor, customer.project_id, input.customerId),
	]);
	const payload: ProjectionJobPayload = {
		...input.payload,
		generatedAt: input.payload.entitlements.generatedAt,
		balances,
		sequence,
	};
	return await insertProjectionSyncJob(executor, {
		projectId: customer.project_id,
		customerId: input.customerId,
		idempotencyKey: input.idempotencyKey,
		reason: input.reason,
		payload,
	});
}

/** Inserts or refreshes the per-key projection job for a payload the caller already built. */
export async function insertProjectionSyncJob(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		idempotencyKey: string;
		reason: ProjectionSyncReason;
		payload: ProjectionJobPayload;
	},
): Promise<boolean> {
	const { payload } = input;
	const customer = { project_id: input.projectId };
	const row = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		INSERT INTO projection_sync_jobs (
			project_id,
			customer_id,
			idempotency_key,
			reason,
			payload,
			status,
			next_attempt_at
		)
		VALUES (
			${customer.project_id},
			${input.customerId},
			${input.idempotencyKey},
			${input.reason},
			${jsonb(payload)},
			'pending',
			now()
		)
		ON CONFLICT (project_id, idempotency_key) DO UPDATE SET
			payload = EXCLUDED.payload,
			status = CASE
				WHEN projection_sync_jobs.status = 'processing' THEN 'processing'
				ELSE 'pending'
			END,
			attempts = CASE
				WHEN projection_sync_jobs.status = 'processing' THEN 0
				ELSE projection_sync_jobs.attempts
			END,
			last_error = NULL,
			reprojection_requested = CASE
				WHEN projection_sync_jobs.status = 'processing' THEN true ELSE false
			END,
			next_attempt_at = now(),
			updated_at = now()
		WHERE projection_sync_jobs.status IN ('pending', 'failed', 'processing')
			AND projection_sync_jobs.customer_id = EXCLUDED.customer_id
			AND projection_sync_jobs.reason = EXCLUDED.reason
		RETURNING id
	`,
	);
	if (row !== null) {
		return true;
	}

	const existing = await executeOne<{ customer_id: string; reason: ProjectionSyncReason }>(
		executor,
		drizzleSql`
			SELECT jobs.customer_id, jobs.reason
			FROM projection_sync_jobs jobs
			WHERE jobs.project_id = ${customer.project_id}
				AND jobs.idempotency_key = ${input.idempotencyKey}
		`,
	);
	if (existing?.customer_id !== input.customerId || existing.reason !== input.reason) {
		throw new Error(`projection idempotency key identity mismatch for key ${input.idempotencyKey}`);
	}
	return false;
}

export async function readProjectionBalances(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<ProjectionPayload["balances"]> {
	const [allocationRows, pending] = await Promise.all([
		executeRows<ProjectionBalanceRow>(
			executor,
			drizzleSql`
			SELECT
				f.key AS feature_key,
				f.unit,
				f.credit_scale,
				SUM(
					CASE WHEN state.closed THEN 0
						ELSE a.quantity - a.reversed_quantity - a.consumed_quantity - a.held_quantity END
				)::text AS available,
				SUM(a.held_quantity) AS held,
				MIN(CASE WHEN state.closed THEN NULL ELSE COALESCE(a.expires_at, a.period_end_at) END)
					AS period_ends_at
			FROM balance_allocations a
			JOIN features f
				ON f.project_id = a.project_id
				AND f.id = a.feature_id
			CROSS JOIN LATERAL (
				SELECT (
					a.reversed_at IS NOT NULL
					OR (a.expires_at IS NOT NULL AND a.expires_at <= now())
					OR ${defaultPlanAllowanceEndingSql(projectId, drizzleSql`a`)}
				) AS closed
			) state
			WHERE a.project_id = ${projectId}
				AND a.customer_id = ${customerId}
				AND a.entity_id IS NULL
				-- A closed allocation counts only for the open holds it still backs.
				AND (NOT state.closed OR a.held_quantity > 0)
			GROUP BY f.id, f.key, f.unit, f.credit_scale
		`,
		),
		readPendingAllowances(executor, projectId, customerId, null),
	]);
	const allocations = withPendingProjectionBalances(allocationRows, pending);
	const limits = await readProjectionMeterLimits(executor, projectId, customerId);
	// Window bounds come from the same rule metering writes with, so only the current window counts.
	const windows =
		limits.length === 0
			? []
			: await executeRows<ProjectionBalanceRow>(
					executor,
					drizzleSql`
						SELECT
							f.key AS feature_key,
							f.unit,
							f.credit_scale,
							GREATEST(
								limits.limit_quantity - COALESCE(windows.usage, 0) - COALESCE(holds.held, 0),
								0::numeric
							) AS available,
							COALESCE(holds.held, 0) AS held,
							limits.window_end_at AS period_ends_at
						FROM (
							VALUES ${drizzleSql.join(
								limits.map(
									(limit) => drizzleSql`(
										${limit.featureId}::bigint,
										${limit.quantity}::numeric,
										${limit.start.toISOString()}::timestamptz,
										${limit.end.toISOString()}::timestamptz
									)`,
								),
								drizzleSql`, `,
							)}
						) AS limits(feature_id, limit_quantity, window_start_at, window_end_at)
						JOIN features f ON f.project_id = ${projectId} AND f.id = limits.feature_id
						LEFT JOIN usage_windows windows
							ON windows.project_id = ${projectId}
							AND windows.customer_id = ${customerId}
							AND windows.feature_id = limits.feature_id
							AND windows.entity_id IS NULL
							AND windows.filter_key IS NULL
							AND windows.window_start_at = limits.window_start_at
							AND windows.window_end_at = limits.window_end_at
						LEFT JOIN LATERAL (
							SELECT sum(reservations.held_quantity) AS held
							FROM reservations
							WHERE reservations.project_id = ${projectId}
								AND reservations.usage_window_id = windows.id
								AND reservations.status = 'active'
								AND reservations.expires_at > now()
						) holds ON true
					`,
				);

	return [...allocations, ...windows]
		.sort((left, right) =>
			left.feature_key < right.feature_key ? -1 : left.feature_key > right.feature_key ? 1 : 0,
		)
		.map((row) => ({
			featureKey: row.feature_key,
			unit: row.unit,
			available: databaseDecimal(row.available, "projection available", row.credit_scale),
			held: databaseDecimal(row.held, "projection held", row.credit_scale),
			periodEndsAt: toIsoStringOrNull(row.period_ends_at),
		}));
}

/**
 * The account's meter limits as metering resolves them (see `combineMeterLimits`): for each feature
 * a plan limits, the quantity its sources add up to and the window their anchor counts in.
 */
async function readProjectionMeterLimits(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<Array<{ featureId: string; quantity: string; start: Date; end: Date }>> {
	const features = await executeRows<{ id: string | number | bigint; credit_scale: number }>(
		executor,
		drizzleSql`
			SELECT DISTINCT f.id, f.credit_scale
			FROM plan_items pi
			JOIN features f ON f.project_id = pi.project_id AND f.id = pi.feature_id
			WHERE pi.project_id = ${projectId} AND pi.item_kind = 'meter_limit'
			ORDER BY f.id
		`,
	);
	const sources = await Promise.all(
		features.map((feature) => queryMeterLimitRows(executor, projectId, customerId, feature)),
	);
	const now = new Date();
	return features.flatMap((feature, index) => {
		const combined = combineMeterLimits(sources[index] ?? [], feature.credit_scale);
		if (combined === null) return [];
		return [
			{
				featureId: String(feature.id),
				quantity: combined.quantity,
				...meterLimitBounds(combined.anchor, now),
			},
		];
	});
}

interface ProjectionBalanceRow {
	feature_key: string;
	unit: string;
	credit_scale: number;
	available: unknown;
	held: unknown;
	period_ends_at: unknown;
}

/**
 * Adds the allowances no write has created yet to the per-feature allocation totals, which the SQL
 * leaves unclamped so the sum is exact, then clamps each feature's available quantity at zero.
 */
function withPendingProjectionBalances(
	rows: readonly ProjectionBalanceRow[],
	pending: readonly PendingAllowance[],
): ProjectionBalanceRow[] {
	const byFeature = new Map<
		string,
		{ unit: string; scale: number; available: bigint; held: bigint; endsAt: Date | null }
	>();
	for (const row of rows) {
		const scale = Number(row.credit_scale);
		byFeature.set(row.feature_key, {
			unit: row.unit,
			scale,
			available: signedDecimalToUnits(String(row.available), scale),
			held: decimalToUnits(databaseDecimal(row.held, "projection held", scale), scale),
			endsAt: row.period_ends_at === null ? null : new Date(row.period_ends_at as string | Date),
		});
	}
	for (const allowance of pending) {
		const units = (value: string) => decimalToUnits(value, allowance.scale);
		const current = byFeature.get(allowance.featureKey) ?? {
			unit: allowance.unit,
			scale: allowance.scale,
			available: 0n,
			held: 0n,
			endsAt: null,
		};
		current.available +=
			units(allowance.quantity) -
			units(allowance.reversed) -
			units(allowance.consumed) -
			units(allowance.held);
		current.held += units(allowance.held);
		if (
			allowance.expiresAt !== null &&
			(current.endsAt === null || allowance.expiresAt < current.endsAt)
		) {
			current.endsAt = allowance.expiresAt;
		}
		byFeature.set(allowance.featureKey, current);
	}
	return [...byFeature].map(([featureKey, total]) => ({
		feature_key: featureKey,
		unit: total.unit,
		credit_scale: total.scale,
		available: unitsToDecimal(total.available > 0n ? total.available : 0n, total.scale),
		held: unitsToDecimal(total.held, total.scale),
		period_ends_at: total.endsAt,
	}));
}
