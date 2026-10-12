import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { decodeAdminCursor, encodeAdminCursor } from "../../admin/query";
import type { AdjustmentList, AdjustmentListOptions } from "../../billing/balance-adjustments";
import { NotFoundBillingError, PersistenceConflictError } from "../../billing/errors";
import {
	normalizeProviderCustomerUnlinkInput,
	type ProviderCustomerUnlinkBlocker,
	type ProviderCustomerUnlinkInput,
	type ProviderCustomerUnlinkMutationResult,
	type ProviderCustomerUnlinkRecord,
	type ProviderCustomerUnlinkServiceLike,
	providerCustomerUnlinkError,
	providerCustomerUnlinkRequestHash,
} from "../../billing/provider-customer-unlinks";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { lockCustomer } from "./identities";
import { executeOne, executeRows } from "./query";
import type { CustomerIdentityRow, QueryExecutor } from "./types";
import { formatUtcTimestamp, requirePositiveLimit } from "./validation";

interface LinkRow {
	id: string;
	external_customer_id: string;
}

interface UnlinkRow {
	id: string;
	billing_account_id: string;
	provider: "stripe";
	external_customer_id: string;
	provider_account_id: string | null;
	linked_at: Date | string;
	actor: string;
	reason: string;
	created_at: Date | string;
	cursor_created_at: string;
}

export class ProviderCustomerUnlinkRepository
	extends RepositoryModule
	implements ProviderCustomerUnlinkServiceLike
{
	/**
	 * Removes a billing account's Stripe customer link and keeps a receipt of it. Nothing is
	 * reassigned: the next provider event or checkout for the account writes a link through the
	 * usual checked path. The customer lock makes it wait for, or run before, an event being
	 * recorded for the account.
	 */
	async unlinkProviderCustomer(
		project: ProjectInstanceContext,
		rawInput: ProviderCustomerUnlinkInput,
	): Promise<ProviderCustomerUnlinkMutationResult> {
		const input = normalizeProviderCustomerUnlinkInput(rawInput);
		const requestHash = providerCustomerUnlinkRequestHash(input);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await lockCustomer(tx, projectId, input.billingAccountId);
			if (customer === null) {
				throw new NotFoundBillingError(
					"Billing account was not found",
					"BILLING_ACCOUNT_NOT_FOUND",
				);
			}
			const replay = await executeOne<{ id: string; request_hash: string }>(
				tx,
				drizzleSql`
					SELECT id, request_hash FROM provider_customer_unlinks
					WHERE project_id = ${projectId}
						AND customer_id = ${customer.id}
						AND idempotency_key = ${input.idempotencyKey}
				`,
			);
			if (replay !== null) {
				if (replay.request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different unlink",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return { duplicate: true, unlink: await requireUnlink(tx, projectId, replay.id) };
			}
			const link = await executeOne<LinkRow>(
				tx,
				drizzleSql`
					SELECT id, external_customer_id
					FROM provider_customers
					WHERE project_id = ${projectId}
						AND customer_id = ${customer.id}
						AND provider = ${input.provider}
					FOR UPDATE
				`,
			);
			if (link === null) throw providerCustomerUnlinkError("PROVIDER_CUSTOMER_LINK_NOT_FOUND");
			if (link.external_customer_id !== input.externalCustomerId) {
				throw providerCustomerUnlinkError("PROVIDER_CUSTOMER_LINK_MISMATCH", {
					externalCustomerId: link.external_customer_id,
				});
			}
			const blockers = await unlinkBlockers(tx, projectId, customer);
			if (blockers.length > 0) {
				throw providerCustomerUnlinkError("PROVIDER_CUSTOMER_LINK_IN_USE", { blockers });
			}
			// Copied from the link in SQL, so the receipt keeps the link's timestamp exactly.
			const receipt = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO provider_customer_unlinks (
						project_id, customer_id, provider, provider_account_id, external_customer_id,
						linked_at, actor, reason, idempotency_key, request_hash
					)
					SELECT link.project_id, link.customer_id, link.provider, link.provider_account_id,
						link.external_customer_id, link.created_at,
						${input.actor}, ${input.reason}, ${input.idempotencyKey}, ${requestHash}
					FROM provider_customers link
					WHERE link.project_id = ${projectId} AND link.id = ${link.id}
					RETURNING id
				`,
			);
			if (receipt === null) throw new Error("Provider customer unlink could not be recorded");
			const removed = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					DELETE FROM provider_customers
					WHERE project_id = ${projectId} AND id = ${link.id}
					RETURNING id
				`,
			);
			if (removed === null) throw new Error("Locked provider customer link could not be removed");
			return { duplicate: false, unlink: await requireUnlink(tx, projectId, receipt.id) };
		});
	}

	async listProviderCustomerUnlinks(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: AdjustmentListOptions,
	): Promise<AdjustmentList<ProviderCustomerUnlinkRecord>> {
		const limit = requirePositiveLimit(options.limit);
		const rows = await executeRows<UnlinkRow>(
			this.database,
			drizzleSql`
				${unlinkSelect(
					project.projectInstanceId,
					drizzleSql`c.billing_account_id = ${billingAccountId} AND ${keyset(options.cursor)}`,
				)}
				ORDER BY u.created_at DESC, u.id DESC
				LIMIT ${limit + 1}
			`,
		);
		const last = rows[limit - 1];
		return {
			items: rows.slice(0, limit).map(toUnlinkRecord),
			nextCursor:
				rows.length > limit && last !== undefined
					? encodeAdminCursor({ createdAt: last.cursor_created_at, id: last.id })
					: null,
		};
	}
}

/**
 * What still needs the account's Stripe customer, one row per kind that has any. A subscription
 * Stripe has ended (`cancelled`, `expired`) no longer charges or reports through the customer, and
 * a usage invoice that ended `failed` is not retried on its own, so neither holds the link.
 */
async function unlinkBlockers(
	executor: QueryExecutor,
	projectId: string,
	customer: CustomerIdentityRow,
): Promise<ProviderCustomerUnlinkBlocker[]> {
	const rows = await executeRows<ProviderCustomerUnlinkBlocker>(
		executor,
		drizzleSql`
			SELECT blocker.kind, blocker.count::int AS count
			FROM (
				SELECT 1 AS position, 'subscription' AS kind, count(*) AS count
				FROM subscriptions s
				WHERE s.project_id = ${projectId} AND s.customer_id = ${customer.id}
					AND s.provider = 'stripe'
					AND s.status IN ('active', 'grace_period', 'billing_retry')
				UNION ALL
				SELECT 2, 'provider_operation', count(*)
				FROM provider_operations o
				WHERE o.project_id = ${projectId}
					AND o.billing_account_id = ${customer.billing_account_id}
					AND o.provider = 'stripe'
					AND o.status IN ('prepared', 'in_flight', 'reconciling', 'requires_review')
				UNION ALL
				SELECT 3, 'payment_setup', count(*)
				FROM payment_setup_sessions p
				WHERE p.project_id = ${projectId} AND p.customer_id = ${customer.id}
					AND p.provider = 'stripe'
					AND p.status IN ('creating', 'awaiting_customer', 'applying_default', 'needs_attention')
				UNION ALL
				SELECT 4, 'auto_topup_job', count(*)
				FROM auto_topup_jobs j
				WHERE j.project_id = ${projectId} AND j.customer_id = ${customer.id}
					AND j.provider = 'stripe' AND j.status IN ('pending', 'processing')
				UNION ALL
				SELECT 5, 'usage_invoice', (
					SELECT count(*)
					FROM usage_invoice_periods period
					WHERE period.project_id = ${projectId} AND period.customer_id = ${customer.id}
						AND period.provider = 'stripe' AND period.status IN ('pending', 'processing')
				) + (
					SELECT count(*)
					FROM usage_invoice_adjustments adjustment
					JOIN usage_invoice_periods period
						ON period.project_id = adjustment.project_id
						AND period.id = adjustment.closed_period_id
					WHERE adjustment.project_id = ${projectId} AND period.customer_id = ${customer.id}
						AND period.provider = 'stripe' AND adjustment.status IN ('pending', 'processing')
				)
			) blocker
			WHERE blocker.count > 0
			ORDER BY blocker.position
		`,
	);
	return rows.map((row) => ({ kind: row.kind, count: Number(row.count) }));
}

function keyset(cursor: string | null): DrizzleSQL {
	if (cursor === null) return drizzleSql`true`;
	const position = decodeAdminCursor(cursor);
	return drizzleSql`(u.created_at, u.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

function unlinkSelect(projectId: string, condition: DrizzleSQL): DrizzleSQL {
	return drizzleSql`
		SELECT
			u.id,
			c.billing_account_id,
			u.provider,
			u.external_customer_id,
			u.provider_account_id,
			u.linked_at,
			u.actor,
			u.reason,
			u.created_at,
			to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
		FROM provider_customer_unlinks u
		JOIN customers c ON c.project_id = u.project_id AND c.id = u.customer_id
		WHERE u.project_id = ${projectId} AND ${condition}
	`;
}

async function requireUnlink(
	executor: QueryExecutor,
	projectId: string,
	unlinkId: string,
): Promise<ProviderCustomerUnlinkRecord> {
	const row = await executeOne<UnlinkRow>(
		executor,
		drizzleSql`${unlinkSelect(projectId, drizzleSql`u.id = ${unlinkId}::uuid`)} LIMIT 1`,
	);
	if (row === null) throw new Error(`provider customer unlink ${unlinkId} was not found`);
	return toUnlinkRecord(row);
}

function toUnlinkRecord(row: UnlinkRow): ProviderCustomerUnlinkRecord {
	return {
		id: row.id,
		billingAccountId: row.billing_account_id,
		provider: row.provider,
		externalCustomerId: row.external_customer_id,
		providerAccountId: row.provider_account_id,
		linkedAt: formatUtcTimestamp(row.linked_at),
		actor: row.actor,
		reason: row.reason,
		createdAt: formatUtcTimestamp(row.created_at),
	};
}
