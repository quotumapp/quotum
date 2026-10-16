/**
 * Refunds Quotum asks Stripe for. A refund is previewed against local payment facts, recorded as a
 * request before Stripe is called, and sent under a key derived from the execution, so a crashed or
 * repeated execution resumes the same request instead of issuing a second refund. Nothing here
 * touches balances: the credits a refund reverses follow Stripe's refund event, through the same
 * path as a refund made in the Stripe dashboard.
 */

import type { CommercialActionIntent, CommercialPreviewRefund } from "../../billing/commercial";
import { BillingError } from "../../billing/errors";
import {
	type RefundBasis,
	type RefundRequest,
	type RefundRequestStatus,
	remainingTimeRefundMinor,
} from "../../billing/refunds";
import type {
	ClaimRefundRequestInput,
	PurchaseRefundFacts,
	RecordRefundOutcomeInput,
	SubscriptionPaymentRefundFacts,
} from "../../db/repository/refund-requests";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Carried on the Stripe refund so its events find the request that created it. */
export const REFUND_METADATA_KEY = "quotumRefundRequestId";

/**
 * How long a request may be sent again under its original key. Stripe keeps an idempotency key for
 * 24 hours; past half of that the request is looked up instead of repeated.
 */
export const REFUND_RESEND_WINDOW_MS = 12 * 60 * 60 * 1000;

export type RefundIntent = Extract<CommercialActionIntent, { kind: "refund" }>;

/** The part of a Stripe refund the service reads. */
export interface StripeRefundAnswer {
	id: string;
	status: string | null;
	currency?: string | null;
	failure_reason?: string | null;
	metadata?: Record<string, string> | null;
}

export interface RefundClientDependency {
	findPaymentIntentForInvoice?(invoiceId: string): Promise<string | null>;
	createRefund?(
		params: { paymentIntentId: string; amountMinor: number; metadata: Record<string, string> },
		idempotencyKey: string,
	): Promise<StripeRefundAnswer>;
	listPaymentIntentRefunds?(paymentIntentId: string): Promise<StripeRefundAnswer[]>;
}

export interface RefundRepositoryDependency {
	readSubscriptionPaymentForRefund?(input: {
		billingAccountId: string;
		externalSubscriptionId: string;
	}): Promise<SubscriptionPaymentRefundFacts>;
	readPurchaseForRefund?(input: {
		billingAccountId: string;
		purchaseId: string;
	}): Promise<PurchaseRefundFacts>;
	claimRefundRequest?(
		input: ClaimRefundRequestInput,
	): Promise<{ request: RefundRequest; created: boolean }>;
	recordRefundOutcome?(input: RecordRefundOutcomeInput): Promise<RefundRequest>;
	applyProviderRefundState?(input: {
		requestId: string | null;
		providerRefundId: string;
		outcome: "pending" | "succeeded" | "failed";
		failureCode: string | null;
	}): Promise<RefundRequest | null>;
}

interface RefundDependencies {
	client: RefundClientDependency;
	repository: RefundRepositoryDependency;
}

/** What a preview needs: the figures the caller sees and the facts that bind the execution. */
export interface ResolvedRefund {
	refund: CommercialPreviewRefund;
	/** Everything the refund amount was measured from, hashed into the state fingerprint. */
	fingerprintFacts: Record<string, unknown>;
}

export async function resolveRefundPreview(
	dependencies: RefundDependencies,
	billingAccountId: string,
	intent: RefundIntent,
	now: Date,
): Promise<ResolvedRefund> {
	const { client, repository } = dependencies;
	if (intent.target.type === "subscription_payment") {
		const read = repository.readSubscriptionPaymentForRefund;
		if (read === undefined || client.findPaymentIntentForInvoice === undefined) {
			throw notConfigured();
		}
		const facts = await read.call(repository, {
			billingAccountId,
			externalSubscriptionId: intent.target.externalSubscriptionId,
		});
		if (facts.openRequestId !== null) throw refundAlreadyOpen(facts.openRequestId);
		const paymentIntentId = await client.findPaymentIntentForInvoice(facts.externalInvoiceId);
		if (paymentIntentId === null) {
			throw new BillingError(
				"The invoice was not paid by a payment Stripe can refund",
				"PAYMENT_NOT_REFUNDABLE",
				409,
			);
		}
		const refundable = refundableAmount(facts.amountPaidMinor, facts.refundedMinor);
		let amount = refundable;
		let basis: RefundBasis = "full";
		if (intent.mode === "prorated") {
			basis = "remaining_time";
			if (facts.periodStart === null || facts.periodEnd === null) {
				throw new BillingError(
					"The invoice names no service period to prorate by; refund it in full",
					"REFUND_NOT_PRORATABLE",
					409,
				);
			}
			amount = remainingTimeRefundMinor({
				paidMinor: facts.amountPaidMinor,
				refundableMinor: refundable,
				periodStart: facts.periodStart,
				periodEnd: facts.periodEnd,
				now,
			});
		}
		assertSomethingToRefund(amount);
		return {
			refund: {
				targetKind: "subscription_payment",
				externalInvoiceId: facts.externalInvoiceId,
				purchaseId: null,
				providerPaymentId: paymentIntentId,
				currency: facts.currency,
				amountPaidMinor: facts.amountPaidMinor,
				refundedMinor: facts.refundedMinor,
				refundableMinor: refundable,
				refundAmountMinor: amount,
				basis,
				cancelsSubscriptionId:
					intent.cancelImmediately === true ? facts.externalSubscriptionId : null,
			},
			fingerprintFacts: {
				invoice: facts.externalInvoiceId,
				paymentIntent: paymentIntentId,
				paid: facts.amountPaidMinor,
				refunded: facts.refundedMinor,
				currency: facts.currency,
			},
		};
	}

	const read = repository.readPurchaseForRefund;
	if (read === undefined) throw notConfigured();
	const facts = await read.call(repository, {
		billingAccountId,
		purchaseId: intent.target.purchaseId,
	});
	if (facts.provider !== "stripe") {
		throw new BillingError(
			`${facts.provider === "apple" ? "Apple" : facts.provider === "google" ? "Google Play" : "The store"} decides refunds of its own purchases; Quotum mirrors them`,
			"REFUND_PROVIDER_MANAGED",
			409,
		);
	}
	if (
		facts.purchaseKind === "subscription" ||
		facts.status !== "completed" ||
		facts.amountPaidMinor === null ||
		facts.currency === null ||
		!facts.transactionId.startsWith("pi_")
	) {
		throw new BillingError(
			"The purchase was not paid by a payment Stripe can refund",
			"PAYMENT_NOT_REFUNDABLE",
			409,
		);
	}
	if (facts.openRequestId !== null) throw refundAlreadyOpen(facts.openRequestId);
	const refundable = refundableAmount(facts.amountPaidMinor, facts.refundedMinor);
	let amount = refundable;
	let basis: RefundBasis = "full";
	if (intent.mode === "prorated") {
		basis = "unconsumed_credit";
		if (facts.unconsumedShareMinor === null) {
			throw new BillingError(
				"The purchase funded no credit to prorate by; refund it in full",
				"REFUND_NOT_PRORATABLE",
				409,
			);
		}
		amount = Math.min(facts.unconsumedShareMinor, refundable);
	}
	assertSomethingToRefund(amount);
	return {
		refund: {
			targetKind: "purchase",
			externalInvoiceId: null,
			purchaseId: facts.purchaseId,
			providerPaymentId: facts.transactionId,
			currency: facts.currency,
			amountPaidMinor: facts.amountPaidMinor,
			refundedMinor: facts.refundedMinor,
			refundableMinor: refundable,
			refundAmountMinor: amount,
			basis,
			cancelsSubscriptionId: null,
		},
		fingerprintFacts: {
			purchase: facts.purchaseId,
			paymentIntent: facts.transactionId,
			paid: facts.amountPaidMinor,
			refunded: facts.refundedMinor,
			currency: facts.currency,
			status: facts.status,
		},
	};
}

export interface IssueRefundInput {
	billingAccountId: string;
	previewToken: string;
	/** The caller's key for the execution, kept with the request. */
	idempotencyKey: string;
	/** The key Stripe sees, derived from the execution so a repeated execution repeats it. */
	providerIdempotencyKey: string;
	intent: RefundIntent;
	refund: CommercialPreviewRefund;
	now?: Date;
}

/**
 * Records the request, then asks Stripe for it. Returns the request once Stripe accepted it, as
 * `pending` or `succeeded`. A request Stripe refused, or whose outcome cannot be established, is
 * recorded as such and raised as an error; the same execution repeats the same answer.
 */
export async function issueRefund(
	dependencies: RefundDependencies,
	input: IssueRefundInput,
): Promise<RefundRequest> {
	const { repository } = dependencies;
	if (repository.claimRefundRequest === undefined || repository.recordRefundOutcome === undefined) {
		throw notConfigured();
	}
	const { refund } = input;
	const claimed = await repository.claimRefundRequest({
		billingAccountId: input.billingAccountId,
		previewToken: input.previewToken,
		targetKind: refund.targetKind,
		externalInvoiceId: refund.externalInvoiceId,
		purchaseId: refund.purchaseId,
		providerPaymentId: refund.providerPaymentId,
		amountMinor: refund.refundAmountMinor,
		currency: refund.currency,
		mode: input.intent.mode,
		basis: refund.basis,
		cancelImmediately: input.intent.cancelImmediately === true,
		reason: input.intent.reason,
		executionIdempotencyKey: input.idempotencyKey,
		providerIdempotencyKey: input.providerIdempotencyKey,
	});
	let request = claimed.request;
	if (request.status === "requested") {
		request = await requestFromStripe(dependencies, request, input.now ?? new Date());
	}
	if (request.status === "failed") {
		throw new BillingError("Stripe refused the refund", "REFUND_REJECTED_BY_PROVIDER", 409, {
			details: { refundRequestId: request.id, providerCode: request.failureCode },
		});
	}
	if (request.status === "requires_review") {
		throw new BillingError(
			"Whether Stripe created the refund could not be established; an operator must check Stripe",
			"REFUND_RECONCILIATION_REQUIRED",
			409,
			{ details: { refundRequestId: request.id } },
		);
	}
	return request;
}

async function requestFromStripe(
	dependencies: RefundDependencies,
	request: RefundRequest,
	now: Date,
): Promise<RefundRequest> {
	const { client, repository } = dependencies;
	const { createRefund, listPaymentIntentRefunds } = client;
	const record = repository.recordRefundOutcome;
	if (
		createRefund === undefined ||
		listPaymentIntentRefunds === undefined ||
		record === undefined
	) {
		throw notConfigured();
	}
	// Past the resend window Stripe may have forgotten the key, so the same request is looked up and
	// never sent again: a second send could return the money twice.
	if (now.getTime() - Date.parse(request.createdAt) >= REFUND_RESEND_WINDOW_MS) {
		const refunds = await listPaymentIntentRefunds.call(client, request.providerPaymentId);
		const found = refunds.find(
			(candidate) => candidate.metadata?.[REFUND_METADATA_KEY] === request.id,
		);
		if (found === undefined) {
			return await record.call(repository, {
				requestId: request.id,
				status: "requires_review",
				failureCode: "unconfirmed",
			});
		}
		return await record.call(repository, outcomeOf(request.id, found));
	}
	let answer: StripeRefundAnswer;
	try {
		answer = await createRefund.call(
			client,
			{
				paymentIntentId: request.providerPaymentId,
				amountMinor: request.amountMinor,
				metadata: { [REFUND_METADATA_KEY]: request.id },
			},
			request.providerIdempotencyKey,
		);
	} catch (error) {
		const refusal = stripeRefusal(error);
		// A timeout or server error may have created the refund; the request stays `requested` and
		// the same execution sends it again under the same key.
		if (refusal === null) throw error;
		return await record.call(repository, {
			requestId: request.id,
			status: "failed",
			failureCode: refusal,
		});
	}
	return await record.call(repository, outcomeOf(request.id, answer));
}

function outcomeOf(requestId: string, answer: StripeRefundAnswer): RecordRefundOutcomeInput {
	return {
		requestId,
		providerRefundId: answer.id,
		...refundState(answer.status, answer.failure_reason ?? null),
	};
}

/** Stripe's refund status as the request's state: only `succeeded` and `failed` are final. */
export function refundState(
	status: string | null,
	failureReason: string | null,
): { status: Exclude<RefundRequestStatus, "requested" | "requires_review">; failureCode?: string } {
	if (status === "succeeded") return { status: "succeeded" };
	if (status === "failed" || status === "canceled") {
		return { status: "failed", failureCode: failureReason ?? status };
	}
	return { status: "pending" };
}

/**
 * The code of a refusal that proves Stripe did not create the refund: a client error that is not a
 * rate limit or a reused idempotency key. Anything else leaves the outcome open.
 */
function stripeRefusal(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	// stripe-node's `type` is the error class and `rawType` is Stripe's own error type.
	const record = error as {
		statusCode?: unknown;
		type?: unknown;
		rawType?: unknown;
		code?: unknown;
		raw?: { code?: unknown };
	};
	if (typeof record.statusCode !== "number") return null;
	if (record.statusCode < 400 || record.statusCode >= 500 || record.statusCode === 429) return null;
	if (record.type === "StripeIdempotencyError" || record.rawType === "idempotency_error")
		return null;
	const code = record.code ?? record.raw?.code ?? record.rawType;
	return typeof code === "string" && code !== "" ? code.slice(0, 80) : `http_${record.statusCode}`;
}

function refundableAmount(paid: number, refunded: number): number {
	return Math.max(0, paid - refunded);
}

function assertSomethingToRefund(amount: number): void {
	if (amount <= 0) {
		throw new BillingError("There is nothing left to refund", "REFUND_NOTHING_REFUNDABLE", 409);
	}
}

function refundAlreadyOpen(requestId: string): BillingError {
	return new BillingError(
		"The payment already has a refund in progress",
		"REFUND_ALREADY_OPEN",
		409,
		{
			details: { refundRequestId: requestId },
		},
	);
}

function notConfigured(): BillingError {
	return new BillingError("Refunds are not configured", "STRIPE_NOT_CONFIGURED", 503);
}

/** A Stripe refund object's request id and state, or null when it is not one Quotum can place. */
export function refundEventState(object: Record<string, unknown>): {
	requestId: string | null;
	providerRefundId: string;
	outcome: "pending" | "succeeded" | "failed";
	failureCode: string | null;
} | null {
	const id = typeof object.id === "string" && object.id !== "" ? object.id : null;
	if (id === null) return null;
	const metadata =
		typeof object.metadata === "object" && object.metadata !== null
			? (object.metadata as Record<string, unknown>)
			: {};
	const requestId = metadata[REFUND_METADATA_KEY];
	const state = refundState(
		typeof object.status === "string" ? object.status : null,
		typeof object.failure_reason === "string" ? object.failure_reason : null,
	);
	return {
		// Metadata is free text in Stripe; only a UUID can name one of our requests.
		requestId: typeof requestId === "string" && uuidPattern.test(requestId) ? requestId : null,
		providerRefundId: id,
		outcome: state.status,
		failureCode: state.failureCode ?? null,
	};
}
