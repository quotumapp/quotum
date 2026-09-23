import {
	isResolvedPaymentSetupStatus,
	paymentSetupConflict,
} from "../../../src/billing/payment-setup";
import type {
	PaymentSetupReservation,
	PaymentSetupRow,
	ReservePaymentSetupInput,
} from "../../../src/db/repository";
import type {
	PaymentSetupClientDependency,
	PaymentSetupRepositoryDependency,
} from "../../../src/providers/stripe/payment-setup";

/**
 * An in-memory stand-in for `payment_setup_sessions`. It mirrors the SQL the repository runs: the
 * single active slot, the claim lease, and the conditional status transitions. Integration tests
 * exercise the real statements; this keeps the provider logic testable without a database.
 */
export class FakePaymentSetupStore implements PaymentSetupRepositoryDependency {
	readonly rows = new Map<string, PaymentSetupRow>();
	readonly reconciliations: Array<{ setupId: string; nextAttemptAt: Date }> = [];
	readonly enqueuedEvents: Array<{ eventType: string; externalEventId: string | null }> = [];
	private sequence = 0;
	now = new Date("2026-09-22T10:00:00.000Z");

	async findActivePaymentSetup(input: {
		billingAccountId: string;
		providerAccountId: string | null;
	}): Promise<PaymentSetupRow | null> {
		return (
			[...this.rows.values()].find(
				(row) =>
					row.billing_account_id === input.billingAccountId &&
					(row.provider_account_id ?? "") === (input.providerAccountId ?? "") &&
					!isResolvedPaymentSetupStatus(row.status),
			) ?? null
		);
	}

	async reservePaymentSetup(input: ReservePaymentSetupInput): Promise<PaymentSetupReservation> {
		const forPreview = [...this.rows.values()].find(
			(row) => row.preview_token === input.previewToken,
		);
		if (forPreview !== undefined) {
			return this.reusable(forPreview)
				? { kind: "reused", setup: forPreview }
				: { kind: forPreview.status === "creating" ? "resume" : "existing", setup: forPreview };
		}
		const active = await this.findActivePaymentSetup(input);
		if (active !== null) {
			if (active.request_hash !== input.requestHash || !this.reusable(active)) {
				throw paymentSetupConflict({
					setupId: active.id,
					status: active.status,
					expiresAt: new Date(active.expires_at).toISOString(),
				});
			}
			return { kind: "reused", setup: active };
		}
		this.sequence += 1;
		const id = `00000000-0000-4000-8000-${String(this.sequence).padStart(12, "0")}`;
		const row: PaymentSetupRow = {
			id,
			project_id: "project_1",
			customer_id: `customer_${input.billingAccountId}`,
			billing_account_id: input.billingAccountId,
			provider: "stripe",
			provider_account_id: input.providerAccountId,
			provider_customer_id: input.providerCustomerId,
			preview_token: input.previewToken,
			provider_idempotency_key: input.providerIdempotencyKey,
			request_hash: input.requestHash,
			currency: input.currency,
			email: input.email,
			success_url: input.successUrl,
			cancel_url: input.cancelUrl,
			status: "creating",
			external_session_id: null,
			session_url: null,
			external_setup_intent_id: null,
			intended_payment_method_id: null,
			default_payment_method_id: null,
			card_brand: null,
			card_last4: null,
			card_exp_month: null,
			card_exp_year: null,
			attention_reason: null,
			expires_at: input.expiresAt.toISOString(),
			completed_at: null,
			claimed_by: null,
			claimed_at: null,
			created_at: this.now.toISOString(),
			updated_at: this.now.toISOString(),
		};
		this.rows.set(id, row);
		return { kind: "created", setup: row };
	}

	async recordPaymentSetupLink(input: {
		setupId: string;
		externalSessionId: string;
		sessionUrl: string;
		externalSetupIntentId: string | null;
		expiresAt: Date;
	}): Promise<PaymentSetupRow> {
		const row = this.require(input.setupId);
		if (row.external_session_id !== null && row.external_session_id !== input.externalSessionId) {
			throw new Error("Payment setup session resolved to a different provider session");
		}
		if (row.status === "creating") row.status = "awaiting_customer";
		row.external_session_id = input.externalSessionId;
		if (row.status === "awaiting_customer") row.session_url ??= input.sessionUrl;
		row.external_setup_intent_id = row.external_setup_intent_id ?? input.externalSetupIntentId;
		return row;
	}

	async claimPaymentSetup(input: {
		setupId: string;
		workerId: string;
	}): Promise<PaymentSetupRow | null> {
		const row = this.rows.get(input.setupId);
		if (row === undefined) return null;
		if (row.claimed_by !== null && row.claimed_by !== input.workerId) return null;
		row.claimed_by = input.workerId;
		row.claimed_at = this.now.toISOString();
		return row;
	}

	async releasePaymentSetupClaim(input: { setupId: string; workerId: string }): Promise<void> {
		const row = this.rows.get(input.setupId);
		if (row?.claimed_by === input.workerId) {
			row.claimed_by = null;
			row.claimed_at = null;
		}
	}

	async recordPaymentSetupIntent(input: {
		setupId: string;
		workerId: string;
		externalSetupIntentId: string;
		paymentMethodId: string;
		externalSessionId: string | null;
	}): Promise<PaymentSetupRow> {
		const row = this.requireHeld(input.setupId, input.workerId);
		row.status = "applying_default";
		row.external_session_id = row.external_session_id ?? input.externalSessionId;
		row.external_setup_intent_id = input.externalSetupIntentId;
		row.intended_payment_method_id = input.paymentMethodId;
		row.attention_reason = null;
		return row;
	}

	async completePaymentSetup(input: {
		setupId: string;
		workerId: string;
		paymentMethodId: string;
		card: {
			brand: string | null;
			last4: string | null;
			expMonth: number | null;
			expYear: number | null;
		} | null;
	}): Promise<PaymentSetupRow> {
		const row = this.requireHeld(input.setupId, input.workerId);
		row.status = "completed";
		row.default_payment_method_id = input.paymentMethodId;
		row.card_brand = input.card?.brand ?? null;
		row.card_last4 = input.card?.last4 ?? null;
		row.card_exp_month = input.card?.expMonth ?? null;
		row.card_exp_year = input.card?.expYear ?? null;
		row.attention_reason = null;
		row.completed_at = this.now.toISOString();
		row.claimed_by = null;
		row.claimed_at = null;
		return row;
	}

	async expirePaymentSetup(input: { setupId: string; workerId: string }): Promise<PaymentSetupRow> {
		const row = this.requireHeld(input.setupId, input.workerId);
		if (row.status === "completed") return row;
		row.status = "expired";
		row.session_url = null;
		row.intended_payment_method_id = null;
		row.attention_reason = null;
		row.claimed_by = null;
		row.claimed_at = null;
		return row;
	}

	async flagPaymentSetupAttention(input: {
		setupId: string;
		workerId: string;
		reason: string;
	}): Promise<PaymentSetupRow | null> {
		const row = this.rows.get(input.setupId);
		if (row === undefined || isResolvedPaymentSetupStatus(row.status)) return null;
		row.status = "needs_attention";
		row.attention_reason = input.reason;
		row.claimed_by = null;
		row.claimed_at = null;
		return row;
	}

	async findPaymentSetupById(setupId: string): Promise<PaymentSetupRow | null> {
		return this.rows.get(setupId) ?? null;
	}

	async schedulePaymentSetupReconciliation(input: {
		setupId: string;
		nextAttemptAt: Date;
	}): Promise<string> {
		if (!this.reconciliations.some((item) => item.setupId === input.setupId))
			this.reconciliations.push(input);
		return `store_event_${input.setupId}`;
	}

	async enqueueProviderStoreEvent(input: {
		provider: "stripe";
		channel: "web";
		externalEventId: string | null;
		eventType: string;
		transactionId: string | null;
		rawPayload: Record<string, unknown>;
	}): Promise<{ storeEventId: string; enqueued: boolean }> {
		const duplicate = this.enqueuedEvents.some(
			(entry) => entry.externalEventId === input.externalEventId,
		);
		this.enqueuedEvents.push({
			eventType: input.eventType,
			externalEventId: input.externalEventId,
		});
		return { storeEventId: `store_event_${this.enqueuedEvents.length}`, enqueued: !duplicate };
	}

	only(): PaymentSetupRow {
		const [row] = [...this.rows.values()];
		if (row === undefined) throw new Error("No payment setup was recorded");
		return row;
	}

	private reusable(row: PaymentSetupRow): boolean {
		return (
			row.status === "awaiting_customer" &&
			row.session_url !== null &&
			new Date(row.expires_at).getTime() > this.now.getTime()
		);
	}

	private require(setupId: string): PaymentSetupRow {
		const row = this.rows.get(setupId);
		if (row === undefined) throw new Error(`Unknown payment setup ${setupId}`);
		return row;
	}

	private requireHeld(setupId: string, workerId: string): PaymentSetupRow {
		const row = this.require(setupId);
		if (row.claimed_by !== workerId) throw new Error("Payment setup claim was lost");
		return row;
	}
}

export interface FakePaymentSetupClientOptions {
	setupIntentStatus?: "succeeded" | "requires_payment_method";
	paymentMethodType?: string;
	setupIntentCustomerId?: string;
	sessionStatus?: "open" | "complete" | "expired";
}

/** Records every provider call so a test can assert exactly what Stripe was asked to do. */
export class FakePaymentSetupClient implements PaymentSetupClientDependency {
	readonly createdSessions: Array<{ params: Record<string, unknown>; idempotencyKey?: string }> =
		[];
	readonly defaultWrites: Array<{
		customerId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	}> = [];
	readonly failures = new Map<string, Error>();
	sessionStatus: "open" | "complete" | "expired";
	private sessionCounter = 0;

	constructor(private readonly options: FakePaymentSetupClientOptions = {}) {
		this.sessionStatus = options.sessionStatus ?? "open";
	}

	failNext(method: string, error: Error): void {
		this.failures.set(method, error);
	}

	async createCheckoutSession(
		params: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<{ id: string; url: string | null }> {
		this.throwIfFailed("createCheckoutSession");
		this.createdSessions.push({ params, idempotencyKey });
		// Stripe replays the original session for a repeated idempotency key.
		const existing = this.createdSessions.find(
			(entry) => entry.idempotencyKey === idempotencyKey && entry !== this.createdSessions.at(-1),
		);
		if (existing !== undefined) {
			return {
				id: sessionIdFor(idempotencyKey ?? ""),
				url: `https://setup.test/${idempotencyKey}`,
			};
		}
		this.sessionCounter += 1;
		return {
			id: sessionIdFor(idempotencyKey ?? String(this.sessionCounter)),
			url: `https://setup.test/${idempotencyKey ?? this.sessionCounter}`,
		};
	}

	async retrieveSetupCheckoutSession(sessionId: string): Promise<Record<string, unknown>> {
		this.throwIfFailed("retrieveSetupCheckoutSession");
		return {
			id: sessionId,
			mode: "setup",
			status: this.sessionStatus,
			setup_intent: `seti_${sessionId}`,
		};
	}

	async retrieveSetupIntent(setupIntentId: string): Promise<Record<string, unknown>> {
		this.throwIfFailed("retrieveSetupIntent");
		return {
			id: setupIntentId,
			status: this.options.setupIntentStatus ?? "succeeded",
			customer: this.options.setupIntentCustomerId ?? "cus_1",
			payment_method: {
				id: `pm_${setupIntentId}`,
				type: this.options.paymentMethodType ?? "card",
				card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2031 },
			},
		};
	}

	async updateCustomerDefaultPaymentMethod(input: {
		customerId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	}): Promise<void> {
		this.throwIfFailed("updateCustomerDefaultPaymentMethod");
		this.defaultWrites.push(input);
	}

	private throwIfFailed(method: string): void {
		const error = this.failures.get(method);
		if (error !== undefined) {
			this.failures.delete(method);
			throw error;
		}
	}
}

/** The session id the fake returns for an idempotency key, so a test can predict a race. */
export function sessionIdFor(key: string): string {
	return `cs_setup_${key.replace(/[^a-z0-9]/gi, "").slice(-16)}`;
}
