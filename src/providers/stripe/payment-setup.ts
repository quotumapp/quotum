/**
 * Hosted Stripe payment-method setup: creating the hosted link, applying the completion, and the
 * reconciliation that closes the gaps webhooks leave. Setup records no financial fact. The only
 * provider state it writes is `customer.invoice_settings.default_payment_method`, following
 * Stripe's hosted setup flow (https://docs.stripe.com/payments/checkout/subscriptions/update-payment-details).
 */

import { createHash } from "node:crypto";
import { BillingError } from "../../billing/errors";
import {
	type PaymentSetupCard,
	type PaymentSetupSession,
	type PaymentSetupStatus,
	paymentSetupConflict,
} from "../../billing/payment-setup";
import type {
	PaymentSetupReservation,
	PaymentSetupRow,
	ReservePaymentSetupInput,
} from "../../db/repository";
import type { StoreEventReplayProviderResult } from "../../workers/store-event-replay";
import type { StripeCheckoutSessionCreateParams } from "./client";

/** Leaves an hour of clock and request-latency margin below Stripe's maximum lifetime. */
export const PAYMENT_SETUP_LIFETIME_MS = 23 * 60 * 60 * 1000;
/** Stop creating before Stripe's 30-minute minimum lifetime, with a clock-skew margin. */
const PAYMENT_SETUP_CREATION_MARGIN_MS = 60 * 60 * 1000;
/** How long Stripe replays an idempotency key; past it a creation is never re-issued blindly. */
export const STRIPE_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How often an open setup is checked for a completion whose webhook never arrived. */
export const PAYMENT_SETUP_POLL_INTERVAL_MS = 30 * 60 * 1000;
/** The slower rhythm a setup that needs attention keeps, so it can still resolve itself. */
export const PAYMENT_SETUP_ATTENTION_POLL_MS = 6 * 60 * 60 * 1000;
/** Never reschedule sooner than this, so a deferral cannot become a busy loop. */
export const PAYMENT_SETUP_MIN_DEFER_MS = 60 * 1000;
/** Provider failures a reconciliation absorbs before the setup is marked as needing attention. */
export const PAYMENT_SETUP_ATTENTION_ATTEMPTS = 5;

export const PAYMENT_SETUP_METADATA_KEY = "quotumPaymentSetupId";
export const PAYMENT_SETUP_OPERATION = "payment_method_setup";

/** Copy shown on the hosted page, so the payer sees what saving the card is for. */
const HOSTED_SETUP_SUBMIT_MESSAGE =
	"This card is saved as the default payment method for this account and is charged for future automatic payments. Nothing is charged now.";

export interface PaymentSetupClientDependency {
	createCheckoutSession(
		params: StripeCheckoutSessionCreateParams,
		idempotencyKey?: string,
	): Promise<{ id: string; url: string | null }>;
	retrieveSetupCheckoutSession?(sessionId: string): Promise<Record<string, unknown>>;
	retrieveSetupIntent?(setupIntentId: string): Promise<Record<string, unknown>>;
	updateCustomerDefaultPaymentMethod?(input: {
		customerId: string;
		paymentMethodId: string;
		idempotencyKey: string;
	}): Promise<void>;
}

export interface PaymentSetupRepositoryDependency {
	findActivePaymentSetup?(input: {
		billingAccountId: string;
		providerAccountId: string | null;
	}): Promise<PaymentSetupRow | null>;
	reservePaymentSetup?(input: ReservePaymentSetupInput): Promise<PaymentSetupReservation>;
	recordPaymentSetupLink?(input: {
		setupId: string;
		externalSessionId: string;
		sessionUrl: string;
		externalSetupIntentId: string | null;
		expiresAt: Date;
	}): Promise<PaymentSetupRow>;
	claimPaymentSetup?(input: { setupId: string; workerId: string }): Promise<PaymentSetupRow | null>;
	releasePaymentSetupClaim?(input: { setupId: string; workerId: string }): Promise<void>;
	recordPaymentSetupIntent?(input: {
		setupId: string;
		workerId: string;
		externalSetupIntentId: string;
		paymentMethodId: string;
		externalSessionId: string | null;
	}): Promise<PaymentSetupRow>;
	completePaymentSetup?(input: {
		setupId: string;
		workerId: string;
		paymentMethodId: string;
		card: PaymentSetupCard | null;
	}): Promise<PaymentSetupRow>;
	expirePaymentSetup?(input: { setupId: string; workerId: string }): Promise<PaymentSetupRow>;
	flagPaymentSetupAttention?(input: {
		setupId: string;
		workerId: string;
		reason: string;
	}): Promise<PaymentSetupRow | null>;
	findPaymentSetupById?(setupId: string): Promise<PaymentSetupRow | null>;
	getPaymentSetupSession?(
		billingAccountId: string,
		sessionId: string,
	): Promise<PaymentSetupSession>;
	schedulePaymentSetupReconciliation?(input: {
		setupId: string;
		nextAttemptAt: Date;
	}): Promise<string>;
	enqueueProviderStoreEvent?(input: {
		provider: "stripe";
		channel: "web";
		externalEventId: string | null;
		eventType: string;
		transactionId: string | null;
		rawPayload: Record<string, unknown>;
	}): Promise<{ storeEventId: string; enqueued: boolean }>;
}

/** The frozen request the provider call is built from; hashing it decides reuse versus conflict. */
export interface PaymentSetupRequestParameters {
	billingAccountId: string;
	currency: string;
	email: string | null;
	successUrl: string;
	cancelUrl: string;
	providerAccountId: string | null;
	integrationIdentifier: string;
}

export function paymentSetupRequestHash(parameters: PaymentSetupRequestParameters): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				billingAccountId: parameters.billingAccountId,
				currency: parameters.currency,
				email: parameters.email,
				successUrl: parameters.successUrl,
				cancelUrl: parameters.cancelUrl,
				providerAccountId: parameters.providerAccountId,
				integrationIdentifier: parameters.integrationIdentifier,
			}),
		)
		.digest("hex");
}

/** A setup-mode Checkout Session Quotum created, as the events carry it. */
export interface NormalizedPaymentSetupEvent {
	action: "completed" | "expired";
	setupId: string;
	checkoutSessionId: string;
	stripeCustomerId: string | null;
	setupIntentId: string | null;
}

/**
 * Whether this Stripe event is a Quotum-created hosted setup. Only sessions in `setup` mode that
 * carry the setup id Quotum wrote count; a setup session created elsewhere is left alone.
 */
export function normalizePaymentSetupEvent(event: {
	type: string;
	object: Record<string, unknown>;
}): NormalizedPaymentSetupEvent | null {
	const action =
		event.type === "checkout.session.completed"
			? "completed"
			: event.type === "checkout.session.expired"
				? "expired"
				: null;
	if (action === null) return null;
	const session = event.object;
	if (optionalString(session.mode) !== "setup") return null;
	const metadata = optionalRecord(session.metadata) ?? {};
	const setupId = optionalString(metadata[PAYMENT_SETUP_METADATA_KEY]);
	const checkoutSessionId = optionalString(session.id);
	if (setupId === null || checkoutSessionId === null) return null;
	return {
		action,
		setupId,
		checkoutSessionId,
		stripeCustomerId: optionalId(session.customer),
		setupIntentId: optionalId(session.setup_intent),
	};
}

export interface PaymentSetupCreation {
	setupId: string;
	status: PaymentSetupStatus;
	sessionId: string | null;
	url: string | null;
	expiresAt: string;
	reused: boolean;
}

export interface CreatePaymentSetupInput {
	previewToken: string;
	providerCustomerId: string;
	providerIdempotencyKey: string;
	parameters: PaymentSetupRequestParameters;
}

export interface PaymentSetupContext {
	client: PaymentSetupClientDependency;
	repository: PaymentSetupRepositoryDependency;
	now?: () => Date;
}

/**
 * Reserves the account's setup slot and creates, resumes or reuses the hosted link. The provider
 * call happens outside every transaction and always carries the row's frozen idempotency key, so a
 * crash between the call and its recorded result resumes the same Stripe session.
 */
export async function createPaymentSetup(
	context: PaymentSetupContext,
	input: CreatePaymentSetupInput,
): Promise<PaymentSetupCreation> {
	const repository = requirePaymentSetupRepository(context.repository);
	const now = context.now?.() ?? new Date();
	const expiresAt = new Date(now.getTime() + PAYMENT_SETUP_LIFETIME_MS);
	const reservation = await repository.reservePaymentSetup({
		billingAccountId: input.parameters.billingAccountId,
		previewToken: input.previewToken,
		providerAccountId: input.parameters.providerAccountId,
		providerCustomerId: input.providerCustomerId,
		providerIdempotencyKey: input.providerIdempotencyKey,
		requestHash: paymentSetupRequestHash(input.parameters),
		currency: input.parameters.currency,
		email: input.parameters.email,
		successUrl: input.parameters.successUrl,
		cancelUrl: input.parameters.cancelUrl,
		expiresAt,
	});
	// Reservation and its task commit together in the SQL repository. Scheduling here also
	// repairs older reservations and runs before the provider call, which may throw.
	if (!["completed", "expired"].includes(reservation.setup.status))
		await scheduleReconciliation(context, reservation.setup, now);
	if (reservation.kind === "reused" || reservation.kind === "existing")
		return creationFrom(reservation.setup, true, now);
	if (!canIssueHostedSetupLink(reservation.setup, now))
		throw new BillingError(
			"The setup needs reconciliation before it can continue",
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			409,
		);
	const issued = await issueHostedSetupLink(context, reservation.setup);
	return creationFrom(issued.setup, reservation.kind === "resume", now);
}

/**
 * Creates the hosted session for a setup row that owes one and records the link. The same frozen
 * idempotency key is used every time, so Stripe returns the original session rather than a second.
 */
async function issueHostedSetupLink(
	context: PaymentSetupContext,
	setup: PaymentSetupRow,
): Promise<{ setup: PaymentSetupRow; session: { id: string; url: string } }> {
	const repository = requirePaymentSetupRepository(context.repository);
	// The row's own expiry is what the provider session was, or will be, created with.
	const expiresAt = new Date(setup.expires_at);
	const params: StripeCheckoutSessionCreateParams = {
		customer: setup.provider_customer_id,
		mode: "setup",
		currency: setup.currency,
		// Cards first: the eligible setup methods are filtered to cards for the requested currency.
		allowed_payment_method_types: ["card"],
		success_url: setup.success_url,
		cancel_url: setup.cancel_url,
		client_reference_id: setup.billing_account_id,
		expires_at: Math.floor(expiresAt.getTime() / 1000),
		metadata: paymentSetupMetadata(setup),
		setup_intent_data: { metadata: paymentSetupMetadata(setup) },
		custom_text: { submit: { message: HOSTED_SETUP_SUBMIT_MESSAGE } },
	};
	const session = await context.client.createCheckoutSession(
		params,
		setup.provider_idempotency_key,
	);
	if (typeof session.url !== "string" || session.url.trim() === "") {
		throw new BillingError(
			"Stripe hosted setup session did not include a redirect URL",
			"STRIPE_CHECKOUT_URL_MISSING",
			502,
		);
	}
	const stored = await repository.recordPaymentSetupLink({
		setupId: setup.id,
		externalSessionId: session.id,
		sessionUrl: session.url,
		externalSetupIntentId: null,
		expiresAt,
	});
	return { setup: stored, session: { id: session.id, url: session.url } };
}

/** What a preview says about the setup slot before the customer is sent anywhere. */
export async function paymentSetupPreviewFacts(
	context: PaymentSetupContext,
	input: PaymentSetupRequestParameters,
	checkConflict = true,
): Promise<{ reusesExistingSetup: boolean; setup: PaymentSetupRow | null }> {
	const active = (await context.repository.findActivePaymentSetup?.(input)) ?? null;
	if (active === null) return { reusesExistingSetup: false, setup: null };
	const matches = active.request_hash === paymentSetupRequestHash(input);
	if (checkConflict && !matches)
		throw paymentSetupConflict({
			setupId: active.id,
			status: active.status,
			expiresAt: new Date(active.expires_at).toISOString(),
		});
	const open =
		active.status === "awaiting_customer" &&
		active.session_url !== null &&
		new Date(active.expires_at).getTime() > (context.now?.() ?? new Date()).getTime();
	return { reusesExistingSetup: open && matches, setup: active };
}

/**
 * Durably queues a setup event for the replay worker. Provider work never happens in the webhook
 * request: the event is on disk before Stripe is acknowledged, and the worker owns what follows.
 */
export async function enqueuePaymentSetupEvent(
	context: PaymentSetupContext,
	input: {
		externalEventId: string;
		eventType: string;
		setup: NormalizedPaymentSetupEvent;
		rawEvent: Record<string, unknown>;
	},
): Promise<void> {
	const enqueue = context.repository.enqueueProviderStoreEvent?.bind(context.repository);
	if (enqueue === undefined) {
		throw new BillingError("Payment method setup is not configured", "STRIPE_NOT_CONFIGURED", 503);
	}
	await enqueue({
		provider: "stripe",
		channel: "web",
		externalEventId: input.externalEventId,
		eventType: input.eventType,
		transactionId: input.setup.checkoutSessionId,
		rawPayload: input.rawEvent,
	});
}

/**
 * Applies one setup event under a worker lease. Duplicate and out-of-order events are absorbed:
 * a completion never moves a resolved setup, and an expiry never overwrites a completed one.
 */
export async function applyPaymentSetupEvent(
	context: PaymentSetupContext,
	input: { event: NormalizedPaymentSetupEvent; workerId: string },
): Promise<StoreEventReplayProviderResult> {
	const repository = requirePaymentSetupRepository(context.repository);
	const now = context.now?.() ?? new Date();
	const claimed = await repository.claimPaymentSetup({
		setupId: input.event.setupId,
		workerId: input.workerId,
	});
	if (claimed === null) {
		const known = await repository.findPaymentSetupById?.(input.event.setupId);
		// The setup is committed before its Stripe session can exist. Missing means this
		// event has no target in this project, not a creation response that has yet to land.
		if (known === null || known === undefined)
			return { status: "ignored", reason: "payment_setup_missing" };
		return deferred(
			"payment_setup_claimed_elsewhere",
			new Date(now.getTime() + PAYMENT_SETUP_MIN_DEFER_MS),
		);
	}
	try {
		if (claimed.status === "completed") {
			return { status: "ignored", reason: "payment_setup_already_completed" };
		}
		if (claimed.status === "expired") {
			// Expiry was confirmed against the provider, so no later event can revive this setup.
			return { status: "ignored", reason: "payment_setup_already_expired" };
		}
		if (input.event.action === "expired") {
			if (claimed.status === "applying_default") {
				// The customer finished; an expiry that arrives afterwards is out of order.
				return { status: "ignored", reason: "payment_setup_already_completed_by_customer" };
			}
			await repository.expirePaymentSetup({ setupId: claimed.id, workerId: input.workerId });
			return { status: "processed" };
		}
		await completeSetupFromProvider(context, {
			setup: claimed,
			workerId: input.workerId,
			setupIntentId: input.event.setupIntentId,
			checkoutSessionId: input.event.checkoutSessionId,
		});
		return { status: "processed" };
	} finally {
		await repository.releasePaymentSetupClaim({
			setupId: input.event.setupId,
			workerId: input.workerId,
		});
	}
}

/**
 * Validates the provider's own record of the finished setup, then makes the saved card the
 * customer's invoice default. The intent is persisted before the write, so a crash retries the
 * same method, and completion is recorded only after the provider confirms it.
 */
async function completeSetupFromProvider(
	context: PaymentSetupContext,
	input: {
		setup: PaymentSetupRow;
		workerId: string;
		setupIntentId: string | null;
		/** The provider session the completion names, in case the creation response never landed. */
		checkoutSessionId?: string;
	},
): Promise<PaymentSetupRow> {
	const repository = requirePaymentSetupRepository(context.repository);
	const update = context.client.updateCustomerDefaultPaymentMethod?.bind(context.client);
	if (update === undefined) {
		throw new BillingError("Stripe customer updates are unavailable", "STRIPE_NOT_CONFIGURED", 503);
	}
	const resolved = await resolveSucceededSetupIntent(context, input.setup, input.setupIntentId);
	await repository.recordPaymentSetupIntent({
		setupId: input.setup.id,
		workerId: input.workerId,
		externalSetupIntentId: resolved.setupIntentId,
		paymentMethodId: resolved.paymentMethodId,
		externalSessionId: input.setup.external_session_id ?? input.checkoutSessionId ?? null,
	});
	await update({
		customerId: input.setup.provider_customer_id,
		paymentMethodId: resolved.paymentMethodId,
		idempotencyKey: `billing:payment-setup-default:${input.setup.id}:${resolved.paymentMethodId}`,
	});
	return await repository.completePaymentSetup({
		setupId: input.setup.id,
		workerId: input.workerId,
		paymentMethodId: resolved.paymentMethodId,
		card: resolved.card,
	});
}

interface ResolvedSetupIntent {
	setupIntentId: string;
	paymentMethodId: string;
	card: PaymentSetupCard | null;
}

/** Reads the SetupIntent and refuses anything that is not this customer's succeeded card setup. */
async function resolveSucceededSetupIntent(
	context: PaymentSetupContext,
	setup: PaymentSetupRow,
	setupIntentId: string | null,
): Promise<ResolvedSetupIntent> {
	const id =
		setupIntentId ??
		setup.external_setup_intent_id ??
		(await setupIntentFromSession(context, setup));
	if (id === null) {
		throw new BillingError(
			"Stripe hosted setup completed without a setup intent",
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			502,
		);
	}
	const retrieve = context.client.retrieveSetupIntent?.bind(context.client);
	if (retrieve === undefined) {
		throw new BillingError("Stripe setup intents are unavailable", "STRIPE_NOT_CONFIGURED", 503);
	}
	const intent = await retrieve(id);
	const status = optionalString(intent.status);
	if (status !== "succeeded") {
		throw new BillingError(
			`Stripe setup intent is ${status ?? "unknown"}, not succeeded`,
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			409,
		);
	}
	const customerId = optionalId(intent.customer);
	if (customerId !== setup.provider_customer_id) {
		throw new BillingError(
			"Stripe setup intent belongs to another customer",
			"STRIPE_PAYMENT_SETUP_MISMATCH",
			409,
		);
	}
	const paymentMethod = intent.payment_method;
	const paymentMethodId = optionalId(paymentMethod);
	if (paymentMethodId === null) {
		throw new BillingError(
			"Stripe setup intent saved no payment method",
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			502,
		);
	}
	const record = optionalRecord(paymentMethod);
	if (record === null)
		throw new BillingError(
			"Stripe setup intent payment method must be expanded",
			"STRIPE_PAYMENT_SETUP_INCOMPLETE",
			502,
		);
	const type = optionalString(record.type);
	if (type !== "card") {
		throw new BillingError(
			`Stripe hosted setup saved a ${type ?? "non-card"} payment method`,
			"STRIPE_PAYMENT_SETUP_UNSUPPORTED_METHOD",
			409,
		);
	}
	return { setupIntentId: id, paymentMethodId, card: cardSummary(record) };
}

async function setupIntentFromSession(
	context: PaymentSetupContext,
	setup: PaymentSetupRow,
): Promise<string | null> {
	const retrieve = context.client.retrieveSetupCheckoutSession?.bind(context.client);
	if (retrieve === undefined || setup.external_session_id === null) return null;
	const session = await retrieve(setup.external_session_id);
	return optionalId(session.setup_intent);
}

export interface PaymentSetupReconciliationInput {
	setupId: string;
	workerId: string;
	/** The reconciliation task's own attempt count, which decides when to stop absorbing failures. */
	attempts: number;
	/** Remaining failures are bounded by the actual replay worker configuration. */
	maxAttempts?: number;
}

/**
 * The single internal task that watches one setup: it recovers a creation whose response was lost,
 * catches a completion whose webhook never arrived, and confirms expiry with the provider before
 * the account's setup slot is released.
 */
export async function reconcilePaymentSetup(
	context: PaymentSetupContext,
	input: PaymentSetupReconciliationInput,
): Promise<StoreEventReplayProviderResult> {
	const repository = requirePaymentSetupRepository(context.repository);
	const now = context.now?.() ?? new Date();
	const claimed = await repository.claimPaymentSetup({
		setupId: input.setupId,
		workerId: input.workerId,
	});
	if (claimed === null) {
		const known = await repository.findPaymentSetupById?.(input.setupId);
		if (known === null || known === undefined) {
			return { status: "ignored", reason: "payment_setup_missing" };
		}
		return deferred(
			"payment_setup_claimed_elsewhere",
			new Date(now.getTime() + PAYMENT_SETUP_MIN_DEFER_MS),
		);
	}
	const exhausted =
		input.attempts + 1 >=
		Math.min(
			PAYMENT_SETUP_ATTENTION_ATTEMPTS,
			input.maxAttempts ?? PAYMENT_SETUP_ATTENTION_ATTEMPTS,
		);
	try {
		if (claimed.status === "completed" || claimed.status === "expired") {
			return { status: "processed" };
		}
		return await reconcileUnresolvedSetup(context, claimed, input, now);
	} catch (error) {
		// Past the failure budget the task stops consuming attempts: it records what is wrong and
		// keeps watching, so the setup stays visible and can still resolve itself.
		if (!exhausted) return { status: "retryable", reason: errorReason(error) };
		await repository.flagPaymentSetupAttention({
			setupId: claimed.id,
			workerId: input.workerId,
			reason: errorReason(error),
		});
		return deferred(errorReason(error), new Date(now.getTime() + PAYMENT_SETUP_ATTENTION_POLL_MS));
	} finally {
		await repository.releasePaymentSetupClaim({ setupId: input.setupId, workerId: input.workerId });
	}
}

async function reconcileUnresolvedSetup(
	context: PaymentSetupContext,
	setup: PaymentSetupRow,
	input: PaymentSetupReconciliationInput,
	now: Date,
): Promise<StoreEventReplayProviderResult> {
	const repository = requirePaymentSetupRepository(context.repository);
	if (setup.status === "creating") {
		if (!canIssueHostedSetupLink(setup, now)) {
			await repository.flagPaymentSetupAttention({
				setupId: setup.id,
				workerId: input.workerId,
				reason:
					"The hosted setup link was never confirmed and its creation or idempotency window has expired; it cannot be recreated safely.",
			});
			return deferred(
				"payment_setup_creation_unconfirmed",
				new Date(now.getTime() + PAYMENT_SETUP_ATTENTION_POLL_MS),
			);
		}
		// Within the retention window Stripe replays the original session for the frozen key.
		const issued = await issueHostedSetupLink(context, setup);
		return deferred("payment_setup_link_recovered", nextPollAt(issued.setup, now));
	}

	const session = await retrieveSession(context, setup);
	const providerStatus = session === null ? null : optionalString(session.status);
	if (providerStatus === "complete" || setup.status === "applying_default") {
		await completeSetupFromProvider(context, {
			setup,
			workerId: input.workerId,
			setupIntentId: session === null ? null : optionalId(session.setup_intent),
		});
		return { status: "processed" };
	}
	if (providerStatus === "expired") {
		await repository.expirePaymentSetup({ setupId: setup.id, workerId: input.workerId });
		return { status: "processed" };
	}
	// An unknown provider result cannot prove expiry. Keep uncertain setups visible and
	// retain their slot; a late completion can still apply a card saved before expiry.
	return deferred("payment_setup_awaiting_customer", nextPollAt(setup, now));
}

async function retrieveSession(
	context: PaymentSetupContext,
	setup: PaymentSetupRow,
): Promise<Record<string, unknown> | null> {
	const retrieve = context.client.retrieveSetupCheckoutSession?.bind(context.client);
	if (retrieve === undefined || setup.external_session_id === null) return null;
	return await retrieve(setup.external_session_id);
}

/** Polls on a steady rhythm, always landing once just after the link's own expiry. */
export function nextPollAt(setup: PaymentSetupRow, now: Date): Date {
	if (setup.status === "needs_attention")
		return new Date(now.getTime() + PAYMENT_SETUP_ATTENTION_POLL_MS);
	const expiry = new Date(setup.expires_at).getTime() + PAYMENT_SETUP_MIN_DEFER_MS;
	const poll = now.getTime() + PAYMENT_SETUP_POLL_INTERVAL_MS;
	if (expiry <= now.getTime()) return new Date(poll);
	const earliest = now.getTime() + PAYMENT_SETUP_MIN_DEFER_MS;
	return new Date(Math.max(earliest, Math.min(poll, expiry)));
}

async function scheduleReconciliation(
	context: PaymentSetupContext,
	setup: PaymentSetupRow,
	now: Date,
): Promise<void> {
	await context.repository.schedulePaymentSetupReconciliation?.({
		setupId: setup.id,
		nextAttemptAt: nextPollAt(setup, now),
	});
}

/** Return persisted state when an execution is retried after setup has already moved on. */
function creationFrom(setup: PaymentSetupRow, reused: boolean, now: Date): PaymentSetupCreation {
	const open =
		setup.status === "awaiting_customer" && new Date(setup.expires_at).getTime() > now.getTime();
	return {
		setupId: setup.id,
		status: setup.status,
		sessionId: setup.external_session_id,
		url: open ? setup.session_url : null,
		expiresAt: new Date(setup.expires_at).toISOString(),
		reused,
	};
}

function canIssueHostedSetupLink(setup: PaymentSetupRow, now: Date): boolean {
	return (
		now.getTime() - new Date(setup.created_at).getTime() < STRIPE_IDEMPOTENCY_RETENTION_MS &&
		new Date(setup.expires_at).getTime() - now.getTime() > PAYMENT_SETUP_CREATION_MARGIN_MS
	);
}

function paymentSetupMetadata(setup: PaymentSetupRow): Record<string, string> {
	return {
		billingAccountId: setup.billing_account_id,
		quotumOperation: PAYMENT_SETUP_OPERATION,
		[PAYMENT_SETUP_METADATA_KEY]: setup.id,
	};
}

function deferred(
	reason: string,
	nextAttemptAt: Date,
): Extract<StoreEventReplayProviderResult, { status: "deferred" }> {
	return { status: "deferred", reason, nextAttemptAt };
}

function cardSummary(paymentMethod: Record<string, unknown> | null): PaymentSetupCard | null {
	const card = paymentMethod === null ? null : optionalRecord(paymentMethod.card);
	if (card === null) return null;
	return {
		brand: optionalString(card.brand),
		last4: optionalString(card.last4),
		expMonth: optionalInteger(card.exp_month),
		expYear: optionalInteger(card.exp_year),
	};
}

/** The repository methods a setup needs, checked once; the object itself is returned unchanged. */
type RequiredPaymentSetupRepository = PaymentSetupRepositoryDependency &
	Required<
		Pick<
			PaymentSetupRepositoryDependency,
			| "reservePaymentSetup"
			| "recordPaymentSetupLink"
			| "claimPaymentSetup"
			| "releasePaymentSetupClaim"
			| "recordPaymentSetupIntent"
			| "completePaymentSetup"
			| "expirePaymentSetup"
			| "flagPaymentSetupAttention"
		>
	>;

const requiredPaymentSetupMethods = [
	"reservePaymentSetup",
	"recordPaymentSetupLink",
	"claimPaymentSetup",
	"releasePaymentSetupClaim",
	"recordPaymentSetupIntent",
	"completePaymentSetup",
	"expirePaymentSetup",
	"flagPaymentSetupAttention",
] as const satisfies ReadonlyArray<keyof PaymentSetupRepositoryDependency>;

function requirePaymentSetupRepository(
	repository: PaymentSetupRepositoryDependency,
): RequiredPaymentSetupRepository {
	// The same object is returned, never a copy: a class-based repository keeps its prototype.
	for (const method of requiredPaymentSetupMethods) {
		if (typeof repository[method] !== "function") {
			throw new BillingError(
				"Payment method setup is not configured",
				"STRIPE_NOT_CONFIGURED",
				503,
			);
		}
	}
	return repository as RequiredPaymentSetupRepository;
}

function errorReason(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== "") return error.message.slice(0, 500);
	return "Payment setup reconciliation failed";
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function optionalId(value: unknown): string | null {
	if (typeof value === "string") return optionalString(value);
	const record = optionalRecord(value);
	return record === null ? null : optionalString(record.id);
}
