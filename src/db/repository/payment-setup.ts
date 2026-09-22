import { sql as drizzleSql } from "drizzle-orm";
import { PersistenceConflictError } from "../../billing/errors";
import {
	type ActivePaymentSetupSummary,
	isResolvedPaymentSetupStatus,
	type PaymentSetupCard,
	type PaymentSetupSession,
	type PaymentSetupStatus,
	paymentSetupConflict,
	paymentSetupNotFound,
} from "../../billing/payment-setup";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { ensureCustomer } from "./identities";
import { executeOne } from "./query";
import { schedulePaymentSetupReconciliation } from "./store-events";
import type { QueryExecutor } from "./types";
import { isUuid, requireNonBlank } from "./validation";

/** How long one worker may hold a setup row before another may take it over. */
const CLAIM_LEASE_SECONDS = 300;

export interface PaymentSetupRow {
	id: string;
	project_id: string;
	customer_id: string;
	billing_account_id: string;
	provider: "stripe";
	provider_account_id: string | null;
	provider_customer_id: string;
	preview_token: string;
	provider_idempotency_key: string;
	request_hash: string;
	currency: string;
	email: string | null;
	success_url: string;
	cancel_url: string;
	status: PaymentSetupStatus;
	external_session_id: string | null;
	session_url: string | null;
	external_setup_intent_id: string | null;
	intended_payment_method_id: string | null;
	default_payment_method_id: string | null;
	card_brand: string | null;
	card_last4: string | null;
	card_exp_month: number | null;
	card_exp_year: number | null;
	attention_reason: string | null;
	expires_at: Date | string;
	completed_at: Date | string | null;
	claimed_by: string | null;
	claimed_at: Date | string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

export interface ReservePaymentSetupInput {
	billingAccountId: string;
	previewToken: string;
	providerAccountId: string | null;
	providerCustomerId: string;
	providerIdempotencyKey: string;
	requestHash: string;
	currency: string;
	email: string | null;
	successUrl: string;
	cancelUrl: string;
	expiresAt: Date;
}

/**
 * What a reservation resolved to. `created` and `resume` both owe the provider a creation call with
 * the row's frozen idempotency key; `reused` has a live link and `existing` returns later state.
 */
export type PaymentSetupReservation =
	| { kind: "created"; setup: PaymentSetupRow }
	| { kind: "resume"; setup: PaymentSetupRow }
	| { kind: "reused"; setup: PaymentSetupRow }
	| { kind: "existing"; setup: PaymentSetupRow };

const columns = drizzleSql`
	id, project_id, customer_id, billing_account_id, provider, provider_account_id,
	provider_customer_id, preview_token, provider_idempotency_key, request_hash, currency, email,
	success_url, cancel_url, status, external_session_id, session_url, external_setup_intent_id,
	intended_payment_method_id, default_payment_method_id, card_brand, card_last4, card_exp_month,
	card_exp_year, attention_reason, expires_at, completed_at, claimed_by, claimed_at,
	created_at, updated_at
`;

/**
 * Hosted payment-method setup records. Every write is conditional on the state it expects, so a
 * duplicate or out-of-order provider event cannot move a setup backwards, and a worker only
 * changes a row it still holds.
 */
export class PaymentSetupRepository extends RepositoryModule {
	/** The unresolved setup holding the account's slot, if any. Used by previews and by reads. */
	async findActivePaymentSetup(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; providerAccountId: string | null },
	): Promise<PaymentSetupRow | null> {
		return await activeSetup(this.database, project.projectInstanceId, input, false);
	}

	/**
	 * Claims the account's single setup slot for this execution. A matching unresolved request gets
	 * the existing row back; a differing one is refused and names the active setup.
	 */
	async reservePaymentSetup(
		project: ProjectInstanceContext,
		input: ReservePaymentSetupInput,
	): Promise<PaymentSetupReservation> {
		requireNonBlank(input.billingAccountId, "p_billing_account_id");
		requireNonBlank(input.providerCustomerId, "p_provider_customer_id");
		requirePreviewToken(input.previewToken);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			// The upsert locks the customer row, serializing concurrent reservations for the account.
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId, input.email);
			const existingForPreview = await executeOne<PaymentSetupRow>(
				tx,
				drizzleSql`
					SELECT ${columns} FROM payment_setup_sessions
					WHERE project_id = ${projectId} AND preview_token = ${input.previewToken}
					FOR UPDATE
				`,
			);
			if (existingForPreview !== null) {
				if (!isResolvedPaymentSetupStatus(existingForPreview.status))
					await schedulePaymentSetupReconciliation(tx, projectId, {
						setupId: existingForPreview.id,
						nextAttemptAt: new Date(Date.now() + 30 * 60_000),
					});
				return reservationFor(existingForPreview);
			}
			const active = await activeSetup(
				tx,
				projectId,
				{ billingAccountId: input.billingAccountId, providerAccountId: input.providerAccountId },
				true,
			);
			if (active !== null) {
				if (active.request_hash !== input.requestHash || !isReusable(active)) {
					throw paymentSetupConflict(activeSummary(active));
				}
				return { kind: "reused", setup: active };
			}
			const created = await executeOne<PaymentSetupRow>(
				tx,
				drizzleSql`
					INSERT INTO payment_setup_sessions (
						project_id, customer_id, billing_account_id, provider, provider_account_id,
						provider_customer_id, preview_token, provider_idempotency_key, request_hash,
						currency, email, success_url, cancel_url, status, expires_at
					) VALUES (
						${projectId}, ${customer.id}, ${input.billingAccountId}, 'stripe',
						${input.providerAccountId}, ${input.providerCustomerId}, ${input.previewToken},
						${input.providerIdempotencyKey}, ${input.requestHash}, ${input.currency},
						${input.email}, ${input.successUrl}, ${input.cancelUrl}, 'creating',
						${input.expiresAt.toISOString()}
					)
					RETURNING ${columns}
				`,
			);
			if (created === null) throw new Error("Payment setup session could not be created");
			await schedulePaymentSetupReconciliation(tx, projectId, {
				setupId: created.id,
				nextAttemptAt: new Date(new Date(created.created_at).getTime() + 30 * 60_000),
			});
			return { kind: "created", setup: created };
		});
	}

	/**
	 * Records the hosted link. A completion that overtook the creation response has already moved
	 * the row on, so the write never drags a resolved setup back: it only fills in the session
	 * identity and, while awaiting the customer, its first URL. Reservation expiry stays frozen.
	 */
	async recordPaymentSetupLink(
		project: ProjectInstanceContext,
		input: {
			setupId: string;
			externalSessionId: string;
			sessionUrl: string;
			externalSetupIntentId: string | null;
			expiresAt: Date;
		},
	): Promise<PaymentSetupRow> {
		const projectId = project.projectInstanceId;
		const updated = await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				UPDATE payment_setup_sessions
				SET status = CASE WHEN status = 'creating' THEN 'awaiting_customer' ELSE status END,
					external_session_id = ${input.externalSessionId},
					session_url = CASE
						WHEN status IN ('creating', 'awaiting_customer') THEN COALESCE(session_url, ${input.sessionUrl})
						ELSE session_url
					END,
					external_setup_intent_id = COALESCE(external_setup_intent_id, ${input.externalSetupIntentId}),
					updated_at = now()
				WHERE project_id = ${projectId} AND id = ${input.setupId}
					AND (external_session_id IS NULL OR external_session_id = ${input.externalSessionId})
				RETURNING ${columns}
			`,
		);
		if (updated !== null) return updated;
		throw new PersistenceConflictError(
			"Payment setup session resolved to a different provider session",
			"PAYMENT_SETUP_SESSION_CONFLICT",
		);
	}

	/** Takes the row for one applying worker; an unexpired foreign claim returns null. */
	async claimPaymentSetup(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string },
	): Promise<PaymentSetupRow | null> {
		requireNonBlank(input.workerId, "p_worker_id");
		if (!isUuid(input.setupId)) return null;
		const projectId = project.projectInstanceId;
		return await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				UPDATE payment_setup_sessions
				SET claimed_by = ${input.workerId}, claimed_at = now(), updated_at = now()
				WHERE project_id = ${projectId} AND id = ${input.setupId}
					AND (
						claimed_by IS NULL
						OR claimed_by = ${input.workerId}
						OR claimed_at <= now() - make_interval(secs => ${CLAIM_LEASE_SECONDS})
					)
				RETURNING ${columns}
			`,
		);
	}

	async releasePaymentSetupClaim(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string },
	): Promise<void> {
		await executeOne(
			this.database,
			drizzleSql`
				UPDATE payment_setup_sessions
				SET claimed_by = NULL, claimed_at = NULL, updated_at = now()
				WHERE project_id = ${project.projectInstanceId} AND id = ${input.setupId}
					AND claimed_by = ${input.workerId}
				RETURNING id
			`,
		);
	}

	/**
	 * Persists the method the setup intends to make default, before the provider is asked to make
	 * it so. A retry of the same apply finds the intent already recorded and repeats the same call.
	 */
	async recordPaymentSetupIntent(
		project: ProjectInstanceContext,
		input: {
			setupId: string;
			workerId: string;
			externalSetupIntentId: string;
			paymentMethodId: string;
			/** Carried by the event, so a completion that beat the creation response still has one. */
			externalSessionId: string | null;
		},
	): Promise<PaymentSetupRow> {
		const updated = await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				UPDATE payment_setup_sessions
				SET status = 'applying_default',
					external_session_id = COALESCE(external_session_id, ${input.externalSessionId}),
					external_setup_intent_id = ${input.externalSetupIntentId},
					intended_payment_method_id = ${input.paymentMethodId},
					attention_reason = NULL,
					updated_at = now()
				WHERE project_id = ${project.projectInstanceId} AND id = ${input.setupId}
					AND claimed_by = ${input.workerId}
					AND status IN ('creating', 'awaiting_customer', 'applying_default', 'needs_attention')
				RETURNING ${columns}
			`,
		);
		if (updated === null) {
			throw new PersistenceConflictError(
				"Payment setup session is no longer held by this worker",
				"PAYMENT_SETUP_CLAIM_LOST",
			);
		}
		return updated;
	}

	/** Marks the confirmed default-method update. Only the worker holding the row may do it. */
	async completePaymentSetup(
		project: ProjectInstanceContext,
		input: {
			setupId: string;
			workerId: string;
			paymentMethodId: string;
			card: PaymentSetupCard | null;
		},
	): Promise<PaymentSetupRow> {
		const card = input.card;
		const updated = await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				UPDATE payment_setup_sessions
				SET status = 'completed',
					default_payment_method_id = ${input.paymentMethodId},
					card_brand = ${card?.brand ?? null},
					card_last4 = ${card?.last4 ?? null},
					card_exp_month = ${card?.expMonth ?? null},
					card_exp_year = ${card?.expYear ?? null},
					attention_reason = NULL,
					completed_at = now(),
					claimed_by = NULL,
					claimed_at = NULL,
					updated_at = now()
				WHERE project_id = ${project.projectInstanceId} AND id = ${input.setupId}
					AND claimed_by = ${input.workerId}
					AND status <> 'completed'
				RETURNING ${columns}
			`,
		);
		if (updated === null) {
			const current = await this.requireSetupById(project.projectInstanceId, input.setupId);
			if (current.status === "completed") return current;
			throw new PersistenceConflictError(
				"Payment setup session is no longer held by this worker",
				"PAYMENT_SETUP_CLAIM_LOST",
			);
		}
		return updated;
	}

	/** Records a provider-confirmed expiry. A completed setup is never expired by a late event. */
	async expirePaymentSetup(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string },
	): Promise<PaymentSetupRow> {
		const updated = await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				UPDATE payment_setup_sessions
				SET status = 'expired',
					session_url = NULL,
					intended_payment_method_id = NULL,
					attention_reason = NULL,
					claimed_by = NULL,
					claimed_at = NULL,
					updated_at = now()
				WHERE project_id = ${project.projectInstanceId} AND id = ${input.setupId}
					AND claimed_by = ${input.workerId}
					AND status IN ('creating', 'awaiting_customer', 'needs_attention')
				RETURNING ${columns}
			`,
		);
		if (updated !== null) return updated;
		const current = await this.requireSetupById(project.projectInstanceId, input.setupId);
		if (isResolvedPaymentSetupStatus(current.status)) return current;
		throw new PersistenceConflictError(
			"Payment setup session could not be expired",
			"PAYMENT_SETUP_CLAIM_LOST",
		);
	}

	/** Leaves the setup visible and holding the slot after retries could not finish its work. */
	async flagPaymentSetupAttention(
		project: ProjectInstanceContext,
		input: { setupId: string; workerId: string; reason: string },
	): Promise<PaymentSetupRow | null> {
		return await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				UPDATE payment_setup_sessions
				SET status = 'needs_attention',
					attention_reason = ${input.reason.slice(0, 500)},
					claimed_by = NULL,
					claimed_at = NULL,
					updated_at = now()
				WHERE project_id = ${project.projectInstanceId} AND id = ${input.setupId}
					AND claimed_by = ${input.workerId}
					AND status NOT IN ('completed', 'expired')
				RETURNING ${columns}
			`,
		);
	}

	/** The read behind the payment-setup session route: persisted state only, no provider call. */
	async getPaymentSetupSession(
		project: ProjectInstanceContext,
		billingAccountId: string,
		sessionId: string,
	): Promise<PaymentSetupSession> {
		requireNonBlank(billingAccountId, "p_billing_account_id");
		requireNonBlank(sessionId, "p_session_id");
		// The route accepts either identifier: the setup id Quotum issued or the provider session id.
		const selector = isUuid(sessionId)
			? drizzleSql`id = ${sessionId}`
			: drizzleSql`external_session_id = ${sessionId}`;
		const row = await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				SELECT ${columns} FROM payment_setup_sessions
				WHERE project_id = ${project.projectInstanceId}
					AND billing_account_id = ${billingAccountId}
					AND ${selector}
				LIMIT 1
			`,
		);
		if (row === null) throw paymentSetupNotFound();
		return paymentSetupSession(row);
	}

	async findPaymentSetupById(
		project: ProjectInstanceContext,
		setupId: string,
	): Promise<PaymentSetupRow | null> {
		if (!isUuid(setupId)) return null;
		return await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				SELECT ${columns} FROM payment_setup_sessions
				WHERE project_id = ${project.projectInstanceId} AND id = ${setupId}
			`,
		);
	}

	private async requireSetupById(projectId: string, setupId: string): Promise<PaymentSetupRow> {
		const row = await executeOne<PaymentSetupRow>(
			this.database,
			drizzleSql`
				SELECT ${columns} FROM payment_setup_sessions
				WHERE project_id = ${projectId} AND id = ${setupId}
			`,
		);
		if (row === null) throw paymentSetupNotFound();
		return row;
	}
}

async function activeSetup(
	executor: QueryExecutor,
	projectId: string,
	input: { billingAccountId: string; providerAccountId: string | null },
	lock: boolean,
): Promise<PaymentSetupRow | null> {
	return await executeOne<PaymentSetupRow>(
		executor,
		drizzleSql`
			SELECT ${columns} FROM payment_setup_sessions
			WHERE project_id = ${projectId}
				AND billing_account_id = ${input.billingAccountId}
				AND provider = 'stripe'
				AND COALESCE(provider_account_id, '') = COALESCE(${input.providerAccountId}, '')
				AND status IN ('creating', 'awaiting_customer', 'applying_default', 'needs_attention')
			${lock ? drizzleSql`FOR UPDATE` : drizzleSql``}
		`,
	);
}

/** A reservation that found its own preview's row resumes that row rather than starting over. */
function reservationFor(setup: PaymentSetupRow): PaymentSetupReservation {
	if (isReusable(setup)) return { kind: "reused", setup };
	return { kind: setup.status === "creating" ? "resume" : "existing", setup };
}

/** Only an unexpired open link can be handed back; anything else is not a link to reuse. */
function isReusable(setup: PaymentSetupRow): boolean {
	return (
		setup.status === "awaiting_customer" &&
		setup.session_url !== null &&
		new Date(setup.expires_at).getTime() > Date.now()
	);
}

export function activeSummary(setup: PaymentSetupRow): ActivePaymentSetupSummary {
	return {
		setupId: setup.id,
		status: setup.status,
		expiresAt: isoOrNull(setup.expires_at),
	};
}

export function paymentSetupSession(row: PaymentSetupRow): PaymentSetupSession {
	return {
		setupId: row.id,
		billingAccountId: row.billing_account_id,
		provider: row.provider,
		status: row.status,
		currency: row.currency,
		sessionId: row.external_session_id,
		// The actionable link is reported only while the setup can still be finished.
		url: isReusable(row) ? row.session_url : null,
		expiresAt: isoOrNull(row.expires_at),
		completedAt: isoOrNull(row.completed_at),
		card:
			row.default_payment_method_id === null
				? null
				: {
						brand: row.card_brand,
						last4: row.card_last4,
						expMonth: row.card_exp_month,
						expYear: row.card_exp_year,
					},
		attention: row.attention_reason,
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

function isoOrNull(value: Date | string | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

function requirePreviewToken(value: string): void {
	if (!isUuid(value)) {
		throw new PersistenceConflictError(
			"Payment setup preview token must be a UUID",
			"COMMERCIAL_PREVIEW_NOT_FOUND",
		);
	}
}
