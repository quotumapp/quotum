import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import type { PromotionTarget } from "../../billing/promotions";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

/**
 * Whether the customer has paid real money that still stands, for one of `targets` when there are
 * any. A free trial, a free checkout and a payment refunded in full do not count, unless
 * `countTrials` says a trial starting does. Unlike `customerHasPurchased`, which any purchase or
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
	options: { targets?: readonly PromotionTarget[]; countTrials?: boolean } = {},
): Promise<boolean> {
	const targets = options.targets ?? [];
	const row = await executeOne<{ paid: boolean }>(
		executor,
		drizzleSql`
			SELECT (
				EXISTS (
					SELECT 1
					FROM billing_invoices invoice
					LEFT JOIN subscriptions subscription
						ON subscription.project_id = invoice.project_id
						AND subscription.customer_id = invoice.customer_id
						AND subscription.external_subscription_id = invoice.external_subscription_id
					WHERE invoice.project_id = ${projectId}
						AND invoice.customer_id = ${customerId}
						AND invoice.external_subscription_id IS NOT NULL
						AND invoice.status = 'paid'
						AND invoice.amount_paid > invoice.reversed_amount
						AND ${targetCondition(projectId, targets, drizzleSql`subscription.product_id`)}
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
						AND ${targetCondition(projectId, targets, drizzleSql`purchase.product_id`)}
				)
				OR EXISTS (
					SELECT 1
					FROM subscriptions subscription
					WHERE subscription.project_id = ${projectId}
						AND subscription.customer_id = ${customerId}
						AND subscription.provider = 'google'
						AND subscription.status = 'active'
						AND subscription.current_period_end > subscription.trial_end_at
						AND ${targetCondition(projectId, targets, drizzleSql`subscription.product_id`)}
				)
				OR (
					${options.countTrials === true}
					AND EXISTS (
						SELECT 1
						FROM subscriptions subscription
						WHERE subscription.project_id = ${projectId}
							AND subscription.customer_id = ${customerId}
							AND subscription.trial_end_at IS NOT NULL
							AND ${targetCondition(projectId, targets, drizzleSql`subscription.product_id`)}
					)
				)
			) AS paid
		`,
	);
	return row?.paid === true;
}

/**
 * Whether the row in scope is for a target. It reads the `subscription` alias for a plan, which is
 * null for a one-time purchase, and `product` for a product. No targets means anything counts.
 */
function targetCondition(
	projectId: string,
	targets: readonly PromotionTarget[],
	product: DrizzleSQL,
): DrizzleSQL {
	if (targets.length === 0) return drizzleSql`true`;
	const keys = (kind: PromotionTarget["kind"]) =>
		drizzleSql.join(
			[...targets.filter((target) => target.kind === kind).map((target) => target.key), ""].map(
				(key) => drizzleSql`${key}`,
			),
			drizzleSql`, `,
		);
	return drizzleSql`(
		EXISTS (
			SELECT 1
			FROM plan_versions version
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			WHERE version.project_id = ${projectId}
				AND version.id = subscription.plan_version_id
				AND plan.key IN (${keys("plan")})
		)
		OR EXISTS (
			SELECT 1
			FROM products target_product
			WHERE target_product.project_id = ${projectId}
				AND target_product.id = ${product}
				AND target_product.key IN (${keys("product")})
		)
	)`;
}
