import { sql } from "drizzle-orm";
import { stableJson } from "../../billing/decimal";
import { BillingError } from "../../billing/errors";
import type { ProviderOperation } from "../../billing/provider-operations";
import type { ProjectInstanceContext } from "../../projects/context";
import type { PaddlePriceBinding } from "../../providers/paddle/catalog";
import { paddleOperationFailed } from "../../providers/paddle/operation-errors";
import type { PaddlePlanPin } from "../../providers/paddle/plan";
import { RepositoryModule } from "./base";
import { executeOne, jsonb } from "./query";
import type { QueryExecutor } from "./types";

export interface ReservePaddleCheckout {
	billingAccountId: string;
	idempotencyKey: string;
	previewToken?: string;
	providerAccountId: string;
	connectionVersionId: string;
	target: { binding: PaddlePriceBinding; plan: PaddlePlanPin | null };
}

interface ReservationRow {
	id: string;
	preview_token: string | null;
	idempotency_key: string;
	provider_account_id: string;
	connection_version_id: string;
	target: ReservePaddleCheckout["target"];
	operation_id: string | null;
	closed_at: Date | string | null;
	operation_status?: string | null;
	operation_error_code?: string | null;
}

export class PaddleCheckoutRepository extends RepositoryModule {
	/** No dispatch can have begun without binding an operation; race safely with that bind. */
	async rejectUnbound(
		project: ProjectInstanceContext,
		input: Pick<ReservePaddleCheckout, "billingAccountId" | "idempotencyKey" | "previewToken">,
	) {
		await this.database.execute(sql`
			UPDATE paddle_checkout_reservations SET closed_at = now(), closure_reason = 'rejected', updated_at = now()
			WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${input.billingAccountId}
				AND idempotency_key = ${input.idempotencyKey} AND owner_kind = ${input.previewToken ? "commercial" : "direct"}
				AND preview_token IS NOT DISTINCT FROM ${input.previewToken ?? null}::uuid
				AND operation_id IS NULL AND closed_at IS NULL
		`);
	}

	/**
	 * Releases what a dead request left behind before it dispatched anything: a write still
	 * `prepared`, and the account's open reservation when it has no operation or only that write.
	 * Nothing reached Paddle, so nothing can be lost. The request is taken for dead when its
	 * connection was replaced (no retry can dispatch under the recorded one), or when it has been
	 * idle far longer than the local steps between reserving and dispatching take and another key
	 * now asks. A prepared write is marked failed first: a late retry then finds a terminal receipt
	 * and cannot dispatch it. A retry of the same key on the same connection still resumes.
	 */
	async releaseNeverSent(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			connectionVersionId: string;
			/** Operation and reservation keys the caller's own retry would resume. */
			resumableKeys: readonly string[];
		},
	): Promise<void> {
		const projectId = project.projectInstanceId;
		const resumable = jsonb([...input.resumableKeys]);
		await this.transaction(async (tx) => {
			await lockPaddleCheckoutAccount(tx, projectId, input.billingAccountId);
			await tx.execute(sql`
				UPDATE provider_operations SET status = 'failed', error_code = 'PROVIDER_OPERATION_NEVER_SENT',
					updated_at = clock_timestamp()
				WHERE project_id = ${projectId} AND billing_account_id = ${input.billingAccountId}
					AND provider = 'paddle' AND status = 'prepared'
					AND (connection_version_id <> ${input.connectionVersionId}::uuid
						OR (updated_at < clock_timestamp() - interval '5 minutes'
							AND idempotency_key NOT IN (SELECT jsonb_array_elements_text(${resumable}))))
			`);
			// A reservation is released with its write, or when it never had one. One that the failed
			// write did not belong to, such as a dispatched checkout, is left alone.
			await tx.execute(sql`
				UPDATE paddle_checkout_reservations r SET closed_at = now(), closure_reason = 'rejected', updated_at = now()
				WHERE r.project_id = ${projectId} AND r.billing_account_id = ${input.billingAccountId}
					AND r.closed_at IS NULL
					AND (
						EXISTS (SELECT 1 FROM provider_operations o
							WHERE o.project_id = r.project_id AND o.billing_account_id = r.billing_account_id
								AND o.id = r.operation_id AND o.status = 'failed'
								AND o.error_code = 'PROVIDER_OPERATION_NEVER_SENT')
						OR (r.operation_id IS NULL
							AND (r.connection_version_id <> ${input.connectionVersionId}::uuid
								OR (r.updated_at < now() - interval '5 minutes'
									AND r.idempotency_key NOT IN (SELECT jsonb_array_elements_text(${resumable})))))
					)
			`);
		});
	}

	reserve(project: ProjectInstanceContext, input: ReservePaddleCheckout) {
		return this.transaction((tx) =>
			reservePaddleCheckoutInTx(tx, project.projectInstanceId, input),
		);
	}

	/** Link before dispatch, including before customer creation, so rejection can close its owner. */
	async bindOperation(
		project: ProjectInstanceContext,
		reservationId: string,
		operation: ProviderOperation,
	) {
		const row = await executeOne(
			this.database,
			sql`
			UPDATE paddle_checkout_reservations SET operation_id = CASE
				WHEN ${operation.operation} = 'customer.create' AND operation_id IS NOT NULL THEN operation_id
				ELSE ${operation.id}::uuid END, updated_at = now()
			WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${operation.billingAccountId}
				AND id = ${reservationId} AND closed_at IS NULL
				AND provider_account_id = ${operation.providerAccountId}
				AND connection_version_id = ${operation.connectionVersionId}
				AND (${operation.operation} = 'customer.create' OR idempotency_key = ${operation.idempotencyKey})
			RETURNING id
		`,
		);
		if (!row)
			throw new BillingError(
				"Checkout reservation is no longer owned",
				"PADDLE_CHECKOUT_CLOSED",
				409,
			);
	}

	async rejected(
		project: ProjectInstanceContext,
		reservationId: string,
		operation: ProviderOperation,
	) {
		await this.database.execute(sql`
			UPDATE paddle_checkout_reservations r SET closed_at = now(), closure_reason = 'rejected', operation_id = o.id, updated_at = now()
			FROM provider_operations o
			WHERE r.project_id = ${project.projectInstanceId} AND r.billing_account_id = ${operation.billingAccountId}
				AND r.id = ${reservationId} AND r.closed_at IS NULL
				AND (r.operation_id = o.id OR (r.operation_id IS NULL AND o.operation = 'customer.create'))
				AND r.provider_account_id = o.provider_account_id AND o.provider = 'paddle'
				AND o.project_id = r.project_id AND o.billing_account_id = r.billing_account_id
				AND o.id = ${operation.id} AND o.status = 'failed'
		`);
	}
}

export async function lockPaddleCheckoutAccount(
	tx: QueryExecutor,
	projectId: string,
	billingAccountId: string,
) {
	await executeOne(
		tx,
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`paddle-checkout:${projectId}:${billingAccountId}`}, 0))`,
	);
}

/** Shared by preview claiming and direct checkout. No provider I/O runs in this transaction. */
export async function reservePaddleCheckoutInTx(
	tx: QueryExecutor,
	projectId: string,
	input: ReservePaddleCheckout,
): Promise<string> {
	await lockPaddleCheckoutAccount(tx, projectId, input.billingAccountId);
	// Also repairs a crash between persisting a definitive rejection and closing its reservation.
	await tx.execute(sql`
		UPDATE paddle_checkout_reservations r SET closed_at = now(), closure_reason = 'rejected', updated_at = now()
		FROM provider_operations o WHERE r.project_id = ${projectId} AND r.billing_account_id = ${input.billingAccountId}
			AND r.closed_at IS NULL AND o.project_id = r.project_id AND o.billing_account_id = r.billing_account_id
			AND o.id = r.operation_id AND o.status = 'failed'
	`);
	const kind = input.previewToken ? "commercial" : "direct";
	const existing = await executeOne<ReservationRow>(
		tx,
		sql`
		SELECT r.*, o.status AS operation_status, o.error_code AS operation_error_code FROM paddle_checkout_reservations r
		LEFT JOIN provider_operations o ON o.project_id = r.project_id AND o.billing_account_id = r.billing_account_id AND o.id = r.operation_id
		WHERE r.project_id = ${projectId} AND r.billing_account_id = ${input.billingAccountId} AND r.owner_kind = ${kind}
			AND r.idempotency_key = ${input.idempotencyKey}
	`,
	);
	if (existing) {
		if (
			stableJson(existing.target) !== stableJson(input.target) ||
			existing.provider_account_id !== input.providerAccountId ||
			existing.connection_version_id !== input.connectionVersionId ||
			existing.preview_token !== (input.previewToken ?? null)
		) {
			throw new BillingError(
				"Checkout key belongs to another intent or connection",
				"IDEMPOTENCY_CONFLICT",
				409,
			);
		}
		if (existing.operation_status === "failed")
			throw paddleOperationFailed({
				id: existing.operation_id ?? "",
				errorCode: existing.operation_error_code ?? null,
			});
		if (existing.closed_at)
			throw new BillingError(
				"Checkout reservation is closed; use its original receipt",
				"PADDLE_CHECKOUT_CLOSED",
				409,
			);
		return existing.id;
	}
	const pending = await executeOne<ReservationRow>(
		tx,
		sql`
		SELECT * FROM paddle_checkout_reservations WHERE project_id = ${projectId}
			AND billing_account_id = ${input.billingAccountId} AND closed_at IS NULL
	`,
	);
	if (pending)
		throw new BillingError(
			"Resume the existing Paddle checkout before starting another",
			"PADDLE_CHECKOUT_PENDING",
			409,
			{
				details: {
					...(pending.preview_token ? { previewToken: pending.preview_token } : {}),
					...(pending.operation_id ? { operationId: pending.operation_id } : {}),
				},
			},
		);
	// A populated upgrade must reconstruct holds before enabling new checkout writes. Never
	// silently treat a legacy successful create as an expired/non-payable transaction.
	const legacy = await executeOne<{ id: string }>(
		tx,
		sql`
		SELECT o.id FROM provider_operations o
		WHERE o.project_id = ${projectId} AND o.billing_account_id = ${input.billingAccountId}
			AND o.provider = 'paddle' AND o.operation = 'checkout.hosted' AND o.status <> 'failed'
			AND o.idempotency_key <> ${input.idempotencyKey}
			AND NOT EXISTS (SELECT 1 FROM paddle_checkout_reservations r
				WHERE r.project_id = o.project_id AND r.billing_account_id = o.billing_account_id AND r.operation_id = o.id)
		ORDER BY o.created_at, o.id LIMIT 1
	`,
	);
	if (legacy)
		throw new BillingError(
			"Restore the reservation for the existing Paddle operation before starting another checkout",
			"PADDLE_CHECKOUT_PENDING",
			409,
			{
				details: { operationId: legacy.id },
			},
		);
	const active = await executeOne<{ active: boolean }>(
		tx,
		sql`
		SELECT EXISTS (SELECT 1 FROM customers c JOIN subscriptions s ON s.project_id = c.project_id AND s.customer_id = c.id
			JOIN plan_versions pv ON pv.project_id = s.project_id AND pv.id = s.plan_version_id
			WHERE c.project_id = ${projectId} AND c.billing_account_id = ${input.billingAccountId}
				AND pv.plan_kind = 'base' AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND (s.expires_at IS NULL OR s.expires_at > now())) AS active
	`,
	);
	if (active?.active)
		throw new BillingError("A base plan is already active", "BASE_PLAN_ALREADY_ACTIVE", 409);
	const row = await executeOne<{ id: string }>(
		tx,
		sql`
		INSERT INTO paddle_checkout_reservations (project_id, billing_account_id, owner_kind, idempotency_key,
			preview_token, provider_account_id, connection_version_id, target)
		VALUES (${projectId}, ${input.billingAccountId}, ${kind}, ${input.idempotencyKey}, ${input.previewToken ?? null},
			${input.providerAccountId}, ${input.connectionVersionId}, ${jsonb(input.target)}) RETURNING id
	`,
	);
	if (!row) throw new Error("Paddle checkout reservation was not created");
	return row.id;
}

/** Called in the transaction that persists authenticated fulfillment or cancellation evidence. */
export async function closePaddleCheckoutInTx(
	tx: QueryExecutor,
	projectId: string,
	billingAccountId: string,
	operationId: string,
	reason: "fulfilled" | "canceled",
) {
	await tx.execute(sql`
		UPDATE paddle_checkout_reservations SET closed_at = now(), closure_reason = ${reason}, updated_at = now()
		WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
			AND operation_id = ${operationId} AND closed_at IS NULL
	`);
}
