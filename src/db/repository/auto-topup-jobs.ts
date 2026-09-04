import { sql as drizzleSql } from "drizzle-orm";
import type {
	AutoTopupChargeSucceeded,
	AutoTopupFailureResult,
	AutoTopupJob,
} from "../../billing/auto-topup";
import { RepositoryModule } from "./base";
import { materializeTopupAllocation } from "./catalog-allocations";
import { enqueueProjectionSyncJob, recomputeCustomerEntitlements } from "./entitlements";
import { upsertPurchase } from "./mutations";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

type AutoTopupFailureKind = "retryable" | "action_required" | "safety_limit_exceeded";

interface ClaimedJobRow {
	id: string;
	project_id: string;
	project_key: string;
	policy_id: string | number | bigint;
	customer_id: string;
	billing_account_id: string;
	external_customer_id: string | null;
	store_product_id: string;
	external_price_id: string | null;
	amount_minor: string | number | bigint | null;
	currency: string | null;
	attempts: number;
	budget_reserved_at: Date | string | null;
	budget_interval_started_at: Date | string | null;
	policy_active: boolean;
	limit_interval_seconds: number;
	max_purchases_per_interval: number;
	max_spend_minor: string | number | bigint | null;
	max_consecutive_failures: number;
	state_status: "ready" | "cooldown" | "suspended";
	interval_started_at: Date | string;
	purchases_in_interval: number;
	spend_minor_in_interval: string | number | bigint;
	consecutive_failures: number;
}

interface LockedJobRow extends ClaimedJobRow {
	product_id: string;
	trigger_key: string;
	status: "pending" | "processing" | "succeeded" | "failed" | "provider_action_required";
	locked_by: string | null;
	external_invoice_id: string | null;
	external_payment_id: string | null;
	charged_amount_minor: string | number | bigint | null;
	cooldown_until: Date | string | null;
}

export class AutoTopupJobRepository extends RepositoryModule {
	async claimAutoTopupJobs(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<AutoTopupJob[]> {
		if (workerId.trim() === "") throw new Error("Auto top-up worker id is required");
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Auto top-up claim limit must be between 1 and 100");
		}
		return await this.transaction(async (tx) => {
			const candidates = await executeRows<{ id: string }>(
				tx,
				drizzleSql`
				SELECT id
				FROM auto_topup_jobs
				WHERE (status = 'pending' AND next_attempt_at <= now())
					OR (status = 'processing' AND locked_at < ${staleBefore.toISOString()})
				ORDER BY next_attempt_at, created_at, id
				LIMIT ${limit}
				FOR UPDATE SKIP LOCKED
			`,
			);
			const jobs: AutoTopupJob[] = [];
			for (const candidate of candidates) {
				const row = await lockClaimedJob(tx, candidate.id);
				if (row === null) continue;
				const prepared = await prepareClaimedJob(tx, row, workerId);
				if (prepared !== null) jobs.push(prepared);
			}
			return jobs;
		});
	}

	async markAutoTopupSucceeded(
		projectId: string,
		jobId: string,
		workerId: string,
		charge: AutoTopupChargeSucceeded,
	): Promise<{ circuitOpened: boolean }> {
		return await this.transaction(async (tx) => {
			const job = await lockJobForCompletion(tx, projectId, jobId);
			if (job === null) throw new Error(`Auto top-up job ${jobId} was not found`);
			const amountPaid = safeMinor(charge.amountPaidMinor, "charged auto top-up amount");
			const currency = charge.currency.trim().toUpperCase();
			if (currency !== job.currency?.toUpperCase()) {
				throw new Error("Auto top-up charge currency does not match the scheduled job");
			}
			if (job.status === "succeeded") {
				if (
					job.external_invoice_id !== charge.externalInvoiceId ||
					safeMinor(job.charged_amount_minor, "stored auto top-up charge") !== amountPaid
				) {
					throw new Error("Auto top-up success receipt does not match the completed job");
				}
				return { circuitOpened: job.state_status === "suspended" };
			}
			requireProcessingLock(job, workerId);

			const now = new Date();
			const state = await normalizeInterval(tx, job, now);
			const reservationIsCurrent = sameInstant(
				job.budget_interval_started_at,
				state.intervalStartedAt,
			);
			const expected = safeMinor(job.amount_minor, "scheduled auto top-up amount");
			const purchases = state.purchases + (reservationIsCurrent ? 0 : 1);
			const spend = state.spend - (reservationIsCurrent ? expected : 0) + amountPaid;
			const maximumSpend = nullableSafeMinor(job.max_spend_minor, "auto top-up spend limit");
			const safetyExceeded =
				purchases > job.max_purchases_per_interval ||
				(maximumSpend !== null && spend > maximumSpend);

			const transactionId = charge.externalPaymentId ?? `invoice:${charge.externalInvoiceId}`;
			const purchasedAt = now;
			const purchaseId = await upsertPurchase(tx, projectId, {
				customerId: job.customer_id,
				productId: job.product_id,
				storeProductId: job.store_product_id,
				subscriptionId: null,
				provider: "stripe",
				channel: "web",
				purchaseKind: "consumable",
				transactionId,
				originalTransactionId: charge.externalInvoiceId,
				status: "completed",
				purchasedAt,
				invalidatedAt: null,
				invalidationReason: null,
				rawPayload: {
					source: "auto_topup",
					autoTopupJobId: jobId,
					autoTopupPolicyId: String(job.policy_id),
					externalInvoiceId: charge.externalInvoiceId,
					externalPaymentId: charge.externalPaymentId,
					amountPaidMinor: amountPaid,
					currency,
				},
				identityError: `Auto top-up payment identity mismatch for ${transactionId}`,
			});
			await materializeTopupAllocation(tx, {
				projectId,
				customerId: job.customer_id,
				storeProductId: job.store_product_id,
				purchaseId,
				purchasedAt,
			});
			await recordAutoTopupInvoice(tx, {
				projectId,
				customerId: job.customer_id,
				externalInvoiceId: charge.externalInvoiceId,
				amountPaid,
				currency,
				purchasedAt,
				jobId,
				paymentId: charge.externalPaymentId,
			});
			const entitlements = await recomputeCustomerEntitlements(
				tx,
				projectId,
				job.billing_account_id,
			);
			await enqueueProjectionSyncJob(tx, {
				customerId: job.customer_id,
				idempotencyKey: `auto-topup:${jobId}`,
				reason: "usage_changed",
				payload: {
					billingAccountId: job.billing_account_id,
					reason: "usage_changed",
					entitlements,
				},
			});

			await executeOne(
				tx,
				drizzleSql`
				UPDATE auto_topup_jobs
				SET status = 'succeeded', charged_amount_minor = ${amountPaid},
					external_invoice_id = ${charge.externalInvoiceId},
					external_payment_id = ${charge.externalPaymentId}, completed_at = ${now.toISOString()},
					last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
				WHERE project_id = ${projectId} AND id = ${jobId}
				RETURNING id
			`,
			);
			await executeOne(
				tx,
				drizzleSql`
				UPDATE auto_topup_states
				SET purchases_in_interval = ${purchases}, spend_minor_in_interval = ${spend},
					consecutive_failures = ${safetyExceeded ? job.consecutive_failures + 1 : 0},
					status = CASE
						WHEN ${safetyExceeded} THEN 'suspended'
						WHEN cooldown_until > now() THEN 'cooldown'
						ELSE 'ready'
					END,
					circuit_opened_at = CASE WHEN ${safetyExceeded} THEN now() ELSE NULL END,
					last_attempt_at = now(), last_success_at = now(),
					last_error = ${safetyExceeded ? "Provider charge exceeded the configured auto top-up safety budget" : null},
					updated_at = now()
				WHERE project_id = ${projectId} AND policy_id = ${String(job.policy_id)}::bigint
				RETURNING policy_id
			`,
			);
			return { circuitOpened: safetyExceeded };
		});
	}

	async markAutoTopupFailed(
		projectId: string,
		jobId: string,
		workerId: string,
		input: {
			kind: AutoTopupFailureKind;
			error: string;
			nextAttemptAt: Date | null;
			externalInvoiceId?: string | null;
			externalPaymentId?: string | null;
		},
	): Promise<AutoTopupFailureResult> {
		return await this.transaction(async (tx) => {
			const job = await lockJobForCompletion(tx, projectId, jobId);
			if (job === null) throw new Error(`Auto top-up job ${jobId} was not found`);
			requireProcessingLock(job, workerId);
			const now = new Date();
			const state = await normalizeInterval(tx, job, now);
			const reserved = sameInstant(job.budget_interval_started_at, state.intervalStartedAt);
			const expected = safeMinor(job.amount_minor, "scheduled auto top-up amount");
			const purchases = Math.max(0, state.purchases - (reserved ? 1 : 0));
			const spend = Math.max(0, state.spend - (reserved ? expected : 0));
			const failures = job.consecutive_failures + 1;
			const terminalKind = input.kind !== "retryable";
			const circuitOpened = terminalKind || failures >= job.max_consecutive_failures;
			const retryScheduled = !circuitOpened && input.nextAttemptAt !== null;
			const error = input.error.trim().slice(0, 2_000) || "Auto top-up failed";
			await executeOne(
				tx,
				drizzleSql`
				UPDATE auto_topup_jobs
				SET status = ${retryScheduled ? "pending" : input.kind === "retryable" ? "failed" : "provider_action_required"},
					next_attempt_at = ${input.nextAttemptAt?.toISOString() ?? now.toISOString()},
					external_invoice_id = COALESCE(${input.externalInvoiceId ?? null}, external_invoice_id),
					external_payment_id = COALESCE(${input.externalPaymentId ?? null}, external_payment_id),
					last_error = ${error}, completed_at = ${retryScheduled ? null : now.toISOString()},
					budget_reserved_at = NULL, budget_interval_started_at = NULL,
					locked_at = NULL, locked_by = NULL, updated_at = now()
				WHERE project_id = ${projectId} AND id = ${jobId}
				RETURNING id
			`,
			);
			await executeOne(
				tx,
				drizzleSql`
				UPDATE auto_topup_states
				SET purchases_in_interval = ${purchases}, spend_minor_in_interval = ${spend},
					consecutive_failures = ${failures},
					status = CASE
						WHEN ${circuitOpened} THEN 'suspended'
						WHEN cooldown_until > now() THEN 'cooldown'
						ELSE 'ready'
					END,
					circuit_opened_at = CASE WHEN ${circuitOpened} THEN now() ELSE NULL END,
					last_attempt_at = now(), last_error = ${error}, updated_at = now()
				WHERE project_id = ${projectId} AND policy_id = ${String(job.policy_id)}::bigint
				RETURNING policy_id
			`,
			);
			return { retryScheduled, circuitOpened };
		});
	}
}

async function lockClaimedJob(
	executor: QueryExecutor,
	jobId: string,
): Promise<ClaimedJobRow | null> {
	return await executeOne<ClaimedJobRow>(
		executor,
		drizzleSql`
		SELECT job.id, job.project_id, project.key AS project_key, job.policy_id, job.customer_id,
			customer.billing_account_id, provider_customer.external_customer_id,
			job.store_product_id, store.external_price_id, job.amount_minor, job.currency, job.attempts,
			job.budget_reserved_at, job.budget_interval_started_at, policy.active AS policy_active,
			policy.limit_interval_seconds, policy.max_purchases_per_interval, policy.max_spend_minor,
			policy.max_consecutive_failures, state.status AS state_status,
			state.interval_started_at, state.purchases_in_interval, state.spend_minor_in_interval,
			state.consecutive_failures
		FROM auto_topup_jobs job
		JOIN projects project ON project.id = job.project_id
		JOIN customers customer ON customer.project_id = job.project_id AND customer.id = job.customer_id
		JOIN auto_topup_policies policy
			ON policy.project_id = job.project_id AND policy.id = job.policy_id
		JOIN auto_topup_states state
			ON state.project_id = policy.project_id AND state.policy_id = policy.id
		JOIN store_products store
			ON store.project_id = job.project_id AND store.id = job.store_product_id
		LEFT JOIN provider_customers provider_customer
			ON provider_customer.project_id = job.project_id
			AND provider_customer.customer_id = job.customer_id
			AND provider_customer.provider = 'stripe'
		WHERE job.id = ${jobId}
		FOR UPDATE OF state
	`,
	);
}

async function prepareClaimedJob(
	executor: QueryExecutor,
	row: ClaimedJobRow,
	workerId: string,
): Promise<AutoTopupJob | null> {
	const now = new Date();
	const normalized = await normalizeInterval(executor, row, now);
	if (!row.policy_active || row.state_status === "suspended") {
		await terminateUnclaimableJob(
			executor,
			row,
			"Auto top-up policy is inactive or suspended",
			now,
		);
		return null;
	}
	const amount = safeMinor(row.amount_minor, "scheduled auto top-up amount");
	if (amount <= 0 || row.currency === null) {
		await suspendUnclaimableJob(executor, row, "Auto top-up price is unavailable", now);
		return null;
	}
	const reservationIsCurrent = sameInstant(
		row.budget_interval_started_at,
		normalized.intervalStartedAt,
	);
	let purchases = normalized.purchases;
	let spend = normalized.spend;
	if (!reservationIsCurrent) {
		const maximumSpend = nullableSafeMinor(row.max_spend_minor, "auto top-up spend limit");
		if (
			purchases >= row.max_purchases_per_interval ||
			(maximumSpend !== null && spend + amount > maximumSpend)
		) {
			await terminateUnclaimableJob(executor, row, "Auto top-up safety budget is exhausted", now);
			return null;
		}
		purchases += 1;
		spend += amount;
		await executeOne(
			executor,
			drizzleSql`
			UPDATE auto_topup_states
			SET purchases_in_interval = ${purchases}, spend_minor_in_interval = ${spend},
				last_attempt_at = ${now.toISOString()}, updated_at = now()
			WHERE project_id = ${row.project_id} AND policy_id = ${String(row.policy_id)}::bigint
			RETURNING policy_id
		`,
		);
	}
	const claimed = await executeOne<{ attempts: number }>(
		executor,
		drizzleSql`
		UPDATE auto_topup_jobs
		SET status = 'processing', attempts = attempts + 1, locked_at = ${now.toISOString()},
			locked_by = ${workerId}, budget_reserved_at = COALESCE(budget_reserved_at, ${now.toISOString()}),
			budget_interval_started_at = ${normalized.intervalStartedAt.toISOString()}, updated_at = now()
		WHERE project_id = ${row.project_id} AND id = ${row.id}
		RETURNING attempts
	`,
	);
	if (claimed === null) throw new Error(`Auto top-up job ${row.id} could not be claimed`);
	const maximumSpend = nullableSafeMinor(row.max_spend_minor, "auto top-up spend limit");
	const maximumCharge =
		maximumSpend === null ? Number.MAX_SAFE_INTEGER : amount + maximumSpend - spend;
	return {
		jobId: row.id,
		projectId: row.project_id,
		projectKey: row.project_key,
		policyId: String(row.policy_id),
		customerId: row.customer_id,
		billingAccountId: row.billing_account_id,
		externalCustomerId: row.external_customer_id,
		storeProductId: row.store_product_id,
		externalPriceId: row.external_price_id,
		amountMinor: amount,
		maximumChargeMinor: maximumCharge,
		currency: row.currency.toUpperCase(),
		attempts: claimed.attempts,
		consecutiveFailures: row.consecutive_failures,
		maxConsecutiveFailures: row.max_consecutive_failures,
	};
}

async function lockJobForCompletion(
	executor: QueryExecutor,
	projectId: string,
	jobId: string,
): Promise<LockedJobRow | null> {
	return await executeOne<LockedJobRow>(
		executor,
		drizzleSql`
		SELECT job.id, job.project_id, project.key AS project_key, job.policy_id, job.customer_id,
			customer.billing_account_id, provider_customer.external_customer_id,
			job.store_product_id, store.product_id, store.external_price_id, job.amount_minor,
			job.charged_amount_minor, job.currency, job.attempts, job.trigger_key, job.status,
			job.locked_by, job.external_invoice_id, job.external_payment_id,
			job.budget_reserved_at, job.budget_interval_started_at, policy.active AS policy_active,
			policy.limit_interval_seconds, policy.max_purchases_per_interval, policy.max_spend_minor,
			policy.max_consecutive_failures, state.status AS state_status,
			state.interval_started_at, state.purchases_in_interval, state.spend_minor_in_interval,
			state.consecutive_failures, state.cooldown_until
		FROM auto_topup_jobs job
		JOIN projects project ON project.id = job.project_id
		JOIN customers customer ON customer.project_id = job.project_id AND customer.id = job.customer_id
		JOIN auto_topup_policies policy
			ON policy.project_id = job.project_id AND policy.id = job.policy_id
		JOIN auto_topup_states state
			ON state.project_id = policy.project_id AND state.policy_id = policy.id
		JOIN store_products store
			ON store.project_id = job.project_id AND store.id = job.store_product_id
		LEFT JOIN provider_customers provider_customer
			ON provider_customer.project_id = job.project_id
			AND provider_customer.customer_id = job.customer_id
			AND provider_customer.provider = 'stripe'
		WHERE job.project_id = ${projectId} AND job.id = ${jobId}
		FOR UPDATE OF job, state
	`,
	);
}

async function normalizeInterval(
	executor: QueryExecutor,
	row: Pick<
		ClaimedJobRow,
		| "project_id"
		| "policy_id"
		| "state_status"
		| "interval_started_at"
		| "limit_interval_seconds"
		| "purchases_in_interval"
		| "spend_minor_in_interval"
	>,
	now: Date,
): Promise<{ intervalStartedAt: Date; purchases: number; spend: number }> {
	let intervalStartedAt = new Date(row.interval_started_at);
	let purchases = row.purchases_in_interval;
	let spend = safeMinor(row.spend_minor_in_interval, "auto top-up interval spend");
	if (
		row.state_status !== "suspended" &&
		intervalStartedAt.getTime() + row.limit_interval_seconds * 1_000 <= now.getTime()
	) {
		intervalStartedAt = now;
		purchases = 0;
		spend = 0;
		await executeOne(
			executor,
			drizzleSql`
			UPDATE auto_topup_states
			SET interval_started_at = ${now.toISOString()}, purchases_in_interval = 0,
				spend_minor_in_interval = 0,
				status = CASE WHEN cooldown_until > now() THEN 'cooldown' ELSE 'ready' END,
				circuit_opened_at = NULL, updated_at = now()
			WHERE project_id = ${row.project_id} AND policy_id = ${String(row.policy_id)}::bigint
			RETURNING policy_id
		`,
		);
	}
	return { intervalStartedAt, purchases, spend };
}

async function terminateUnclaimableJob(
	executor: QueryExecutor,
	row: ClaimedJobRow,
	error: string,
	now: Date,
): Promise<void> {
	const normalized = await normalizeInterval(executor, row, now);
	const reserved = sameInstant(row.budget_interval_started_at, normalized.intervalStartedAt);
	const amount = nullableSafeMinor(row.amount_minor, "scheduled auto top-up amount") ?? 0;
	if (reserved) {
		await executeOne(
			executor,
			drizzleSql`
			UPDATE auto_topup_states
			SET purchases_in_interval = GREATEST(purchases_in_interval - 1, 0),
				spend_minor_in_interval = GREATEST(spend_minor_in_interval - ${amount}, 0),
				updated_at = now()
			WHERE project_id = ${row.project_id} AND policy_id = ${String(row.policy_id)}::bigint
			RETURNING policy_id
		`,
		);
	}
	await executeOne(
		executor,
		drizzleSql`
		UPDATE auto_topup_jobs
		SET status = 'failed', last_error = ${error}, completed_at = ${now.toISOString()},
			budget_reserved_at = NULL, budget_interval_started_at = NULL,
			locked_at = NULL, locked_by = NULL, updated_at = now()
		WHERE project_id = ${row.project_id} AND id = ${row.id}
		RETURNING id
	`,
	);
}

async function suspendUnclaimableJob(
	executor: QueryExecutor,
	row: ClaimedJobRow,
	error: string,
	now: Date,
): Promise<void> {
	await terminateUnclaimableJob(executor, row, error, now);
	await executeOne(
		executor,
		drizzleSql`
		UPDATE auto_topup_states
		SET status = 'suspended', circuit_opened_at = now(), last_error = ${error}, updated_at = now()
		WHERE project_id = ${row.project_id} AND policy_id = ${String(row.policy_id)}::bigint
		RETURNING policy_id
	`,
	);
}

async function recordAutoTopupInvoice(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		externalInvoiceId: string;
		amountPaid: number;
		currency: string;
		purchasedAt: Date;
		jobId: string;
		paymentId: string | null;
	},
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
		INSERT INTO billing_invoices (
			project_id, customer_id, subscription_id, external_invoice_id,
			external_subscription_id, status, amount_paid, currency, paid_at,
			provider_created_at, last_provider_event_created, raw_payload
		) VALUES (
			${input.projectId}, ${input.customerId}, NULL, ${input.externalInvoiceId}, NULL,
			'paid', ${input.amountPaid}, ${input.currency.toLowerCase()}, ${input.purchasedAt.toISOString()},
			${input.purchasedAt.toISOString()}, 0,
			${jsonb({ source: "auto_topup", autoTopupJobId: input.jobId, externalPaymentId: input.paymentId })}
		)
		ON CONFLICT (project_id, external_invoice_id) DO UPDATE SET
			status = 'paid', amount_paid = EXCLUDED.amount_paid, currency = EXCLUDED.currency,
			paid_at = EXCLUDED.paid_at, raw_payload = EXCLUDED.raw_payload, updated_at = now()
		WHERE billing_invoices.customer_id = EXCLUDED.customer_id
	`,
	);
}

function requireProcessingLock(job: LockedJobRow, workerId: string): void {
	if (job.status !== "processing" || job.locked_by !== workerId) {
		throw new Error(`Auto top-up job ${job.id} is not locked by ${workerId}`);
	}
}

function sameInstant(left: Date | string | null, right: Date | string | null): boolean {
	return left !== null && right !== null && new Date(left).getTime() === new Date(right).getTime();
}

function safeMinor(value: string | number | bigint | null, name: string): number {
	if (value === null) throw new Error(`${name} is required`);
	if (typeof value === "number" && !Number.isSafeInteger(value)) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
	const parsed = typeof value === "bigint" ? value : BigInt(value);
	if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
	return Number(parsed);
}

function nullableSafeMinor(value: string | number | bigint | null, name: string): number | null {
	return value === null ? null : safeMinor(value, name);
}
