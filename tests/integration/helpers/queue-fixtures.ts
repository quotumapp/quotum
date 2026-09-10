import type { SQL } from "bun";
import type { BillingRepository } from "../../../src/db/repository";
import {
	linkStripeCustomer,
	seedPhase3CatalogMigration,
	seedPhase3ControlCatalog,
} from "./phase3-fixtures";
import { integrationProjectContext } from "./platform-fixture";

export async function seedAutoTopupJobs(
	sql: SQL,
	repository: BillingRepository,
	count: number,
): Promise<string[]> {
	await seedPhase3ControlCatalog(sql);
	const project = integrationProjectContext();
	for (let index = 0; index < count; index += 1) {
		const billingAccountId = `topup-account-${index}`;
		await linkStripeCustomer(sql, billingAccountId);
		await repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: `fixture:${billingAccountId}`,
		});
		await repository.controlsEnterprise.upsertAutoTopupPolicy(project, {
			billingAccountId,
			featureKey: "ai_credits",
			topupKey: "credits_10",
			provider: "stripe",
			thresholdQuantity: "5",
			cooldownSeconds: 30,
			limitIntervalSeconds: 86_400,
			maxPurchasesPerInterval: 2,
			maxSpendMinor: 1_000,
			maxConsecutiveFailures: 3,
			actor: "integration-test",
		});
		await repository.consumeUsage(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "6",
			idempotencyKey: `topup:trigger:${index}`,
		});
	}

	const rows = await sql<{ id: string }[]>`
		SELECT id
		FROM auto_topup_jobs
		ORDER BY created_at, id
	`;
	if (rows.length !== count) {
		throw new Error(`Expected ${count} auto top-up jobs, found ${rows.length}`);
	}
	return rows.map((row) => row.id);
}

export async function seedSubscriptionChanges(sql: SQL, count: number): Promise<string[]> {
	await seedPhase3ControlCatalog(sql);
	await seedPhase3CatalogMigration(sql);
	await sql`
		WITH source AS (
			SELECT subscription.*
			FROM subscriptions subscription
			JOIN projects project ON project.id = subscription.project_id AND project.key = 'voysee'
			WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
		),
		accounts AS (
			INSERT INTO customers (project_id, billing_account_id)
			SELECT source.project_id, concat('change-account-', generate_series.n::text)
			FROM source
			CROSS JOIN generate_series(1, ${count}) AS generate_series(n)
			RETURNING id, project_id, billing_account_id
		),
		copied AS (
			INSERT INTO subscriptions (
				project_id, customer_id, product_id, store_product_id, provider, channel,
				external_subscription_id, external_product_id, external_price_id, status,
				starts_at, current_period_start, current_period_end, auto_renew,
				plan_version_id, catalog_revision_id
			)
			SELECT
				source.project_id, account.id, source.product_id, source.store_product_id,
				source.provider, source.channel, concat('sub_change_', account.billing_account_id),
				source.external_product_id, source.external_price_id, source.status,
				source.starts_at, source.current_period_start, source.current_period_end,
				source.auto_renew, source.plan_version_id, source.catalog_revision_id
			FROM source
			JOIN accounts account ON account.project_id = source.project_id
			RETURNING id, project_id
		)
		INSERT INTO subscription_items (
			project_id, subscription_id, price_component_id, provider_subscription_item_id,
			quantity, unit_amount_minor, currency, starts_at
		)
		SELECT copied.project_id, copied.id, item.price_component_id,
			concat(item.provider_subscription_item_id, '_', copied.id),
			item.quantity, item.unit_amount_minor, item.currency, item.starts_at
		FROM copied
		JOIN source ON source.project_id = copied.project_id
		JOIN subscription_items item
			ON item.project_id = source.project_id AND item.subscription_id = source.id
	`;
	const rows = await sql<{ id: string }[]>`
		INSERT INTO subscription_changes (
			project_id, customer_id, subscription_id, from_plan_version_id, to_plan_version_id,
			change_kind, effective_mode, effective_at, proration_behavior, status,
			idempotency_key, request_hash, requested_quantities
		)
		SELECT
			subscription.project_id, subscription.customer_id, subscription.id,
			from_version.id, to_version.id, 'upgrade', 'immediate', now() - INTERVAL '1 second',
			'none', 'pending', concat('change:', subscription.external_subscription_id),
			repeat('b', 64), '{"licensed_seats": 7}'::jsonb
		FROM subscriptions subscription
		JOIN projects project ON project.id = subscription.project_id AND project.key = 'voysee'
		JOIN plans plan ON plan.project_id = project.id AND plan.key = 'migration-plan'
		JOIN plan_versions from_version
			ON from_version.project_id = plan.project_id AND from_version.plan_id = plan.id
			AND from_version.version = 1
		JOIN plan_versions to_version
			ON to_version.project_id = plan.project_id AND to_version.plan_id = plan.id
			AND to_version.version = 2
		WHERE subscription.external_subscription_id LIKE 'sub_change_%'
		RETURNING id
	`;
	if (rows.length !== count) {
		throw new Error(`Expected ${count} subscription changes, found ${rows.length}`);
	}
	return rows.map((row) => row.id);
}

export async function seedUsageInvoicePeriods(sql: SQL, count: number): Promise<string[]> {
	await seedPhase3ControlCatalog(sql);
	await seedPhase3CatalogMigration(sql);
	await linkStripeCustomer(sql, "migration-stripe");
	const rows = await sql<{ id: string }[]>`
		INSERT INTO usage_invoice_periods (
			project_id, customer_id, subscription_id, plan_item_id, price_component_id,
			period_start_at, period_end_at, usage_quantity, included_quantity, billable_quantity,
			billing_units, unit_amount_minor, amount_minor, currency, status
		)
		SELECT
			subscription.project_id, subscription.customer_id, subscription.id,
			plan_item.id, price.id,
			now() - ((generate_series.n + 1) * INTERVAL '1 day'),
			now() - (generate_series.n * INTERVAL '1 day'),
			2, 1, 1, 1, 100, 100, 'USD', 'pending'
		FROM generate_series(1, ${count}) AS generate_series(n)
		JOIN subscriptions subscription ON subscription.external_subscription_id = 'sub_migrate_stripe'
		JOIN projects project ON project.id = subscription.project_id AND project.key = 'voysee'
		JOIN plans plan ON plan.project_id = project.id AND plan.key = 'migration-plan'
		JOIN plan_versions version
			ON version.project_id = plan.project_id AND version.plan_id = plan.id AND version.version = 1
		JOIN plan_items plan_item
			ON plan_item.project_id = version.project_id AND plan_item.plan_version_id = version.id
		JOIN features feature
			ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
			AND feature.key = 'licensed_seats'
		JOIN price_components price
			ON price.project_id = plan_item.project_id AND price.plan_item_id = plan_item.id
			AND price.key = 'seats'
		RETURNING id
	`;
	if (rows.length !== count) {
		throw new Error(`Expected ${count} usage invoice periods, found ${rows.length}`);
	}
	return rows.map((row) => row.id);
}

export async function seedReconciliationSubscriptions(sql: SQL, count: number): Promise<string[]> {
	const rows = await sql<{ id: string }[]>`
		WITH accounts AS (
			INSERT INTO customers (project_id, billing_account_id)
			SELECT project.id, concat('recon-account-', generate_series.n::text)
			FROM projects project
			CROSS JOIN generate_series(1, ${count}) AS generate_series(n)
			WHERE project.key = 'voysee'
			RETURNING id, project_id, billing_account_id
		)
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, current_period_start, current_period_end, auto_renew,
			expires_at, provider_reconciled_at, provider_reconciliation_next_attempt_at
		)
		SELECT
			account.project_id, account.id, product.id, store.id, 'google', 'android',
			concat('gps_recon_', account.billing_account_id), store.external_product_id,
			store.external_price_id, 'active', now() - INTERVAL '1 day', now() - INTERVAL '1 day',
			now() + INTERVAL '29 days', true, now() + INTERVAL '2 hours',
			now() - INTERVAL '12 hours', now() - INTERVAL '1 hour'
		FROM accounts account
		JOIN products product ON product.project_id = account.project_id AND product.key = 'premium_monthly'
		JOIN store_products store ON store.project_id = product.project_id
			AND store.product_id = product.id AND store.provider = 'google' AND store.channel = 'android'
		RETURNING id
	`;
	if (rows.length !== count) {
		throw new Error(`Expected ${count} reconciliation subscriptions, found ${rows.length}`);
	}
	return rows.map((row) => row.id);
}
