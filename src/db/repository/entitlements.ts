import { sql as drizzleSql } from "drizzle-orm";
import { databaseDecimal } from "../../billing/decimal";
import type {
	EntitlementSnapshot,
	ProjectionJobPayload,
	ProjectionPayload,
	ProjectionSyncReason,
} from "../../billing/types";
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
	if (customer === null) {
		return { billingAccountId, generatedAt: new Date().toISOString(), entitlements: [] };
	}

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
			) AS active,
			e.expires_at,
			e.metadata
		FROM entitlements e
		WHERE e.project_id = ${projectId}
			AND e.customer_id = ${customer.id}
		ORDER BY e.entitlement_key
	`,
	);

	return {
		billingAccountId,
		generatedAt: new Date().toISOString(),
		entitlements: rows.map((row) => ({
			key: row.key,
			active: row.active,
			expiresAt: toIsoStringOrNull(row.expires_at),
			metadata: row.metadata,
		})),
	};
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
		FOR UPDATE
	`,
	);
	if (customer === null) {
		return { billingAccountId, generatedAt: new Date().toISOString(), entitlements: [] };
	}

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
				jsonb_build_object(
					'source', 'subscription',
					'status', s.status,
					'provider', s.provider,
					'channel', s.channel,
					'productId', s.product_id,
					'storeProductId', s.store_product_id
				) AS metadata,
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
		),
		ranked_sources AS (
			SELECT
				active_sources.*,
				ROW_NUMBER() OVER (
					PARTITION BY entitlement_key
					ORDER BY
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
				metadata,
				now()
			FROM active_entitlements
			ON CONFLICT (project_id, customer_id, entitlement_key) DO UPDATE SET
				active = true,
				expires_at = EXCLUDED.expires_at,
				source_subscription_id = EXCLUDED.source_subscription_id,
				source_purchase_id = EXCLUDED.source_purchase_id,
				metadata = EXCLUDED.metadata,
				computed_at = now(),
				updated_at = now()
			RETURNING entitlement_key
		)
		UPDATE entitlements e
		SET
			active = false,
			source_subscription_id = NULL,
			source_purchase_id = NULL,
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
	const payload: ProjectionJobPayload = {
		...input.payload,
		generatedAt: input.payload.entitlements.generatedAt,
		balances: await getProjectionBalances(executor, customer.project_id, input.customerId),
	};

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

async function getProjectionBalances(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<ProjectionPayload["balances"]> {
	const rows = await executeRows<{
		feature_key: string;
		unit: string;
		credit_scale: number;
		available: unknown;
		held: unknown;
		period_ends_at: unknown;
	}>(
		executor,
		drizzleSql`
			WITH allocation_balances AS (
				SELECT
					f.key AS feature_key,
					f.unit,
					f.credit_scale,
					GREATEST(
						SUM(
							a.quantity - a.reversed_quantity - a.consumed_quantity - a.held_quantity
						),
						0::numeric
					) AS available,
					SUM(a.held_quantity) AS held,
					MIN(COALESCE(a.expires_at, a.period_end_at)) AS period_ends_at
				FROM balance_allocations a
				JOIN features f
					ON f.project_id = a.project_id
					AND f.id = a.feature_id
				WHERE a.project_id = ${projectId}
					AND a.customer_id = ${customerId}
					AND a.entity_id IS NULL
					AND a.reversed_at IS NULL
					AND (a.expires_at IS NULL OR a.expires_at > now())
				GROUP BY f.id, f.key, f.unit, f.credit_scale
			),
			active_limits AS (
				SELECT DISTINCT ON (pi.feature_id)
					pi.feature_id,
					pi.quantity AS limit_quantity,
					COALESCE(s.current_period_end, s.expires_at) AS period_ends_at
				FROM subscriptions s
				JOIN plan_items pi
					ON pi.project_id = s.project_id AND pi.plan_version_id = s.plan_version_id
				WHERE s.project_id = ${projectId}
					AND s.customer_id = ${customerId}
					AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (s.expires_at IS NULL OR s.expires_at > now())
					AND pi.item_kind = 'meter_limit'
				ORDER BY pi.feature_id, s.created_at, s.id
			),
			window_balances AS (
				SELECT
					f.key AS feature_key,
					f.unit,
					f.credit_scale,
					GREATEST(
						limits.limit_quantity - COALESCE(windows.usage, 0) - COALESCE(holds.held, 0),
						0::numeric
					) AS available,
					COALESCE(holds.held, 0) AS held,
					COALESCE(windows.window_end_at, limits.period_ends_at) AS period_ends_at
				FROM active_limits limits
				JOIN features f ON f.project_id = ${projectId} AND f.id = limits.feature_id
				LEFT JOIN usage_windows windows
					ON windows.project_id = ${projectId}
					AND windows.customer_id = ${customerId}
					AND windows.feature_id = limits.feature_id
					AND windows.entity_id IS NULL
					AND windows.filter_key IS NULL
					AND windows.window_start_at <= now()
					AND windows.window_end_at > now()
				LEFT JOIN LATERAL (
					SELECT sum(reservations.held_quantity) AS held
					FROM reservations
					WHERE reservations.project_id = ${projectId}
						AND reservations.usage_window_id = windows.id
						AND reservations.status = 'active'
						AND reservations.expires_at > now()
				) holds ON true
			)
			SELECT * FROM allocation_balances
			UNION ALL
			SELECT * FROM window_balances
			ORDER BY feature_key
		`,
	);

	return rows.map((row) => ({
		featureKey: row.feature_key,
		unit: row.unit,
		available: databaseDecimal(row.available, "projection available", row.credit_scale),
		held: databaseDecimal(row.held, "projection held", row.credit_scale),
		periodEndsAt: toIsoStringOrNull(row.period_ends_at),
	}));
}
