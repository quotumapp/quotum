import { sql as drizzleSql } from "drizzle-orm";
import { RepositoryModule } from "./base";
import { enqueueProjectionSyncJob, recomputeCustomerEntitlements } from "./entitlements";
import { parseProviderSubscriptionReconciliationRow } from "./parsers";
import { assertUpdated, executeRows } from "./query";
import type {
	ExpiredSubscriptionReconciliationResult,
	ProviderSubscriptionReconciliationRow,
} from "./types";
import { formatUtcTimestamp, requireNonBlank, requirePositiveLimit } from "./validation";

export class SubscriptionReconciliationBillingRepository extends RepositoryModule {
	async reconcileExpiredSubscriptions(
		limit: number,
	): Promise<ExpiredSubscriptionReconciliationResult> {
		const cappedLimit = requirePositiveLimit(limit);
		return await this.transaction(async (tx) => {
			const rows = await executeRows<{
				id: string;
				project_id: string;
				customer_id: string;
				billing_account_id: string;
				expires_at: unknown;
			}>(
				tx,
				drizzleSql`
				WITH candidates AS MATERIALIZED (
					SELECT s.id, s.customer_id
					FROM subscriptions s
					WHERE s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
						AND s.expires_at IS NOT NULL
						AND s.expires_at <= now()
					ORDER BY s.expires_at ASC, s.created_at ASC
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
				due_subscriptions AS MATERIALIZED (
					SELECT s.id, s.customer_id
					FROM subscriptions s
					JOIN candidates candidate ON candidate.id = s.id
					JOIN locked_customers locked_customer ON locked_customer.id = s.customer_id
					WHERE s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
						AND s.expires_at IS NOT NULL
						AND s.expires_at <= now()
					ORDER BY s.expires_at ASC, s.created_at ASC
					FOR UPDATE OF s SKIP LOCKED
				)
				UPDATE subscriptions s
				SET
					status = 'expired',
					auto_renew = false,
					updated_at = now()
				FROM due_subscriptions due
				JOIN customers c ON c.id = due.customer_id
				WHERE s.id = due.id
				RETURNING s.id, s.project_id, s.customer_id, c.billing_account_id, s.expires_at
			`,
			);

			const customerIds = new Set<string>();
			let projectionJobs = 0;

			for (const row of rows) {
				customerIds.add(row.customer_id);
				const snapshot = await recomputeCustomerEntitlements(
					tx,
					row.project_id,
					row.billing_account_id,
				);
				const enqueued = await enqueueProjectionSyncJob(tx, {
					customerId: row.customer_id,
					idempotencyKey: `expiry_reconciliation:${row.id}:${formatUtcTimestamp(row.expires_at)}`,
					reason: "expiry_reconciliation",
					payload: {
						billingAccountId: row.billing_account_id,
						reason: "expiry_reconciliation",
						entitlements: snapshot,
					},
				});
				if (enqueued) {
					projectionJobs += 1;
				}
			}

			return {
				expiredSubscriptions: rows.length,
				affectedCustomers: customerIds.size,
				projectionJobs,
			};
		});
	}

	async claimProviderSubscriptionReconciliations(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<ProviderSubscriptionReconciliationRow[]> {
		requireNonBlank(workerId, "p_worker_id");
		const cappedLimit = requirePositiveLimit(limit);
		const rows = await executeRows(
			this.database,
			drizzleSql`
			WITH due_subscriptions AS (
				SELECT s.id
				FROM subscriptions s
				WHERE s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled', 'expired')
					AND s.provider IN ('apple', 'google', 'stripe')
					AND s.provider_reconciliation_next_attempt_at <= now()
					AND (
						s.provider_reconciled_at IS NULL
						OR s.provider_reconciled_at <= ${staleBefore.toISOString()}::timestamptz
						OR s.expires_at <= now() + INTERVAL '1 hour'
					)
					AND (
						s.provider_reconciliation_locked_at IS NULL
						OR s.provider_reconciliation_locked_at <= now() - INTERVAL '5 minutes'
					)
				ORDER BY s.provider_reconciliation_next_attempt_at ASC, s.created_at ASC
				LIMIT ${cappedLimit}
				FOR UPDATE SKIP LOCKED
			)
			UPDATE subscriptions s
			SET
				provider_reconciliation_locked_at = now(),
				provider_reconciliation_locked_by = ${workerId},
				updated_at = now()
			FROM due_subscriptions due
			WHERE s.id = due.id
			RETURNING
				s.*,
				(SELECT projects.key FROM projects projects WHERE projects.id = s.project_id) AS project_key
		`,
		);
		return rows.map(parseProviderSubscriptionReconciliationRow);
	}

	async markProviderSubscriptionReconciliationSucceeded(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void> {
		await assertUpdated(
			this.database,
			drizzleSql`
			UPDATE subscriptions s
			SET
				provider_reconciliation_attempts = CASE
					WHEN s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled', 'expired') THEN 0
					ELSE s.provider_reconciliation_attempts
				END,
				provider_reconciliation_next_attempt_at = CASE
					WHEN s.status = 'expired' THEN now() + INTERVAL '24 hours'
					WHEN s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled') THEN now() + INTERVAL '15 minutes'
					ELSE s.provider_reconciliation_next_attempt_at
				END,
				provider_reconciliation_error = CASE
					WHEN s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled', 'expired') THEN NULL
					ELSE s.provider_reconciliation_error
				END,
				provider_reconciliation_locked_at = NULL,
				provider_reconciliation_locked_by = NULL,
				provider_reconciled_at = CASE
					WHEN s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled', 'expired') THEN now()
					ELSE s.provider_reconciled_at
				END,
				updated_at = now()
			WHERE s.id = ${subscriptionId}
				AND s.project_id = ${projectId}
				AND s.provider_reconciliation_locked_by = ${workerId}
			RETURNING s.id
		`,
			`provider subscription reconciliation ${subscriptionId} is not locked by worker ${workerId}`,
		);
	}

	async renewProviderSubscriptionReconciliationLease(
		projectId: string,
		subscriptionId: string,
		workerId: string,
	): Promise<void> {
		await executeRows(
			this.database,
			drizzleSql`
				UPDATE subscriptions s
				SET provider_reconciliation_locked_at = now(), updated_at = now()
				WHERE s.id = ${subscriptionId}
					AND s.project_id = ${projectId}
					AND s.provider_reconciliation_locked_by = ${workerId}
			`,
		);
	}

	async markProviderSubscriptionReconciliationFailed(
		projectId: string,
		subscriptionId: string,
		errorMessage: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		requireNonBlank(errorMessage, "p_error");
		// Bind as ISO: Bun SQL serializes a raw Date via toString (a locale string) that
		// Postgres rejects for ::timestamptz; the record* paths already do the same.
		const nextAttemptAtIso = nextAttemptAt?.toISOString() ?? null;
		await assertUpdated(
			this.database,
			drizzleSql`
			UPDATE subscriptions s
			SET
				provider_reconciliation_attempts = s.provider_reconciliation_attempts + 1,
				provider_reconciliation_error = ${errorMessage},
				provider_reconciliation_next_attempt_at = COALESCE(${nextAttemptAtIso}::timestamptz, 'infinity'::timestamptz),
				provider_reconciliation_locked_at = NULL,
				provider_reconciliation_locked_by = NULL,
				updated_at = now()
			WHERE s.id = ${subscriptionId}
				AND s.project_id = ${projectId}
				AND s.provider_reconciliation_locked_by = ${workerId}
			RETURNING s.id
		`,
			`provider subscription reconciliation ${subscriptionId} is not locked by worker ${workerId}`,
		);
	}
}
