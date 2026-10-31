import { sql as drizzleSql } from "drizzle-orm";
import type {
	AffiliateCustomerPage,
	AffiliateServiceLike,
	AffiliateSummary,
} from "../../billing/affiliates";
import type { BillingProvider } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { executeOne, executeRows } from "./query";

export class AffiliateRepository extends RepositoryModule implements AffiliateServiceLike {
	async recordAffiliateKey(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; affiliateKey: string },
	): Promise<void> {
		await executeRows(
			this.database,
			drizzleSql`
				UPDATE customers
				SET affiliate_key = ${input.affiliateKey}, affiliate_key_set_at = now(), updated_at = now()
				WHERE project_id = ${project.projectInstanceId}
					AND billing_account_id = ${input.billingAccountId}
					AND affiliate_key IS NULL
					AND erased_at IS NULL
			`,
		);
	}

	async getAffiliateSummary(
		project: ProjectInstanceContext,
		affiliateKey: string,
	): Promise<AffiliateSummary> {
		const projectId = project.projectInstanceId;
		const referred = await executeOne<{ customers: string }>(
			this.database,
			drizzleSql`
				SELECT count(*)::text AS customers
				FROM customers
				WHERE project_id = ${projectId} AND affiliate_key = ${affiliateKey}
			`,
		);
		// Stripe subscriptions and automatic top-ups are paid invoices; a top-up also has a purchase
		// row, which the invoice match skips. Store products have one catalog price, so an App Store
		// or Google Play amount is that price per payment. Google overwrites one purchase row per
		// token, so its renewals come from their notifications, and a free trial row is no payment.
		const rows = await executeRows<{
			provider: BillingProvider;
			currency: string | null;
			estimated: boolean;
			payments: string;
			amount_minor: string | null;
		}>(
			this.database,
			drizzleSql`
				WITH referred AS (
					SELECT id
					FROM customers
					WHERE project_id = ${projectId} AND affiliate_key = ${affiliateKey}
				),
				payments AS (
					SELECT
						'stripe' AS provider,
						invoice.currency,
						invoice.amount_paid - invoice.reversed_amount AS amount,
						false AS estimated
					FROM billing_invoices invoice
					JOIN referred ON referred.id = invoice.customer_id
					WHERE invoice.project_id = ${projectId}
						AND invoice.status = 'paid'
						AND invoice.amount_paid > invoice.reversed_amount
					UNION ALL
					SELECT
						purchase.provider,
						COALESCE(purchase.currency, product.currency) AS currency,
						greatest(
							COALESCE(purchase.amount_paid_minor, product.price_amount) - purchase.reversed_amount,
							0
						) AS amount,
						purchase.amount_paid_minor IS NULL AS estimated
					FROM purchases purchase
					JOIN referred ON referred.id = purchase.customer_id
					LEFT JOIN store_products product
						ON product.project_id = purchase.project_id AND product.id = purchase.store_product_id
					LEFT JOIN subscriptions subscription
						ON subscription.project_id = purchase.project_id
						AND subscription.id = purchase.subscription_id
					WHERE purchase.project_id = ${projectId}
						AND purchase.status = 'completed'
						AND NOT EXISTS (
							SELECT 1
							FROM billing_invoices invoice
							WHERE invoice.project_id = purchase.project_id
								AND invoice.external_invoice_id = purchase.original_transaction_id
						)
						AND NOT (
							purchase.amount_paid_minor IS NULL
							AND subscription.trial_end_at IS NOT NULL
							AND purchase.purchased_at < subscription.trial_end_at
						)
					UNION ALL
					SELECT
						'google' AS provider,
						product.currency,
						product.price_amount AS amount,
						true AS estimated
					FROM store_events event
					JOIN referred ON referred.id = event.customer_id
					LEFT JOIN store_products product
						ON product.project_id = event.project_id AND product.id = event.store_product_id
					WHERE event.project_id = ${projectId}
						AND event.provider = 'google'
						AND event.processing_status = 'processed'
						AND event.event_type IN ('SUBSCRIPTION_RENEWED', 'SUBSCRIPTION_RECOVERED')
				),
				priced AS (
					SELECT
						provider,
						estimated,
						CASE WHEN amount IS NOT NULL THEN lower(currency) END AS currency,
						CASE WHEN currency IS NOT NULL THEN amount END AS amount
					FROM payments
				)
				SELECT
					provider,
					currency,
					estimated,
					count(*)::text AS payments,
					sum(amount)::text AS amount_minor
				FROM priced
				GROUP BY provider, currency, estimated
				ORDER BY provider, currency NULLS LAST, estimated
			`,
		);
		return {
			affiliateKey,
			customers: Number(referred?.customers ?? 0),
			revenue: rows.map((row) => ({
				provider: row.provider,
				currency: row.currency,
				payments: Number(row.payments),
				amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
				estimated: row.estimated,
			})),
		};
	}

	async listAffiliateCustomers(
		project: ProjectInstanceContext,
		affiliateKey: string,
		input: { limit: number; cursor: string | null },
	): Promise<AffiliateCustomerPage> {
		const rows = await executeRows<{
			id: string;
			billing_account_id: string;
			affiliate_key_set_at: string;
		}>(
			this.database,
			drizzleSql`
				SELECT
					id,
					billing_account_id,
					to_char(affiliate_key_set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
						AS affiliate_key_set_at
				FROM customers
				WHERE project_id = ${project.projectInstanceId}
					AND affiliate_key = ${affiliateKey}
					AND erased_at IS NULL
					AND ${input.cursor === null ? drizzleSql`true` : drizzleSql`id < ${input.cursor}::uuid`}
				ORDER BY id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		const page = rows.slice(0, input.limit);
		return {
			items: page.map((row) => ({
				billingAccountId: row.billing_account_id,
				affiliateKeySetAt: row.affiliate_key_set_at,
			})),
			nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
		};
	}
}
