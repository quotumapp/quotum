import { sql as drizzleSql } from "drizzle-orm";
import {
	type CustomerErasureAcknowledgement,
	type CustomerErasureBasis,
	type CustomerErasureBlocker,
	type CustomerErasureForfeits,
	type CustomerErasureInput,
	type CustomerErasureMutationResult,
	type CustomerErasurePreview,
	type CustomerErasureRecord,
	type CustomerErasureServiceLike,
	type CustomerErasureState,
	customerErasureError,
	customerErasureRequestHash,
	normalizeCustomerErasureInput,
} from "../../billing/customer-erasures";
import { NotFoundBillingError, PersistenceConflictError } from "../../billing/errors";
import type { ProjectInstanceContext } from "../../projects/context";
import { erasureDigest } from "../../shared/erasure-digest";
import { configuredErasureKeyring, configuredErasureTombstoneDays } from "../erasure-keyring";
import { RepositoryModule } from "./base";
import { requireAccountId } from "./billing-accounts";
import {
	type CustomerErasureBatch,
	type CustomerErasureContext,
	type CustomerErasureStep,
	customerErasureSteps,
	deleteBatches,
	residualRows,
	rewriteBatches,
	scrubBatches,
	unlinkedStoreEventBatch,
	usageEventBatch,
} from "./customer-erasure-dispositions";
import { assertBillingAccountNotErased, lockCustomer } from "./identities";
import { executeOne, executeRows } from "./query";
import type { CustomerIdentityRow, QueryExecutor } from "./types";

interface ErasureRow {
	id: string;
	state: CustomerErasureState;
	basis: CustomerErasureBasis;
	reference: string | null;
	actor: string;
	acknowledged: CustomerErasureAcknowledgement[];
	cursor: { step?: CustomerErasureStep };
	counts: Record<string, number>;
	last_error: string | null;
	requested_at: Date | string;
	completed_at: Date | string | null;
	tombstone_expires_at: Date | string;
}

const erasureColumns = drizzleSql`
	id, state, basis, reference, actor, acknowledged, cursor, counts, last_error, requested_at,
	completed_at, tombstone_expires_at`;

/** A claimed operation, with everything a step needs. */
export interface ClaimedCustomerErasure {
	context: CustomerErasureContext;
	state: CustomerErasureState;
	step: CustomerErasureStep;
	counts: Record<string, number>;
	attempts: number;
}

export interface CustomerErasureRunOptions {
	workerId: string;
	/** Rows per statement. */
	batchSize: number;
	/** Wall-clock budget for one claim; the lease outlives it. */
	budgetMs: number;
	leaseSeconds: number;
}

export type CustomerErasureRunOutcome =
	| { kind: "idle" }
	| { kind: "progressed" | "completed" | "failed"; erasureId: string };

export class CustomerErasureRepository
	extends RepositoryModule
	implements CustomerErasureServiceLike
{
	async previewCustomerErasure(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<CustomerErasurePreview> {
		requireKeyring();
		requireAccountId(billingAccountId);
		const projectId = project.projectInstanceId;
		const customer = await lockOrFail(this.database, projectId, billingAccountId, false);
		return await previewOf(this.database, projectId, customer);
	}

	/**
	 * Erases a billing account. One transaction freezes it: the account row becomes an anonymized
	 * stub, a tombstone keeps the id from coming back, and the receipt is written. The worker then
	 * deletes and scrubs the rest in bounded batches, so no request waits on a cascade.
	 */
	async requestCustomerErasure(
		project: ProjectInstanceContext,
		rawInput: CustomerErasureInput,
	): Promise<CustomerErasureMutationResult> {
		const keyring = requireKeyring();
		const input = normalizeCustomerErasureInput(rawInput);
		const requestHash = customerErasureRequestHash(keyring.current, input);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			// Before the account lookup: once frozen, the account no longer answers to its own id.
			const replay = await executeOne<{ id: string; request_hash: string | null; state: string }>(
				tx,
				drizzleSql`
					SELECT id, request_hash, state FROM customer_erasures
					WHERE project_id = ${projectId} AND idempotency_key = ${input.idempotencyKey}
					FOR UPDATE
				`,
			);
			if (replay !== null) {
				if (replay.request_hash !== null && replay.request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different erasure",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				// A replay of a failed erasure queues it again, so the retry needs no extra route.
				if (replay.state === "failed") {
					await tx.execute(drizzleSql`
						UPDATE customer_erasures
						SET state = 'running', cursor = '{}'::jsonb, last_error = NULL, attempts = 0,
							locked_by = NULL, locked_at = NULL, next_attempt_at = now()
						WHERE project_id = ${projectId} AND id = ${replay.id}
					`);
				}
				return { duplicate: true, erasure: await requireErasure(tx, projectId, replay.id) };
			}
			const customer = await lockOrFail(tx, projectId, input.billingAccountId, true);
			const preview = await previewOf(tx, projectId, customer);
			if (preview.blockers.length > 0) {
				throw customerErasureError("CUSTOMER_ERASURE_BLOCKED", { blockers: preview.blockers });
			}
			const missing = preview.requiredAcknowledgements.filter(
				(required) => !input.acknowledge.includes(required),
			);
			if (missing.length > 0) {
				throw customerErasureError("CUSTOMER_ERASURE_ACKNOWLEDGEMENT_REQUIRED", {
					forfeits: preview.forfeits,
					required: preview.requiredAcknowledgements,
				});
			}
			const days = configuredErasureTombstoneDays();
			const created = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO customer_erasures (
						project_id, customer_id, state, basis, reference, actor, idempotency_key,
						request_hash, acknowledged, subject_id, tombstone_expires_at
					)
					VALUES (
						${projectId}, ${customer.id}, 'running', ${input.basis}, ${input.reference},
						${input.actor}, ${input.idempotencyKey}, ${requestHash},
						${textArray(input.acknowledge)}::text[], ${input.billingAccountId},
						now() + make_interval(days => ${days})
					)
					RETURNING id
				`,
			);
			if (created === null) throw new Error("Customer erasure could not be recorded");
			await tx.execute(drizzleSql`
				INSERT INTO customer_erasure_tombstones (project_id, key_id, id_digest, erasure_id, expires_at)
				VALUES (
					${projectId}, ${keyring.current.id},
					${erasureDigest(keyring.current, projectId, input.billingAccountId)},
					${created.id}, now() + make_interval(days => ${days})
				)
			`);
			// The id is rewritten here, so from this commit no path reaches the account by its own id.
			await tx.execute(drizzleSql`
				UPDATE customers
				SET billing_account_id = ${`erased:${created.id}`}, email = NULL, metadata = '{}'::jsonb,
					erased_at = now(), updated_at = now()
				WHERE project_id = ${projectId} AND id = ${customer.id}
			`);
			return { duplicate: false, erasure: await requireErasure(tx, projectId, created.id) };
		});
	}

	async getCustomerErasure(
		project: ProjectInstanceContext,
		erasureId: string,
	): Promise<CustomerErasureRecord> {
		return await requireErasure(this.database, project.projectInstanceId, erasureId);
	}

	/**
	 * Claims the next due operation and works it for a bounded time. The claim is a lease: a worker
	 * that dies leaves a row another worker takes once the lease passes, and every step is
	 * idempotent, so it resumes where the first one stopped.
	 */
	async runNextCustomerErasure(
		options: CustomerErasureRunOptions,
	): Promise<CustomerErasureRunOutcome> {
		const claimed = await this.claim(options);
		if (claimed === null) return { kind: "idle" };
		const erasureId = claimed.context.erasureId;
		try {
			const finished = await this.work(claimed, options);
			return { kind: finished, erasureId };
		} catch (error) {
			await this.release(claimed, options.workerId, failureCode(error));
			return { kind: "progressed", erasureId };
		}
	}

	/** Removes tombstones a day past expiry and drops the request hash of expired receipts. */
	async sweepCustomerErasures(limit: number): Promise<number> {
		const deleted = await executeRows<{ one: number }>(
			this.database,
			drizzleSql`
				WITH expired AS (
					SELECT ctid FROM customer_erasure_tombstones
					WHERE expires_at < now() - interval '1 day' LIMIT ${limit}
				)
				DELETE FROM customer_erasure_tombstones t USING expired
				WHERE t.ctid = expired.ctid RETURNING 1 AS one
			`,
		);
		const cleared = await executeRows<{ one: number }>(
			this.database,
			drizzleSql`
				WITH expired AS (
					SELECT ctid FROM customer_erasures
					WHERE state = 'completed' AND request_hash IS NOT NULL AND tombstone_expires_at < now()
					LIMIT ${limit}
				)
				UPDATE customer_erasures e SET request_hash = NULL FROM expired
				WHERE e.ctid = expired.ctid RETURNING 1 AS one
			`,
		);
		return deleted.length + cleared.length;
	}

	private async claim(options: CustomerErasureRunOptions): Promise<ClaimedCustomerErasure | null> {
		const row = await executeOne<{
			id: string;
			project_id: string;
			customer_id: string;
			subject_id: string | null;
			state: CustomerErasureState;
			cursor: { step?: CustomerErasureStep };
			counts: Record<string, number>;
			attempts: number;
			customer_created_at: Date | string;
		}>(
			this.database,
			drizzleSql`
				UPDATE customer_erasures e
				SET locked_by = ${options.workerId}, locked_at = now(), attempts = e.attempts + 1
				WHERE e.id = (
					SELECT candidate.id FROM customer_erasures candidate
					WHERE candidate.state IN ('requested', 'running', 'verifying')
						AND candidate.next_attempt_at <= now()
						AND (
							candidate.locked_at IS NULL
							OR candidate.locked_at < now() - make_interval(secs => ${options.leaseSeconds})
						)
					ORDER BY candidate.next_attempt_at, candidate.id
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				)
				RETURNING e.id, e.project_id, e.customer_id, e.subject_id, e.state, e.cursor, e.counts,
					e.attempts,
					(SELECT c.created_at FROM customers c
						WHERE c.project_id = e.project_id AND c.id = e.customer_id) AS customer_created_at
			`,
		);
		if (row === null) return null;
		if (row.subject_id === null) {
			// A completed receipt has no subject; a running one that lost it cannot be finished.
			throw new Error(`customer erasure ${row.id} has no subject id`);
		}
		return {
			context: {
				projectId: row.project_id,
				customerId: row.customer_id,
				erasureId: row.id,
				subjectId: row.subject_id,
				customerCreatedAt: new Date(row.customer_created_at),
			},
			state: row.state,
			step: row.cursor.step ?? "delete_rows",
			counts: row.counts,
			attempts: row.attempts,
		};
	}

	private async work(
		claimed: ClaimedCustomerErasure,
		options: CustomerErasureRunOptions,
	): Promise<"progressed" | "completed" | "failed"> {
		const deadline = Date.now() + options.budgetMs;
		let step = claimed.step;
		let counts = { ...claimed.counts };
		for (;;) {
			if (step === "verify") return await this.verify(claimed, options.workerId, counts);
			const batches = batchesOf(step);
			let drained = true;
			for (const batch of batches) {
				for (;;) {
					const changed = await this.runBatch(claimed, options, step, batch, counts);
					counts = changed.counts;
					if (changed.rows < options.batchSize) break;
					if (Date.now() >= deadline) {
						drained = false;
						break;
					}
				}
				if (!drained) break;
			}
			if (!drained) {
				await this.release(claimed, options.workerId, null, step, counts, 0);
				return "progressed";
			}
			step = nextStep(step);
			await this.saveCursor(claimed, options.workerId, step, counts);
			if (Date.now() >= deadline && step !== "verify") {
				await this.release(claimed, options.workerId, null, step, counts, 0);
				return "progressed";
			}
		}
	}

	private async runBatch(
		claimed: ClaimedCustomerErasure,
		options: CustomerErasureRunOptions,
		step: CustomerErasureStep,
		batch: CustomerErasureBatch,
		counts: Record<string, number>,
	): Promise<{ rows: number; counts: Record<string, number> }> {
		return await this.transaction(async (tx) => {
			const rows = await batch.run(tx, claimed.context, options.batchSize);
			const next = { ...counts, [batch.table]: (counts[batch.table] ?? 0) + rows };
			// The lease check shares the batch's transaction: a worker that lost the lease rolls back.
			const held = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					UPDATE customer_erasures
					SET counts = ${JSON.stringify(next)}::text::jsonb,
						cursor = ${JSON.stringify({ step })}::text::jsonb
					WHERE project_id = ${claimed.context.projectId} AND id = ${claimed.context.erasureId}
						AND locked_by = ${options.workerId}
					RETURNING id
				`,
			);
			if (held === null) throw new Error("customer erasure lease was lost");
			return { rows, counts: next };
		});
	}

	private async saveCursor(
		claimed: ClaimedCustomerErasure,
		workerId: string,
		step: CustomerErasureStep,
		counts: Record<string, number>,
	): Promise<void> {
		const state = step === "verify" ? "verifying" : "running";
		await this.database.execute(drizzleSql`
			UPDATE customer_erasures
			SET state = ${state}, cursor = ${JSON.stringify({ step })}::text::jsonb,
				counts = ${JSON.stringify(counts)}::text::jsonb
			WHERE project_id = ${claimed.context.projectId} AND id = ${claimed.context.erasureId}
				AND locked_by = ${workerId}
		`);
	}

	/** Releases the lease. A failure backs off; a pause for budget runs again at once. */
	private async release(
		claimed: ClaimedCustomerErasure,
		workerId: string,
		errorCode: string | null,
		step?: CustomerErasureStep,
		counts?: Record<string, number>,
		delaySeconds = Math.min(900, 2 ** Math.min(claimed.attempts, 10) * 5),
	): Promise<void> {
		await this.database.execute(drizzleSql`
			UPDATE customer_erasures
			SET locked_by = NULL, locked_at = NULL, last_error = ${errorCode},
				attempts = CASE WHEN ${errorCode}::text IS NULL THEN 0 ELSE attempts END,
				next_attempt_at = now() + make_interval(secs => ${delaySeconds}),
				counts = COALESCE(${counts === undefined ? null : JSON.stringify(counts)}::text::jsonb, counts),
				cursor = COALESCE(${step === undefined ? null : JSON.stringify({ step })}::text::jsonb, cursor)
			WHERE project_id = ${claimed.context.projectId} AND id = ${claimed.context.erasureId}
				AND locked_by = ${workerId}
		`);
	}

	private async verify(
		claimed: ClaimedCustomerErasure,
		workerId: string,
		counts: Record<string, number>,
	): Promise<"completed" | "failed"> {
		const residual = await residualRows(this.database, claimed.context);
		const outcome = await this.transaction(async (tx) => {
			if (Object.keys(residual).length > 0) {
				const withResidual = {
					...counts,
					...Object.fromEntries(
						Object.entries(residual).map(([table, count]) => [`residual.${table}`, count]),
					),
				};
				await tx.execute(drizzleSql`
					UPDATE customer_erasures
					SET state = 'failed', last_error = 'RESIDUAL_ROWS',
						counts = ${JSON.stringify(withResidual)}::text::jsonb,
						locked_by = NULL, locked_at = NULL
					WHERE project_id = ${claimed.context.projectId} AND id = ${claimed.context.erasureId}
						AND locked_by = ${workerId}
				`);
				return "failed" as const;
			}
			// Completion drops the original id: the only copy outside the rewritten account.
			const done = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					UPDATE customer_erasures
					SET state = 'completed', subject_id = NULL, completed_at = now(), cursor = '{}'::jsonb,
						counts = ${JSON.stringify(counts)}::text::jsonb, last_error = NULL,
						locked_by = NULL, locked_at = NULL
					WHERE project_id = ${claimed.context.projectId} AND id = ${claimed.context.erasureId}
						AND locked_by = ${workerId}
					RETURNING id
				`,
			);
			if (done === null) throw new Error("customer erasure lease was lost");
			return "completed" as const;
		});
		return outcome;
	}
}

function requireKeyring() {
	const keyring = configuredErasureKeyring();
	if (keyring === null) throw customerErasureError("CUSTOMER_ERASURE_NOT_CONFIGURED");
	return keyring;
}

function textArray(values: string[]) {
	return drizzleSql`ARRAY[${drizzleSql.join(
		values.map((value) => drizzleSql`${value}`),
		drizzleSql`, `,
	)}]`;
}

async function lockOrFail(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
	forUpdate: boolean,
): Promise<CustomerIdentityRow> {
	const customer = forUpdate
		? await lockCustomer(executor, projectId, billingAccountId)
		: await executeOne<CustomerIdentityRow>(
				executor,
				drizzleSql`
					SELECT id, billing_account_id FROM customers
					WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
				`,
			);
	if (customer !== null) return customer;
	// An id already erased answers as erased, not as an account that never existed.
	await assertBillingAccountNotErased(executor, projectId, billingAccountId);
	throw new NotFoundBillingError("Billing account was not found", "BILLING_ACCOUNT_NOT_FOUND");
}

function batchesOf(step: CustomerErasureStep): CustomerErasureBatch[] {
	switch (step) {
		case "delete_rows":
			return deleteBatches;
		case "rewrite_ids":
			return rewriteBatches;
		case "scrub_payloads":
			return scrubBatches;
		case "scrub_usage_events":
			return [usageEventBatch];
		case "scan_unlinked_store_events":
			return [unlinkedStoreEventBatch];
		case "verify":
			return [];
	}
}

function nextStep(step: CustomerErasureStep): CustomerErasureStep {
	const index = customerErasureSteps.indexOf(step);
	return customerErasureSteps[Math.min(index + 1, customerErasureSteps.length - 1)] ?? "verify";
}

/** A stable code for a failure; never the message, which can carry row values. */
function failureCode(error: unknown): string {
	if (error instanceof Error && error.message === "customer erasure lease was lost") {
		return "LEASE_LOST";
	}
	const code = (error as { errno?: unknown } | null)?.errno;
	return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
		? `SQLSTATE_${code}`
		: "STEP_FAILED";
}

async function previewOf(
	executor: QueryExecutor,
	projectId: string,
	customer: CustomerIdentityRow,
): Promise<CustomerErasurePreview> {
	const blockers = await erasureBlockers(executor, projectId, customer);
	const forfeits = await erasureForfeits(executor, projectId, customer);
	const requiredAcknowledgements: CustomerErasureAcknowledgement[] = [];
	if (forfeits.paidBalanceFeatures > 0) requiredAcknowledgements.push("forfeit_paid_balances");
	if (forfeits.lifetimePurchases > 0) requiredAcknowledgements.push("forfeit_lifetime_purchases");
	const rows = await executeRows<{ table_name: string; count: number | string }>(
		executor,
		drizzleSql`
			SELECT table_name, count FROM (
				SELECT 'provider_customers' AS table_name, count(*) AS count FROM provider_customers
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				UNION ALL SELECT 'checkout_requests', count(*) FROM checkout_requests
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				UNION ALL SELECT 'payment_setup_sessions', count(*) FROM payment_setup_sessions
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				UNION ALL SELECT 'projection_sync_jobs', count(*) FROM projection_sync_jobs
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				UNION ALL SELECT 'entities', count(*) FROM entities
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				UNION ALL SELECT 'store_events', count(*) FROM store_events
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				UNION ALL SELECT 'purchases', count(*) FROM purchases
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				UNION ALL SELECT 'subscriptions', count(*) FROM subscriptions
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
			) counted WHERE count > 0
		`,
	);
	return {
		blockers,
		forfeits,
		requiredAcknowledgements,
		rows: Object.fromEntries(rows.map((row) => [row.table_name, Number(row.count)])),
	};
}

/**
 * Work that still needs the account's identity, or would write to the account after it is gone.
 * Every provider counts: a subscription a store owns cannot be ended from here, so it blocks until
 * it ends. The subscription set is the one that funds a base plan.
 */
async function erasureBlockers(
	executor: QueryExecutor,
	projectId: string,
	customer: CustomerIdentityRow,
): Promise<CustomerErasureBlocker[]> {
	const rows = await executeRows<CustomerErasureBlocker>(
		executor,
		drizzleSql`
			SELECT blocker.kind, blocker.count::int AS count
			FROM (
				SELECT 1 AS position, 'subscription' AS kind, count(*) AS count
				FROM subscriptions s
				WHERE s.project_id = ${projectId} AND s.customer_id = ${customer.id}
					AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (s.expires_at IS NULL OR s.expires_at > now())
				UNION ALL
				SELECT 2, 'provider_operation', count(*)
				FROM provider_operations o
				WHERE o.project_id = ${projectId} AND o.billing_account_id = ${customer.billing_account_id}
					AND o.status IN ('prepared', 'in_flight', 'reconciling', 'requires_review')
				UNION ALL
				SELECT 3, 'payment_setup', count(*)
				FROM payment_setup_sessions p
				WHERE p.project_id = ${projectId} AND p.customer_id = ${customer.id}
					AND p.status IN ('creating', 'awaiting_customer', 'applying_default', 'needs_attention')
				UNION ALL
				SELECT 4, 'checkout', count(*)
				FROM checkout_requests c
				WHERE c.project_id = ${projectId} AND c.customer_id = ${customer.id}
					AND c.status = 'creating'
				UNION ALL
				SELECT 5, 'commercial_action', count(*)
				FROM commercial_action_previews a
				WHERE a.project_id = ${projectId} AND a.billing_account_id = ${customer.billing_account_id}
					AND a.status = 'executing'
				UNION ALL
				SELECT 6, 'subscription_change', count(*)
				FROM subscription_changes sc
				WHERE sc.project_id = ${projectId} AND sc.customer_id = ${customer.id}
					AND sc.status IN ('pending', 'processing')
				UNION ALL
				SELECT 7, 'catalog_migration', count(*)
				FROM catalog_migration_jobs m
				JOIN subscriptions ms ON ms.project_id = m.project_id AND ms.id = m.subscription_id
				WHERE m.project_id = ${projectId} AND ms.customer_id = ${customer.id}
					AND m.status IN ('pending', 'processing', 'waiting_provider')
				UNION ALL
				SELECT 8, 'paddle_checkout', count(*)
				FROM paddle_checkout_reservations r
				WHERE r.project_id = ${projectId} AND r.billing_account_id = ${customer.billing_account_id}
					AND r.closed_at IS NULL
				UNION ALL
				SELECT 9, 'promotion_redemption', count(*)
				FROM promotion_redemptions pr
				WHERE pr.project_id = ${projectId} AND pr.customer_id = ${customer.id}
					AND pr.status = 'reserved'
				UNION ALL
				SELECT 10, 'usage_reservation', count(*)
				FROM reservations res
				WHERE res.project_id = ${projectId} AND res.customer_id = ${customer.id}
					AND res.status = 'active'
				UNION ALL
				SELECT 11, 'auto_topup_job', count(*)
				FROM auto_topup_jobs j
				WHERE j.project_id = ${projectId} AND j.customer_id = ${customer.id}
					AND j.status IN ('pending', 'processing')
				UNION ALL
				SELECT 12, 'usage_invoice', (
					SELECT count(*) FROM usage_invoice_periods period
					WHERE period.project_id = ${projectId} AND period.customer_id = ${customer.id}
						AND period.status IN ('pending', 'processing')
				) + (
					SELECT count(*) FROM usage_invoice_adjustments adjustment
					JOIN usage_invoice_periods period
						ON period.project_id = adjustment.project_id
						AND period.id = adjustment.closed_period_id
					WHERE adjustment.project_id = ${projectId} AND period.customer_id = ${customer.id}
						AND adjustment.status IN ('pending', 'processing')
				)
				UNION ALL
				SELECT 13, 'projection_delivery', count(*)
				FROM projection_sync_jobs pj
				WHERE pj.project_id = ${projectId} AND pj.customer_id = ${customer.id}
					AND pj.status = 'processing'
			) blocker
			WHERE blocker.count > 0
			ORDER BY blocker.position
		`,
	);
	return rows.map((row) => ({ kind: row.kind, count: Number(row.count) }));
}

async function erasureForfeits(
	executor: QueryExecutor,
	projectId: string,
	customer: CustomerIdentityRow,
): Promise<CustomerErasureForfeits> {
	const row = await executeOne<{ paid: number | string; lifetime: number | string }>(
		executor,
		drizzleSql`
			SELECT
				(
					SELECT count(DISTINCT a.feature_id) FROM balance_allocations a
					WHERE a.project_id = ${projectId} AND a.customer_id = ${customer.id}
						AND a.source_kind IN ('purchase', 'credit_grant', 'topup')
						AND a.reversed_at IS NULL
						AND (a.expires_at IS NULL OR a.expires_at > now())
						AND a.quantity - a.consumed_quantity - a.held_quantity - a.reversed_quantity > 0
				) AS paid,
				(
					SELECT count(*) FROM purchases p
					WHERE p.project_id = ${projectId} AND p.customer_id = ${customer.id}
						AND p.purchase_kind = 'non_consumable' AND p.status = 'completed'
						AND p.invalidated_at IS NULL
				) AS lifetime
		`,
	);
	return {
		paidBalanceFeatures: Number(row?.paid ?? 0),
		lifetimePurchases: Number(row?.lifetime ?? 0),
	};
}

async function requireErasure(
	executor: QueryExecutor,
	projectId: string,
	erasureId: string,
): Promise<CustomerErasureRecord> {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(erasureId)) {
		throw customerErasureError("CUSTOMER_ERASURE_NOT_FOUND");
	}
	const row = await executeOne<ErasureRow>(
		executor,
		drizzleSql`
			SELECT ${erasureColumns} FROM customer_erasures
			WHERE project_id = ${projectId} AND id = ${erasureId}::uuid
		`,
	);
	if (row === null) throw customerErasureError("CUSTOMER_ERASURE_NOT_FOUND");
	return toRecord(row);
}

function toRecord(row: ErasureRow): CustomerErasureRecord {
	const terminal = row.state === "completed" || row.state === "failed";
	return {
		id: row.id,
		state: row.state,
		basis: row.basis,
		reference: row.reference,
		actor: row.actor,
		acknowledged: row.acknowledged,
		step: terminal ? null : (row.cursor.step ?? "delete_rows"),
		counts: row.counts,
		lastError: row.last_error,
		requestedAt: new Date(row.requested_at).toISOString(),
		completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
		tombstoneExpiresAt: new Date(row.tombstone_expires_at).toISOString(),
	};
}
