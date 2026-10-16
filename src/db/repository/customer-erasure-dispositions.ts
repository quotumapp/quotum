import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import type { QueryExecutor } from "./types";

/**
 * What an erasure does with each table that carries a billing account's identity.
 *
 * - `delete`: the rows are removed; they hold the identity or a credential and no accounting fact.
 * - `rewrite`: the row stays; its id, actor or free text is replaced and its payload blanked.
 * - `scrub`: the row stays as a fact; provider payloads, errors and caller text are removed.
 * - `retain`: quantities and ledger facts the retention rules keep, with the reason.
 *
 * `tests/db/customer-erasure-dispositions.test.ts` fails when a table with `customer_id` or
 * `billing_account_id` has no entry here, so a new table cannot ship without a decision.
 */
export type CustomerErasureDisposition =
	| { kind: "delete" }
	| { kind: "rewrite" }
	| { kind: "scrub" }
	| { kind: "retain"; reason: string };

const ledger = "ledger fact kept for the retention period";
const quantity = "quantities and keys only; holds no direct identifier";

export const customerErasureDispositions = {
	customers: { kind: "rewrite" },
	customer_erasures: { kind: "retain", reason: "the receipt of the erasure itself" },
	provider_customers: { kind: "delete" },
	provider_customer_unlinks: { kind: "delete" },
	provider_operations: { kind: "rewrite" },
	paddle_checkout_reservations: { kind: "delete" },
	commercial_action_previews: { kind: "rewrite" },
	refund_requests: { kind: "rewrite" },
	promotion_codes: { kind: "rewrite" },
	payment_setup_sessions: { kind: "delete" },
	checkout_requests: { kind: "delete" },
	client_idempotency_claims: { kind: "delete" },
	projection_sync_jobs: { kind: "delete" },
	entitlements: { kind: "delete" },
	entities: { kind: "rewrite" },
	plan_grants: { kind: "rewrite" },
	promotion_redemptions: { kind: "rewrite" },
	operator_grants: { kind: "rewrite" },
	administrative_debits: { kind: "rewrite" },
	store_events: { kind: "scrub" },
	purchases: { kind: "scrub" },
	subscriptions: { kind: "scrub" },
	billing_invoices: { kind: "scrub" },
	subscription_changes: { kind: "scrub" },
	usage_events: { kind: "scrub" },
	usage_alerts: { kind: "scrub" },
	auto_topup_policies: { kind: "scrub" },
	balance_allocations: { kind: "rewrite" },
	credit_grants: { kind: "retain", reason: ledger },
	credit_reversals: { kind: "retain", reason: ledger },
	usage_windows: { kind: "retain", reason: quantity },
	usage_event_rollups: { kind: "retain", reason: quantity },
	reservations: { kind: "retain", reason: quantity },
	usage_invoice_periods: { kind: "retain", reason: ledger },
	usage_alert_events: { kind: "retain", reason: quantity },
	auto_topup_jobs: { kind: "retain", reason: ledger },
	control_policies: { kind: "retain", reason: quantity },
	control_windows: { kind: "retain", reason: quantity },
	license_pools: { kind: "retain", reason: quantity },
	enterprise_contracts: {
		kind: "retain",
		reason: "commercial terms the merchant authored; RESTRICT keeps the account row",
	},
	plan_versions: { kind: "retain", reason: "customer-specific catalog history" },
	promotion_apple_signature_attempts: {
		kind: "retain",
		reason: "signature attempts the redemption ledger references; RESTRICT keeps the account row",
	},
} as const satisfies Record<string, CustomerErasureDisposition>;

export type CustomerErasureTable = keyof typeof customerErasureDispositions;

/** Everything a step needs to find one account's rows after its id was rewritten. */
export interface CustomerErasureContext {
	projectId: string;
	customerId: string;
	erasureId: string;
	/** The original billing account id; held only until the operation completes. */
	subjectId: string;
	/** When the account row was first written, which bounds the unlinked store-event scan. */
	customerCreatedAt: Date;
}

/** One bounded unit of work. It returns how many rows it changed; zero means the step is done. */
export interface CustomerErasureBatch {
	table: string;
	run(executor: QueryExecutor, context: CustomerErasureContext, limit: number): Promise<number>;
}

export const customerErasureSteps = [
	"delete_rows",
	"rewrite_ids",
	"scrub_payloads",
	"scrub_usage_events",
	"scan_unlinked_store_events",
	"verify",
] as const;

export type CustomerErasureStep = (typeof customerErasureSteps)[number];

const erasedMarker = (context: CustomerErasureContext) => `erased:${context.erasureId}`;

/** Deletes one batch by physical address, so the batch size is exact and no key is needed. */
function deleteBatch(table: string, where: (context: CustomerErasureContext) => DrizzleSQL) {
	return {
		table,
		async run(executor, context, limit) {
			const rows = await executor.execute(drizzleSql`
				WITH batch AS (
					SELECT ctid FROM ${drizzleSql.raw(table)}
					WHERE project_id = ${context.projectId} AND ${where(context)}
					LIMIT ${limit}
				)
				DELETE FROM ${drizzleSql.raw(table)} AS target USING batch
				WHERE target.ctid = batch.ctid
				RETURNING 1
			`);
			return rows.length;
		},
	} satisfies CustomerErasureBatch;
}

/**
 * Updates one batch of the rows that still need it. `needs` makes the step idempotent without a
 * cursor: a row already rewritten no longer matches, so a retry resumes where it stopped.
 */
function updateBatch(
	table: string,
	assignments: (context: CustomerErasureContext) => DrizzleSQL,
	where: (context: CustomerErasureContext) => DrizzleSQL,
) {
	return {
		table,
		async run(executor, context, limit) {
			const rows = await executor.execute(drizzleSql`
				WITH batch AS (
					SELECT ctid FROM ${drizzleSql.raw(table)}
					WHERE project_id = ${context.projectId} AND ${where(context)}
					LIMIT ${limit}
				)
				UPDATE ${drizzleSql.raw(table)} AS target SET ${assignments(context)}
				FROM batch
				WHERE target.ctid = batch.ctid
				RETURNING 1
			`);
			return rows.length;
		},
	} satisfies CustomerErasureBatch;
}

const ofCustomer = (context: CustomerErasureContext) =>
	drizzleSql`customer_id = ${context.customerId}`;
const ofAccount = (context: CustomerErasureContext) =>
	drizzleSql`billing_account_id = ${context.subjectId}`;

const digestOfId = drizzleSql`encode(sha256(convert_to(target.id::text, 'UTF8')), 'hex')`;

export const deleteBatches: CustomerErasureBatch[] = [
	deleteBatch("projection_sync_jobs", ofCustomer),
	deleteBatch("checkout_requests", ofCustomer),
	deleteBatch("payment_setup_sessions", ofCustomer),
	deleteBatch("client_idempotency_claims", ofCustomer),
	deleteBatch("entitlements", ofCustomer),
	deleteBatch("provider_customers", ofCustomer),
	deleteBatch("provider_customer_unlinks", ofCustomer),
	deleteBatch(
		"paddle_checkout_reservations",
		(context) => drizzleSql`${ofAccount(context)} AND closed_at IS NOT NULL`,
	),
];

export const rewriteBatches: CustomerErasureBatch[] = [
	updateBatch(
		"entities",
		(context) => drizzleSql`
			external_id = ${erasedMarker(context)} || ':' || target.id::text,
			metadata = '{}'::jsonb, updated_at = now()`,
		(context) =>
			drizzleSql`${ofCustomer(context)} AND (external_id NOT LIKE 'erased:%' OR metadata <> '{}'::jsonb)`,
	),
	updateBatch(
		"provider_operations",
		(context) => drizzleSql`
			billing_account_id = ${erasedMarker(context)},
			resource_key = 'erased:' || target.id::text,
			request_hash = ${digestOfId},
			request = '{}'::jsonb,
			result = CASE WHEN target.result IS NULL THEN NULL ELSE '{}'::jsonb END,
			updated_at = now()`,
		ofAccount,
	),
	updateBatch(
		"commercial_action_previews",
		(context) => drizzleSql`
			billing_account_id = ${erasedMarker(context)},
			intent = '{}'::jsonb, preview = '{}'::jsonb, provider_context = '{}'::jsonb,
			intent_hash = ${digestOfId}, state_fingerprint = ${digestOfId},
			execution_result = CASE WHEN target.execution_result IS NULL THEN NULL ELSE '{}'::jsonb END,
			updated_at = now()`,
		ofAccount,
	),
	// The amount, currency, provider payment and refund ids stay as the financial fact; the account
	// id, the caller's reason and its idempotency keys, which can carry a user id, do not.
	updateBatch(
		"refund_requests",
		(context) => drizzleSql`
			billing_account_id = ${erasedMarker(context)}, reason = 'erased',
			execution_idempotency_key = 'erased:' || target.id::text,
			provider_idempotency_key = 'erased:' || target.id::text,
			updated_at = now()`,
		ofAccount,
	),
	updateBatch(
		"promotion_codes",
		(context) => drizzleSql`
			billing_account_id = ${erasedMarker(context)}, active = false, updated_at = now()`,
		ofAccount,
	),
	updateBatch(
		"plan_grants",
		(context) => drizzleSql`
			actor = CASE WHEN target.actor = ${`billing-account:${context.subjectId}`}
				THEN ${erasedMarker(context)} ELSE target.actor END,
			metadata = '{}'::jsonb, updated_at = now()`,
		(context) =>
			drizzleSql`${ofCustomer(context)} AND (actor = ${`billing-account:${context.subjectId}`} OR metadata <> '{}'::jsonb)`,
	),
	updateBatch(
		"promotion_redemptions",
		(context) => drizzleSql`
			actor = CASE WHEN target.actor = ${`billing-account:${context.subjectId}`}
				THEN ${erasedMarker(context)} ELSE target.actor END,
			reason = NULL, updated_at = now()`,
		(context) =>
			drizzleSql`${ofCustomer(context)} AND (actor = ${`billing-account:${context.subjectId}`} OR reason IS NOT NULL)`,
	),
	// The source key is the caller's idempotency key for a grant, so it can carry a user id. The
	// quantities and what was consumed from them stay; the key is only an address.
	updateBatch(
		"balance_allocations",
		() => drizzleSql`source_key = 'erased:' || target.id::text, updated_at = now()`,
		(context) => drizzleSql`${ofCustomer(context)} AND source_key NOT LIKE 'erased:%'`,
	),
	updateBatch(
		"operator_grants",
		() => drizzleSql`reason = 'erased', updated_at = now()`,
		(context) => drizzleSql`${ofCustomer(context)} AND reason <> 'erased'`,
	),
	updateBatch(
		"administrative_debits",
		() => drizzleSql`reason = 'erased'`,
		(context) => drizzleSql`${ofCustomer(context)} AND reason <> 'erased'`,
	),
];

const erasedPayload = drizzleSql`'{"erased":true}'::jsonb`;

export const scrubBatches: CustomerErasureBatch[] = [
	// Terminal, so the replay worker never claims it again; the event id stays the dedupe key.
	updateBatch(
		"store_events",
		() => drizzleSql`
			raw_payload = ${erasedPayload}, processing_error = NULL,
			processing_status = CASE WHEN target.processing_status IN ('pending', 'processing', 'failed')
				THEN 'skipped' ELSE target.processing_status END,
			next_attempt_at = 'infinity'::timestamptz,
			locked_at = NULL, locked_by = NULL, updated_at = now()`,
		(context) =>
			drizzleSql`${ofCustomer(context)} AND (
				raw_payload <> ${erasedPayload} OR processing_error IS NOT NULL
				OR processing_status IN ('pending', 'processing', 'failed')
				OR next_attempt_at <> 'infinity'::timestamptz
			)`,
	),
	updateBatch(
		"purchases",
		() => drizzleSql`raw_payload = '{}'::jsonb, updated_at = now()`,
		(context) => drizzleSql`${ofCustomer(context)} AND raw_payload <> '{}'::jsonb`,
	),
	updateBatch(
		"subscriptions",
		() => drizzleSql`
			raw_state = '{}'::jsonb, provider_reconciliation_error = NULL,
			provider_reconciliation_next_attempt_at = '9999-12-31'::timestamptz, updated_at = now()`,
		(context) =>
			drizzleSql`${ofCustomer(context)} AND (
				raw_state <> '{}'::jsonb OR provider_reconciliation_error IS NOT NULL
				OR provider_reconciliation_next_attempt_at < '9999-12-31'::timestamptz
			)`,
	),
	updateBatch(
		"billing_invoices",
		() => drizzleSql`raw_payload = '{}'::jsonb, updated_at = now()`,
		(context) => drizzleSql`${ofCustomer(context)} AND raw_payload <> '{}'::jsonb`,
	),
	updateBatch(
		"subscription_changes",
		() => drizzleSql`last_error = NULL, updated_at = now()`,
		(context) => drizzleSql`${ofCustomer(context)} AND last_error IS NOT NULL`,
	),
	updateBatch(
		"usage_alerts",
		() => drizzleSql`active = false, metadata = '{}'::jsonb, updated_at = now()`,
		(context) => drizzleSql`${ofCustomer(context)} AND (active OR metadata <> '{}'::jsonb)`,
	),
	updateBatch(
		"auto_topup_policies",
		() => drizzleSql`active = false, updated_at = now()`,
		(context) => drizzleSql`${ofCustomer(context)} AND active`,
	),
	{
		table: "catalog_audit_log",
		async run(executor, context, limit) {
			const rows = await executor.execute(drizzleSql`
				WITH batch AS (
					SELECT ctid FROM catalog_audit_log
					WHERE project_id = ${context.projectId}
						AND details->>'billingAccountId' = ${context.subjectId}
					LIMIT ${limit}
				)
				UPDATE catalog_audit_log AS target
				SET details = '{"erased":true}'::jsonb
				FROM batch WHERE target.ctid = batch.ctid
				RETURNING 1
			`);
			return rows.length;
		},
	},
];

/**
 * `usage_events` is partitioned, so a batch is addressed by its primary key, not by `ctid`. The
 * receipt names the account and entity; metadata keeps only the keys the window code reads, plus
 * the operator that wrote a correction. A caller's free-form values and a correction's reason go.
 */
export const usageEventBatch: CustomerErasureBatch = {
	table: "usage_events",
	async run(executor, context, limit) {
		const keep = drizzleSql`ARRAY['usageWindowId', 'usageWindowStartAt', 'usageWindowEndAt', 'actor']`;
		const rows = await executor.execute(drizzleSql`
			WITH batch AS (
				SELECT recorded_at, id FROM usage_events
				WHERE project_id = ${context.projectId} AND customer_id = ${context.customerId}
					AND (
						receipt IS NOT NULL
						OR EXISTS (
							SELECT 1 FROM jsonb_object_keys(metadata) AS key WHERE key <> ALL (${keep})
						)
					)
				LIMIT ${limit}
			)
			UPDATE usage_events AS target
			SET receipt = NULL,
				metadata = COALESCE((
					SELECT jsonb_object_agg(entry.key, entry.value)
					FROM jsonb_each(target.metadata) AS entry
					WHERE entry.key = ANY (${keep})
				), '{}'::jsonb)
			FROM batch
			WHERE target.recorded_at = batch.recorded_at AND target.id = batch.id
			RETURNING 1
		`);
		return rows.length;
	},
};

/**
 * Store events that never resolved to the account (`customer_id` is null) are found only by their
 * payload. Bounded by the account's first write: nothing older can name it.
 */
export const unlinkedStoreEventBatch: CustomerErasureBatch = {
	table: "store_events",
	async run(executor, context, limit) {
		const rows = await executor.execute(drizzleSql`
			WITH batch AS (
				SELECT ctid FROM store_events
				WHERE project_id = ${context.projectId} AND customer_id IS NULL
					AND created_at >= ${context.customerCreatedAt}
					AND raw_payload <> ${erasedPayload}
					AND position(${context.subjectId} in raw_payload::text) > 0
				LIMIT ${limit}
			)
			UPDATE store_events AS target
			SET raw_payload = ${erasedPayload}, processing_error = NULL,
				processing_status = CASE WHEN target.processing_status IN ('pending', 'processing', 'failed')
					THEN 'skipped' ELSE target.processing_status END,
				next_attempt_at = 'infinity'::timestamptz,
				locked_at = NULL, locked_by = NULL, updated_at = now()
			FROM batch WHERE target.ctid = batch.ctid
			RETURNING 1
		`);
		return rows.length;
	},
};

/**
 * Rows that still carry the original id after every step. A non-zero count fails the operation
 * rather than completing it, because completion drops the id the scrub needs to find them.
 */
export async function residualRows(
	executor: QueryExecutor,
	context: CustomerErasureContext,
): Promise<Record<string, number>> {
	const rows = await executor.execute<{ table_name: string; count: number | string }>(drizzleSql`
		SELECT table_name, count FROM (
			SELECT 'customers' AS table_name, count(*) AS count FROM customers
				WHERE project_id = ${context.projectId} AND billing_account_id = ${context.subjectId}
			UNION ALL SELECT 'provider_operations', count(*) FROM provider_operations
				WHERE project_id = ${context.projectId} AND billing_account_id = ${context.subjectId}
			UNION ALL SELECT 'paddle_checkout_reservations', count(*) FROM paddle_checkout_reservations
				WHERE project_id = ${context.projectId} AND billing_account_id = ${context.subjectId}
			UNION ALL SELECT 'commercial_action_previews', count(*) FROM commercial_action_previews
				WHERE project_id = ${context.projectId} AND billing_account_id = ${context.subjectId}
			UNION ALL SELECT 'refund_requests', count(*) FROM refund_requests
				WHERE project_id = ${context.projectId} AND billing_account_id = ${context.subjectId}
			UNION ALL SELECT 'promotion_codes', count(*) FROM promotion_codes
				WHERE project_id = ${context.projectId} AND billing_account_id = ${context.subjectId}
			UNION ALL SELECT 'catalog_audit_log', count(*) FROM catalog_audit_log
				WHERE project_id = ${context.projectId}
					AND details->>'billingAccountId' = ${context.subjectId}
			UNION ALL SELECT 'store_events', count(*) FROM store_events
				WHERE project_id = ${context.projectId}
					AND (customer_id = ${context.customerId} OR customer_id IS NULL)
					AND created_at >= ${context.customerCreatedAt}
					AND position(${context.subjectId} in raw_payload::text) > 0
			UNION ALL SELECT 'purchases', count(*) FROM purchases
				WHERE project_id = ${context.projectId} AND customer_id = ${context.customerId}
					AND position(${context.subjectId} in raw_payload::text) > 0
			UNION ALL SELECT 'subscriptions', count(*) FROM subscriptions
				WHERE project_id = ${context.projectId} AND customer_id = ${context.customerId}
					AND position(${context.subjectId} in raw_state::text) > 0
			UNION ALL SELECT 'billing_invoices', count(*) FROM billing_invoices
				WHERE project_id = ${context.projectId} AND customer_id = ${context.customerId}
					AND position(${context.subjectId} in raw_payload::text) > 0
		) residual
		WHERE count > 0
	`);
	return Object.fromEntries(rows.map((row) => [row.table_name, Number(row.count)]));
}
