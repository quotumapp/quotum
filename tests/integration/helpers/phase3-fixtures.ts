import type { SQL } from "bun";

export async function seedPhase3ControlCatalog(sql: SQL): Promise<void> {
	await sql`
		INSERT INTO catalog_revisions (project_id, revision, status, intent_hash, created_by, published_at)
		SELECT id, 1, 'published', repeat('a', 64), 'integration-test', now()
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		UPDATE projects SET published_catalog_revision_id = revision.id
		FROM catalog_revisions revision
		WHERE projects.id = revision.project_id AND projects.key = 'voysee'
	`;
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'ai_credits', 'AI credits', 'metered', 'consumable', 'credit', 0
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'model_tokens', 'Model tokens', 'metered', 'consumable', 'token', 0
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		INSERT INTO rate_card_entries (
			project_id, catalog_revision_id, meter_feature_id, wallet_feature_id, rate_per_unit
		)
		SELECT project.id, revision.id, meter.id, wallet.id, 1
		FROM projects project
		JOIN catalog_revisions revision ON revision.project_id = project.id AND revision.revision = 1
		JOIN features meter ON meter.project_id = project.id AND meter.key = 'model_tokens'
		JOIN features wallet ON wallet.project_id = project.id AND wallet.key = 'ai_credits'
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO topup_options (project_id, catalog_revision_id, key, feature_id, quantity)
		SELECT project.id, revision.id, 'credits_10', feature.id, 10
		FROM projects project
		JOIN catalog_revisions revision ON revision.project_id = project.id AND revision.revision = 1
		JOIN features feature ON feature.project_id = project.id AND feature.key = 'ai_credits'
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO provider_topup_bindings (
			project_id, topup_option_id, store_product_id, provider, channel, status
		)
		SELECT project.id, option.id, store.id, 'stripe', 'web', 'published'
		FROM projects project
		JOIN topup_options option ON option.project_id = project.id AND option.key = 'credits_10'
		JOIN store_products store ON store.project_id = project.id
			AND store.provider = 'stripe' AND store.external_price_id = 'price_credits_10'
		WHERE project.key = 'voysee'
	`;
}

export async function seedPhase3CatalogMigration(sql: SQL, projectKey = "voysee"): Promise<void> {
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'licensed_seats', 'Licensed seats', 'metered', 'non_consumable', 'seat', 0
		FROM projects WHERE key = ${projectKey}
	`;
	await sql`
		WITH target AS (
			SELECT project.id AS project_id, revision.id AS revision_id
			FROM projects project
			JOIN catalog_revisions revision ON revision.project_id = project.id
			WHERE project.key = ${projectKey} AND revision.revision = 1
		), plan AS (
			INSERT INTO plans (project_id, key, name)
			SELECT project_id, 'migration-plan', 'Migration plan' FROM target
			RETURNING id, project_id
		)
		INSERT INTO plan_versions (
			project_id, plan_id, catalog_revision_id, version, status, currency,
			base_amount_minor, billing_interval, tier_rank
		)
		SELECT plan.project_id, plan.id, target.revision_id, version.number, 'published',
			'USD', version.amount, 'month', version.rank
		FROM plan, target
		CROSS JOIN (VALUES (1, 1000, 10), (2, 1500, 20)) AS version(number, amount, rank)
	`;
	await sql`
		UPDATE plans SET active_version_id = version.id
		FROM plan_versions version
		WHERE plans.project_id = version.project_id AND plans.id = version.plan_id
			AND plans.key = 'migration-plan' AND version.version = 2 AND plans.project_id = (SELECT id FROM projects WHERE key = ${projectKey})
	`;
	await sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity,
			reset_interval, allocation_scope
		)
		SELECT version.project_id, version.id, feature.id, 'licensed_quantity', 1, NULL, 'license_pool'
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'licensed_seats'
		WHERE plan.key = 'migration-plan' AND plan.project_id = (SELECT id FROM projects WHERE key = ${projectKey})
	`;
	await sql`
		INSERT INTO price_components (
			project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing,
			currency, unit_amount_minor, billing_units, billing_interval,
			minimum_quantity, maximum_quantity
		)
		SELECT version.project_id, version.id, NULL, 'base', 'base', 'in_advance',
			'USD', version.base_amount_minor, 1, 'month', 1, 1
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		WHERE plan.key = 'migration-plan' AND plan.project_id = (SELECT id FROM projects WHERE key = ${projectKey})
		UNION ALL
		SELECT version.project_id, version.id, item.id, 'seats', 'licensed', 'in_advance',
			'USD', CASE version.version WHEN 1 THEN 100 ELSE 150 END, 1, 'month', 1, 100
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN plan_items item ON item.project_id = version.project_id AND item.plan_version_id = version.id
		WHERE plan.key = 'migration-plan' AND plan.project_id = (SELECT id FROM projects WHERE key = ${projectKey})
	`;
	await sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id,
			external_price_id, billing_period, currency, price_amount
		)
		SELECT project.id, product.id, 'stripe', 'web',
			concat('prod_migrate_v', version.number, '_', component.kind),
			concat('price_migrate_v', version.number, '_', component.kind),
			'month', 'USD', component.amount
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = 'premium_monthly'
		CROSS JOIN (VALUES (1), (2)) AS version(number)
		CROSS JOIN (VALUES ('base', 1000), ('seats', 100)) AS component(kind, amount)
		WHERE project.key = ${projectKey}
	`;
	await sql`
		INSERT INTO provider_price_bindings (
			project_id, price_component_id, store_product_id, provider, channel, status
		)
		SELECT price.project_id, price.id, store.id, 'stripe', 'web', 'published'
		FROM price_components price
		JOIN plan_versions version ON version.project_id = price.project_id AND version.id = price.plan_version_id
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN store_products store ON store.project_id = price.project_id
			AND store.external_price_id = concat('price_migrate_v', version.version, '_', price.key)
		WHERE plan.key = 'migration-plan' AND plan.project_id = (SELECT id FROM projects WHERE key = ${projectKey})
	`;
	await sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT project.id, account.id
		FROM projects project
		CROSS JOIN (VALUES ('migration-stripe'), ('migration-apple')) AS account(id)
		WHERE project.key = ${projectKey}
	`;
	await sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, current_period_start, current_period_end, auto_renew,
			plan_version_id, catalog_revision_id
		)
		SELECT project.id, customer.id, product.id,
			CASE account.provider WHEN 'stripe' THEN stripe_store.id ELSE apple_store.id END,
			account.provider, account.channel, account.external_subscription_id,
			CASE account.provider
				WHEN 'stripe' THEN stripe_store.external_product_id
				ELSE apple_store.external_product_id
			END,
			CASE account.provider
				WHEN 'stripe' THEN stripe_store.external_price_id
				ELSE apple_store.external_price_id
			END,
			'active', now() - interval '1 day', now() - interval '1 day',
			now() + interval '29 days', true, version.id, version.catalog_revision_id
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = 'premium_monthly'
		JOIN plans plan ON plan.project_id = project.id AND plan.key = 'migration-plan'
		JOIN plan_versions version ON version.project_id = plan.project_id
			AND version.plan_id = plan.id AND version.version = 1
		JOIN store_products stripe_store ON stripe_store.project_id = project.id
			AND stripe_store.external_price_id = 'price_migrate_v1_base'
		JOIN store_products apple_store ON apple_store.project_id = project.id
			AND apple_store.provider = 'apple' AND apple_store.external_product_id = 'premium_monthly'
		CROSS JOIN (VALUES
			('stripe', 'web', 'sub_migrate_stripe', 'migration-stripe'),
			('apple', 'ios', 'sub_migrate_apple', 'migration-apple')
		) AS account(provider, channel, external_subscription_id, billing_account_id)
		JOIN customers customer ON customer.project_id = project.id
			AND customer.billing_account_id = account.billing_account_id
		WHERE project.key = ${projectKey}
	`;
	await sql`
		INSERT INTO subscription_items (
			project_id, subscription_id, price_component_id, provider_subscription_item_id,
			quantity, unit_amount_minor, currency, starts_at
		)
		SELECT subscription.project_id, subscription.id, price.id,
			CASE price.component_kind WHEN 'base' THEN 'si_migrate_base' ELSE 'si_migrate_seats' END,
			CASE price.component_kind WHEN 'base' THEN 1 ELSE 7 END,
			price.unit_amount_minor, price.currency, now() - interval '1 day'
		FROM subscriptions subscription
		JOIN price_components price ON price.project_id = subscription.project_id
			AND price.plan_version_id = subscription.plan_version_id
		WHERE subscription.external_subscription_id = 'sub_migrate_stripe' AND subscription.project_id = (SELECT id FROM projects WHERE key = ${projectKey})
	`;
}

export async function seedPhase3MeteringCatalog(sql: SQL): Promise<void> {
	await sql`
		WITH project AS (
			SELECT id FROM projects WHERE key = 'voysee'
		), revision AS (
			INSERT INTO catalog_revisions (project_id, revision, status, intent_hash, created_by, published_at)
			SELECT id, 1, 'published', repeat('a', 64), 'integration-test', now()
			FROM project
			RETURNING id, project_id
		), wallets AS (
			INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
			SELECT project_id, 'ai_credits', 'AI credits', 'metered', 'consumable', 'credit', 3
			FROM revision
			RETURNING id, project_id
		), meters AS (
			INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
			SELECT project_id, 'model_tokens', 'Model tokens', 'metered', 'consumable', 'token', 0
			FROM revision
			RETURNING id, project_id
		), caps AS (
			INSERT INTO features (
				project_id, key, name, kind, meter_kind, unit, credit_scale, filter_dimensions
			)
			SELECT project_id, 'api_requests', 'API requests', 'metered', 'consumable',
				'request', 0, ARRAY['model', 'region']::text[]
			FROM revision
			RETURNING id, project_id
		), cap_plan AS (
			INSERT INTO plans (project_id, key, name)
			SELECT project_id, 'api_monthly', 'API Monthly' FROM revision
			RETURNING id, project_id
		), cap_version AS (
			INSERT INTO plan_versions (
				project_id, plan_id, catalog_revision_id, version, status,
				currency, base_amount_minor, billing_interval
			)
			SELECT cap_plan.project_id, cap_plan.id, revision.id, 1, 'published', 'USD', 999, 'month'
			FROM cap_plan, revision
			RETURNING id, project_id, plan_id
		), cap_item AS (
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval
			)
			SELECT cap_version.project_id, cap_version.id, caps.id, 'meter_limit', 200, 'month'
			FROM cap_version, caps
		), wallet_item AS (
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval,
				rollover_enabled, rollover_max_quantity, rollover_expiry_mode,
				rollover_expiry_months
			)
			SELECT cap_version.project_id, cap_version.id, wallets.id, 'allocation', 100, 'month',
				true, 25, 'months', 2
			FROM cap_version, wallets
		), rate AS (
			INSERT INTO rate_card_entries (
				project_id, catalog_revision_id, meter_feature_id, wallet_feature_id, rate_per_unit
			)
			SELECT revision.project_id, revision.id, meters.id, wallets.id, 0.005
			FROM revision, meters, wallets
		)
		UPDATE projects
		SET published_catalog_revision_id = revision.id
		FROM revision
		WHERE projects.id = revision.project_id
	`;
	await sql`
		UPDATE plans
		SET active_version_id = plan_versions.id, updated_at = now()
		FROM plan_versions
		WHERE plans.project_id = plan_versions.project_id
			AND plans.id = plan_versions.plan_id
			AND plans.key = 'api_monthly'
			AND plan_versions.version = 1
	`;
}

export async function seedPhase3MeteringSubscription(
	sql: SQL,
	billingAccountId: string,
	entityExternalId: string,
): Promise<void> {
	await sql`
		WITH customer AS (
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, ${billingAccountId} FROM projects WHERE key = 'voysee'
			RETURNING id, project_id
		), entity AS (
			INSERT INTO entities (project_id, customer_id, external_id, kind)
			SELECT project_id, id, ${entityExternalId}, 'workspace' FROM customer
		), target AS (
			SELECT
				customer.id AS customer_id,
				customer.project_id,
				products.id AS product_id,
				store_products.id AS store_product_id,
				plan_versions.id AS plan_version_id,
				plan_versions.catalog_revision_id
			FROM customer
			JOIN products ON products.project_id = customer.project_id AND products.key = 'premium_monthly'
			JOIN store_products ON store_products.project_id = products.project_id
				AND store_products.product_id = products.id
				AND store_products.provider = 'stripe'
			JOIN plans ON plans.project_id = customer.project_id AND plans.key = 'api_monthly'
			JOIN plan_versions ON plan_versions.project_id = plans.project_id
				AND plan_versions.id = plans.active_version_id
		)
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end,
			plan_version_id, catalog_revision_id
		)
		SELECT
			project_id, customer_id, product_id, store_product_id, 'stripe', 'web',
			${`subscription:${billingAccountId}`}, 'prod_stripe_premium', 'price_premium_monthly',
			'active', date_trunc('month', now()), date_trunc('month', now()) + INTERVAL '1 month',
			date_trunc('month', now()), date_trunc('month', now()) + INTERVAL '1 month',
			plan_version_id, catalog_revision_id
		FROM target
	`;
}

export async function linkStripeCustomer(
	sql: SQL,
	billingAccountId: string,
	externalCustomerId = `cus_${billingAccountId}`,
): Promise<void> {
	await sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, ${billingAccountId} FROM projects WHERE key = 'voysee'
		ON CONFLICT (project_id, billing_account_id) DO NOTHING
	`;
	await sql`
		INSERT INTO provider_customers (project_id, customer_id, provider, external_customer_id)
		SELECT project.id, customer.id, 'stripe', ${externalCustomerId}
		FROM projects project
		JOIN customers customer ON customer.project_id = project.id
		WHERE project.key = 'voysee' AND customer.billing_account_id = ${billingAccountId}
		ON CONFLICT (project_id, provider, external_customer_id) DO NOTHING
	`;
}
