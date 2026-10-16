import { sql as drizzleSql } from "drizzle-orm";
import { NotFoundBillingError, PersistenceConflictError } from "../../billing/errors";
import type {
	RefundBasis,
	RefundMode,
	RefundRequest,
	RefundRequestStatus,
	RefundTargetKind,
} from "../../billing/refunds";
import type { BillingProvider, PurchaseKind, PurchaseStatus } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import { stripeInvoiceView } from "../../providers/stripe/invoice-view";
import { sqlstateOf } from "../postgres-errors";
import { RepositoryModule } from "./base";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

/** The most recent paid invoice of a subscription and what earlier refunds already returned. */
export interface SubscriptionPaymentRefundFacts {
	customerId: string;
	subscriptionId: string;
	externalSubscriptionId: string;
	externalInvoiceId: string;
	amountPaidMinor: number;
	refundedMinor: number;
	currency: string;
	/** The service period of the invoice's advance-billed lines; null when its payload names none. */
	periodStart: Date | null;
	periodEnd: Date | null;
	openRequestId: string | null;
}

/** A purchase, the credit it funded and what has been refunded or used since. */
export interface PurchaseRefundFacts {
	customerId: string;
	purchaseId: string;
	provider: BillingProvider;
	purchaseKind: PurchaseKind;
	status: PurchaseStatus;
	/** The Stripe PaymentIntent id; any other shape (a Checkout Session id) is not refundable. */
	transactionId: string;
	amountPaidMinor: number | null;
	refundedMinor: number;
	currency: string | null;
	/** Credit the purchase granted and the part of it still unspent; null without an allocation. */
	creditQuantity: string | null;
	unconsumedQuantity: string | null;
	/** The refund amount for the unspent share, rounded down; null without an allocation. */
	unconsumedShareMinor: number | null;
	openRequestId: string | null;
}

export interface ClaimRefundRequestInput {
	billingAccountId: string;
	previewToken: string;
	targetKind: RefundTargetKind;
	externalInvoiceId: string | null;
	purchaseId: string | null;
	providerPaymentId: string;
	amountMinor: number;
	currency: string;
	mode: RefundMode;
	basis: RefundBasis;
	cancelImmediately: boolean;
	reason: string;
	executionIdempotencyKey: string;
	providerIdempotencyKey: string;
}

export interface RecordRefundOutcomeInput {
	requestId: string;
	status: RefundRequestStatus;
	providerRefundId?: string | null;
	failureCode?: string | null;
}

interface RefundRequestRow {
	id: string;
	billing_account_id: string;
	provider: BillingProvider;
	target_kind: RefundTargetKind;
	external_invoice_id: string | null;
	purchase_id: string | null;
	provider_payment_id: string;
	amount_minor: string | number;
	currency: string;
	mode: RefundMode;
	basis: RefundBasis;
	cancel_immediately: boolean;
	reason: string;
	status: RefundRequestStatus;
	provider_refund_id: string | null;
	failure_code: string | null;
	created_at: Date | string;
	updated_at: Date | string;
	completed_at: Date | string | null;
	provider_idempotency_key: string;
}

const refundColumns = drizzleSql`
	id, billing_account_id, provider, target_kind, external_invoice_id, purchase_id,
	provider_payment_id, amount_minor, currency, mode, basis, cancel_immediately, reason, status,
	provider_refund_id, failure_code, created_at, updated_at, completed_at, provider_idempotency_key
`;

export class RefundRequestRepository extends RepositoryModule {
	/** The latest paid invoice of a Stripe subscription, which is the payment a refund draws on. */
	async readSubscriptionPaymentForRefund(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; externalSubscriptionId: string },
	): Promise<SubscriptionPaymentRefundFacts> {
		const projectId = project.projectInstanceId;
		const subscription = await executeOne<{
			subscription_id: string;
			customer_id: string;
			external_subscription_id: string;
		}>(
			this.database,
			drizzleSql`
				SELECT subscription.id AS subscription_id, customer.id AS customer_id,
					subscription.external_subscription_id
				FROM customers customer
				JOIN subscriptions subscription
					ON subscription.project_id = customer.project_id AND subscription.customer_id = customer.id
				WHERE customer.project_id = ${projectId}
					AND customer.billing_account_id = ${input.billingAccountId}
					AND subscription.external_subscription_id = ${input.externalSubscriptionId}
					AND subscription.provider = 'stripe'
				LIMIT 1
			`,
		);
		if (subscription === null) {
			throw new NotFoundBillingError(
				"Stripe subscription was not found",
				"SUBSCRIPTION_CHANGE_TARGET_NOT_FOUND",
			);
		}
		const invoice = await executeOne<{
			external_invoice_id: string;
			amount_paid: string;
			reversed_amount: string;
			currency: string;
			provider_created_at: Date | string;
			raw_payload: unknown;
		}>(
			this.database,
			drizzleSql`
				SELECT external_invoice_id, amount_paid::text AS amount_paid,
					reversed_amount::text AS reversed_amount, currency, provider_created_at, raw_payload
				FROM billing_invoices
				WHERE project_id = ${projectId} AND subscription_id = ${subscription.subscription_id}
					AND status = 'paid' AND amount_paid > 0
				ORDER BY last_provider_event_created DESC, id DESC
				LIMIT 1
			`,
		);
		if (invoice === null) {
			throw new PersistenceConflictError(
				"The subscription has no paid invoice to refund",
				"PAYMENT_NOT_REFUNDABLE",
			);
		}
		const period = advanceServicePeriod(invoice.provider_created_at, invoice.raw_payload);
		return {
			customerId: subscription.customer_id,
			subscriptionId: subscription.subscription_id,
			externalSubscriptionId: subscription.external_subscription_id,
			externalInvoiceId: invoice.external_invoice_id,
			amountPaidMinor: Number(invoice.amount_paid),
			refundedMinor: Number(invoice.reversed_amount),
			currency: invoice.currency.toLowerCase(),
			periodStart: period?.start ?? null,
			periodEnd: period?.end ?? null,
			openRequestId: await this.openRequestId(
				this.database,
				projectId,
				"stripe",
				// An invoice payment is matched through its PaymentIntent once it is resolved; before
				// that the invoice id is what an earlier request recorded.
				{ externalInvoiceId: invoice.external_invoice_id },
			),
		};
	}

	/** One purchase of the account, with the credit it funded measured from its allocations. */
	async readPurchaseForRefund(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; purchaseId: string },
	): Promise<PurchaseRefundFacts> {
		const projectId = project.projectInstanceId;
		const row = await executeOne<{
			customer_id: string;
			purchase_id: string;
			provider: BillingProvider;
			purchase_kind: PurchaseKind;
			status: PurchaseStatus;
			transaction_id: string;
			amount_paid_minor: string | null;
			reversed_amount: string;
			currency: string | null;
			credit_quantity: string | null;
			unconsumed_quantity: string | null;
			unconsumed_share: string | null;
		}>(
			this.database,
			drizzleSql`
				SELECT
					purchase.customer_id, purchase.id AS purchase_id, purchase.provider,
					purchase.purchase_kind, purchase.status, purchase.transaction_id,
					purchase.amount_paid_minor::text AS amount_paid_minor,
					purchase.reversed_amount::text AS reversed_amount, purchase.currency,
					credit.quantity::text AS credit_quantity,
					credit.unconsumed::text AS unconsumed_quantity,
					CASE
						WHEN credit.quantity > 0 AND purchase.amount_paid_minor IS NOT NULL
							THEN floor(purchase.amount_paid_minor * credit.unconsumed / credit.quantity)::text
					END AS unconsumed_share
				FROM purchases purchase
				JOIN customers customer
					ON customer.project_id = purchase.project_id AND customer.id = purchase.customer_id
				LEFT JOIN LATERAL (
					SELECT sum(allocation.quantity) AS quantity,
						sum(greatest(
							allocation.quantity - allocation.reversed_quantity - allocation.consumed_quantity
								- allocation.held_quantity, 0
						)) AS unconsumed
					FROM balance_allocations allocation
					WHERE allocation.project_id = purchase.project_id AND allocation.purchase_id = purchase.id
					HAVING count(*) > 0
				) credit ON true
				WHERE purchase.project_id = ${projectId}
					AND customer.billing_account_id = ${input.billingAccountId}
					AND purchase.id = ${input.purchaseId}::uuid
				LIMIT 1
			`,
		);
		if (row === null) {
			throw new NotFoundBillingError("Purchase was not found", "PURCHASE_NOT_FOUND");
		}
		return {
			customerId: row.customer_id,
			purchaseId: row.purchase_id,
			provider: row.provider,
			purchaseKind: row.purchase_kind,
			status: row.status,
			transactionId: row.transaction_id,
			amountPaidMinor: row.amount_paid_minor === null ? null : Number(row.amount_paid_minor),
			refundedMinor: Number(row.reversed_amount),
			currency: row.currency === null ? null : row.currency.toLowerCase(),
			creditQuantity: row.credit_quantity,
			unconsumedQuantity: row.unconsumed_quantity,
			unconsumedShareMinor: row.unconsumed_share === null ? null : Number(row.unconsumed_share),
			openRequestId: await this.openRequestId(this.database, projectId, "stripe", {
				providerPaymentId: row.transaction_id,
			}),
		};
	}

	async findRefundRequestForPreview(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; previewToken: string },
	): Promise<RefundRequest | null> {
		const row = await executeOne<RefundRequestRow>(
			this.database,
			drizzleSql`
				SELECT ${refundColumns} FROM refund_requests
				WHERE project_id = ${project.projectInstanceId}
					AND billing_account_id = ${input.billingAccountId}
					AND preview_token = ${input.previewToken}::uuid
			`,
		);
		return row === null ? null : refundRequest(row);
	}

	/**
	 * Records the request before the provider is asked. A request already recorded for the preview
	 * is returned as it stands, which is how a retry finds what an earlier attempt did; a payment
	 * that already has an open request refuses a second one.
	 */
	async claimRefundRequest(
		project: ProjectInstanceContext,
		input: ClaimRefundRequestInput,
	): Promise<{ request: RefundRequest; created: boolean }> {
		const projectId = project.projectInstanceId;
		const existing = await this.findRefundRequestForPreview(project, input);
		if (existing !== null) return { request: existing, created: false };
		try {
			const row = await executeOne<RefundRequestRow>(
				this.database,
				drizzleSql`
					INSERT INTO refund_requests (
						project_id, customer_id, billing_account_id, provider, preview_token, target_kind,
						external_invoice_id, purchase_id, provider_payment_id, amount_minor, currency, mode,
						basis, cancel_immediately, reason, execution_idempotency_key, provider_idempotency_key
					)
					SELECT
						customer.project_id, customer.id, customer.billing_account_id, 'stripe',
						${input.previewToken}::uuid, ${input.targetKind}, ${input.externalInvoiceId},
						${input.purchaseId}::uuid, ${input.providerPaymentId}, ${input.amountMinor},
						${input.currency}, ${input.mode}, ${input.basis}, ${input.cancelImmediately},
						${input.reason}, ${input.executionIdempotencyKey}, ${input.providerIdempotencyKey}
					FROM customers customer
					WHERE customer.project_id = ${projectId}
						AND customer.billing_account_id = ${input.billingAccountId}
					RETURNING ${refundColumns}
				`,
			);
			if (row === null) throw new Error("Refund request was not recorded");
			return { request: refundRequest(row), created: true };
		} catch (error) {
			if (sqlstateOf(error) !== "23505") throw error;
			// Two executions of one preview race to the unique preview key; the loser reads the winner.
			const raced = await this.findRefundRequestForPreview(project, input);
			if (raced !== null) return { request: raced, created: false };
			throw new PersistenceConflictError(
				"The payment already has a refund in progress",
				"REFUND_ALREADY_OPEN",
			);
		}
	}

	/** Records what the provider answered. A final state is never moved by a later answer. */
	async recordRefundOutcome(
		project: ProjectInstanceContext,
		input: RecordRefundOutcomeInput,
	): Promise<RefundRequest> {
		const row = await executeOne<RefundRequestRow>(
			this.database,
			drizzleSql`
				UPDATE refund_requests
				SET status = ${input.status},
					provider_refund_id = COALESCE(${input.providerRefundId ?? null}, provider_refund_id),
					failure_code = ${input.failureCode ?? null},
					completed_at = CASE
						WHEN ${input.status} IN ('succeeded', 'failed') THEN COALESCE(completed_at, now())
					END,
					updated_at = now()
				WHERE project_id = ${project.projectInstanceId} AND id = ${input.requestId}::uuid
					AND status IN ('requested', 'pending', 'requires_review')
				RETURNING ${refundColumns}
			`,
		);
		if (row !== null) return refundRequest(row);
		const settled = await this.getRefundRequest(project, input.requestId);
		if (settled === null) throw new Error("Refund request was not found");
		return settled;
	}

	async getRefundRequest(
		project: ProjectInstanceContext,
		requestId: string,
	): Promise<RefundRequest | null> {
		const row = await executeOne<RefundRequestRow>(
			this.database,
			drizzleSql`
				SELECT ${refundColumns} FROM refund_requests
				WHERE project_id = ${project.projectInstanceId} AND id = ${requestId}::uuid
			`,
		);
		return row === null ? null : refundRequest(row);
	}

	/** The newest first requests of a billing account. */
	async listRefundRequests(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; limit: number },
	): Promise<RefundRequest[]> {
		const rows = await executeRows<RefundRequestRow>(
			this.database,
			drizzleSql`
				SELECT ${refundColumns} FROM refund_requests
				WHERE project_id = ${project.projectInstanceId}
					AND billing_account_id = ${input.billingAccountId}
				ORDER BY created_at DESC, id DESC
				LIMIT ${input.limit}
			`,
		);
		return rows.map(refundRequest);
	}

	/**
	 * The provider's own word on a refund Quotum asked for, from its refund events: the refund the
	 * request created moves to the state the provider reports. A refund this repository did not
	 * request, such as one made in the provider's dashboard, matches nothing and is left alone.
	 */
	async applyProviderRefundState(
		project: ProjectInstanceContext,
		input: {
			requestId: string | null;
			providerRefundId: string;
			outcome: "pending" | "succeeded" | "failed";
			failureCode: string | null;
		},
	): Promise<RefundRequest | null> {
		const row = await executeOne<RefundRequestRow>(
			this.database,
			drizzleSql`
				UPDATE refund_requests
				SET status = ${input.outcome},
					provider_refund_id = COALESCE(provider_refund_id, ${input.providerRefundId}),
					failure_code = ${input.outcome === "failed" ? input.failureCode : null},
					completed_at = CASE
						WHEN ${input.outcome} IN ('succeeded', 'failed') THEN COALESCE(completed_at, now())
					END,
					updated_at = now()
				WHERE project_id = ${project.projectInstanceId}
					AND (
						provider_refund_id = ${input.providerRefundId}
						OR (${input.requestId}::uuid IS NOT NULL AND id = ${input.requestId}::uuid)
					)
					AND (provider_refund_id IS NULL OR provider_refund_id = ${input.providerRefundId})
					AND status IN ('requested', 'pending', 'requires_review')
				RETURNING ${refundColumns}
			`,
		);
		return row === null ? null : refundRequest(row);
	}

	private async openRequestId(
		executor: QueryExecutor,
		projectId: string,
		provider: "stripe",
		match: { externalInvoiceId?: string; providerPaymentId?: string },
	): Promise<string | null> {
		const row = await executeOne<{ id: string }>(
			executor,
			drizzleSql`
				SELECT id FROM refund_requests
				WHERE project_id = ${projectId} AND provider = ${provider}
					AND status IN ('requested', 'pending', 'requires_review')
					AND (
						(${match.externalInvoiceId ?? null}::text IS NOT NULL
							AND external_invoice_id = ${match.externalInvoiceId ?? null})
						OR (${match.providerPaymentId ?? null}::text IS NOT NULL
							AND provider_payment_id = ${match.providerPaymentId ?? null})
					)
				LIMIT 1
			`,
		);
		return row?.id ?? null;
	}
}

function refundRequest(row: RefundRequestRow): RefundRequest {
	return {
		id: row.id,
		billingAccountId: row.billing_account_id,
		provider: row.provider,
		targetKind: row.target_kind,
		externalInvoiceId: row.external_invoice_id,
		purchaseId: row.purchase_id,
		providerPaymentId: row.provider_payment_id,
		amountMinor: Number(row.amount_minor),
		currency: row.currency,
		mode: row.mode,
		basis: row.basis,
		cancelImmediately: row.cancel_immediately,
		reason: row.reason,
		status: row.status,
		providerRefundId: row.provider_refund_id,
		failureCode: row.failure_code,
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
		completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
		providerIdempotencyKey: row.provider_idempotency_key,
	};
}

/**
 * The period an invoice's advance-billed subscription lines cover: lines of a finished period
 * (usage billed in arrears) and proration lines name periods other invoices paid for.
 */
export function advanceServicePeriod(
	invoiceCreatedAt: Date | string,
	payload: unknown,
): { start: Date; end: Date } | null {
	const createdAt = new Date(invoiceCreatedAt).getTime();
	const periods = stripeInvoiceView(payload).lines.flatMap((line) => {
		if (line.proration === true || line.periodStart === null || line.periodEnd === null) return [];
		const start = Date.parse(line.periodStart);
		const end = Date.parse(line.periodEnd);
		return start < end && end > createdAt ? [{ start, end }] : [];
	});
	if (periods.length === 0) return null;
	const start = Math.max(...periods.map((period) => period.start));
	const end = Math.max(
		...periods.filter((period) => period.start === start).map((period) => period.end),
	);
	return { start: new Date(start), end: new Date(end) };
}
