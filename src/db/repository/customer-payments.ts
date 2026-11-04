import { sql as drizzleSql } from "drizzle-orm";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

/**
 * Whether the customer has paid real money that still stands. A free trial, a free checkout and a
 * payment refunded in full do not count. Unlike `customerHasPurchased`, which any purchase or
 * subscription row satisfies, this answers "is this a paying customer".
 *
 * A Stripe subscription payment is an invoice and writes no purchase; everything else is a
 * purchase. Google keeps one purchase row per token dated at the start of the trial, so a converted
 * trial shows only as a period that runs past the trial's end. It reads state rather than store
 * events because a replayed event is marked processed after its write commits, and a reconciled
 * renewal has another event type.
 */
export async function customerHasPaid(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<boolean> {
	const row = await executeOne<{ paid: boolean }>(
		executor,
		drizzleSql`
			SELECT (
				EXISTS (
					SELECT 1
					FROM billing_invoices invoice
					WHERE invoice.project_id = ${projectId}
						AND invoice.customer_id = ${customerId}
						AND invoice.external_subscription_id IS NOT NULL
						AND invoice.status = 'paid'
						AND invoice.amount_paid > invoice.reversed_amount
				)
				OR EXISTS (
					SELECT 1
					FROM purchases purchase
					LEFT JOIN subscriptions subscription
						ON subscription.project_id = purchase.project_id
						AND subscription.id = purchase.subscription_id
					WHERE purchase.project_id = ${projectId}
						AND purchase.customer_id = ${customerId}
						AND purchase.status = 'completed'
						AND (
							purchase.amount_paid_minor IS NULL
							OR purchase.amount_paid_minor > purchase.reversed_amount
						)
						AND NOT (
							purchase.amount_paid_minor IS NULL
							AND subscription.trial_end_at IS NOT NULL
							AND purchase.purchased_at < subscription.trial_end_at
						)
				)
				OR EXISTS (
					SELECT 1
					FROM subscriptions subscription
					WHERE subscription.project_id = ${projectId}
						AND subscription.customer_id = ${customerId}
						AND subscription.provider = 'google'
						AND subscription.status = 'active'
						AND subscription.current_period_end > subscription.trial_end_at
				)
			) AS paid
		`,
	);
	return row?.paid === true;
}
