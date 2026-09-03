import type { SQL } from "bun";
import type { BillingChannel, BillingProvider, ProductType } from "../../../src/billing/types";
import type { ProjectRuntimeConfig } from "../../../src/projects/config";

export interface IntegrationProjectFixture extends ProjectRuntimeConfig {
	name: string;
}

interface SeededProduct {
	key: string;
	entitlementKey: string;
	creditAmount: number;
	name: string;
	type: ProductType;
}

interface SeededStoreProduct {
	productKey: string;
	provider: BillingProvider;
	channel: BillingChannel;
	externalProductId: string;
	externalPriceId: string | null;
	billingPeriod: string;
	currency: string | null;
	priceAmount: number | null;
}

export const publicBillingTableResetOrder = [
	"commercial_action_previews",
	"license_assignments",
	"license_pools",
	"catalog_migration_jobs",
	"catalog_migration_drafts",
	"auto_topup_jobs",
	"auto_topup_states",
	"auto_topup_policies",
	"usage_alert_events",
	"usage_alert_states",
	"usage_alerts",
	"usage_event_control_entries",
	"reservation_control_holds",
	"control_windows",
	"control_policies",
	"enterprise_contracts",
	"rate_card_tiers",
	"price_tiers",
	"usage_invoice_adjustments",
	"usage_invoice_periods",
	"usage_events",
	"usage_event_rollups",
	"reservation_allocations",
	"reservations",
	"usage_windows",
	"worker_delivery_claims",
	"client_idempotency_claims",
	"balance_allocations",
	"entities",
	"provider_topup_bindings",
	"topup_options",
	"subscription_changes",
	"subscription_items",
	"provider_price_bindings",
	"price_components",
	"provider_plan_bindings",
	"rate_card_entries",
	"plan_items",
	"plan_versions",
	"plans",
	"features",
	"catalog_audit_log",
	"catalog_drafts",
	"catalog_revisions",
	"projection_sync_jobs",
	"store_events",
	"entitlements",
	"purchases",
	"subscriptions",
	"provider_customers",
	"store_products",
	"products",
	"customers",
] as const;

export const integrationProjects = [
	{
		key: "voysee",
		name: "Voysee",
		apiKey: "voysee-integration-api-key",
		active: true,
		projectionUrl: "https://voysee.projection.integration.test",
		projectionSecret: "voysee-projection-secret",
	},
	{
		key: "wiseley",
		name: "Wiseley",
		apiKey: "wiseley-integration-api-key",
		active: true,
		projectionUrl: "https://wiseley.projection.integration.test",
		projectionSecret: "wiseley-projection-secret",
	},
] as const satisfies readonly IntegrationProjectFixture[];

export const seededProducts = [
	{
		key: "premium_monthly",
		entitlementKey: "premium",
		creditAmount: 0,
		name: "Premium Monthly",
		type: "subscription",
	},
	{
		key: "echo_credits_10",
		entitlementKey: "echo_credits",
		creditAmount: 10,
		name: "Echo Credits 10",
		type: "consumable",
	},
] as const satisfies readonly SeededProduct[];

export const seededStoreProducts = [
	{
		productKey: "premium_monthly",
		provider: "apple",
		channel: "ios",
		externalProductId: "premium_monthly",
		externalPriceId: null,
		billingPeriod: "month",
		currency: null,
		priceAmount: null,
	},
	{
		productKey: "echo_credits_10",
		provider: "apple",
		channel: "ios",
		externalProductId: "echo_credits_10",
		externalPriceId: null,
		billingPeriod: "one_time",
		currency: null,
		priceAmount: null,
	},
	{
		productKey: "premium_monthly",
		provider: "google",
		channel: "android",
		externalProductId: "premium_monthly",
		externalPriceId: "monthly-base",
		billingPeriod: "month",
		currency: null,
		priceAmount: null,
	},
	{
		productKey: "echo_credits_10",
		provider: "google",
		channel: "android",
		externalProductId: "echo_credits_10",
		externalPriceId: null,
		billingPeriod: "one_time",
		currency: null,
		priceAmount: null,
	},
	{
		productKey: "premium_monthly",
		provider: "stripe",
		channel: "web",
		externalProductId: "prod_stripe_premium",
		externalPriceId: "price_premium_monthly",
		billingPeriod: "month",
		currency: "usd",
		priceAmount: 999,
	},
	{
		productKey: "echo_credits_10",
		provider: "stripe",
		channel: "web",
		externalProductId: "prod_stripe_credits_10",
		externalPriceId: "price_credits_10",
		billingPeriod: "one_time",
		currency: "usd",
		priceAmount: 499,
	},
] as const satisfies readonly SeededStoreProduct[];

export async function resetPublicBillingTables(sql: SQL): Promise<void> {
	await sql`UPDATE projects SET published_catalog_revision_id = NULL`;
	await sql`
		TRUNCATE TABLE
			commercial_action_previews,
			license_assignments,
			license_pools,
			catalog_migration_jobs,
			catalog_migration_drafts,
			auto_topup_jobs,
			auto_topup_states,
			auto_topup_policies,
			usage_alert_events,
			usage_alert_states,
			usage_alerts,
			usage_event_control_entries,
			reservation_control_holds,
			control_windows,
			control_policies,
			enterprise_contracts,
			rate_card_tiers,
			price_tiers,
			usage_invoice_adjustments,
			usage_invoice_periods,
			usage_events,
			usage_event_rollups,
			reservation_allocations,
			reservations,
			usage_windows,
			worker_delivery_claims,
			client_idempotency_claims,
			balance_allocations,
			entities,
			provider_topup_bindings,
			topup_options,
			subscription_changes,
			subscription_items,
			provider_price_bindings,
			price_components,
			provider_plan_bindings,
			rate_card_entries,
			plan_items,
			plan_versions,
			plans,
			features,
			catalog_audit_log,
			catalog_drafts,
			catalog_revisions,
			projection_sync_jobs,
			store_events,
			entitlements,
			purchases,
			subscriptions,
			provider_customers,
			store_products,
			products,
			customers
		RESTART IDENTITY CASCADE
	`;
}

export async function seedIntegrationProjectsAndCatalog(
	sql: SQL,
	projects: readonly IntegrationProjectFixture[] = integrationProjects,
): Promise<void> {
	for (const project of projects) {
		await sql`
			INSERT INTO projects (key, name, active)
			VALUES (${project.key}, ${project.name}, true)
			ON CONFLICT (key) DO UPDATE SET
				name = EXCLUDED.name,
				active = EXCLUDED.active,
				updated_at = now()
		`;

		for (const product of seededProducts) {
			await sql`
				INSERT INTO products (
					project_id,
					key,
					entitlement_key,
					credit_amount,
					name,
					type,
					active
				)
				SELECT id, ${product.key}, ${product.entitlementKey}, ${product.creditAmount},
					${product.name}, ${product.type}, true
				FROM projects
				WHERE key = ${project.key}
				ON CONFLICT (project_id, key) DO UPDATE SET
					entitlement_key = EXCLUDED.entitlement_key,
					credit_amount = EXCLUDED.credit_amount,
					name = EXCLUDED.name,
					type = EXCLUDED.type,
					active = EXCLUDED.active,
					updated_at = now()
			`;
		}

		for (const storeProduct of seededStoreProducts) {
			if (storeProduct.externalPriceId === null) {
				await sql`
					INSERT INTO store_products (
						project_id,
						product_id,
						provider,
						channel,
						external_product_id,
						external_price_id,
						billing_period,
						currency,
						price_amount,
						active
					)
					SELECT projects.id, products.id, ${storeProduct.provider}, ${storeProduct.channel},
						${storeProduct.externalProductId}, ${storeProduct.externalPriceId},
						${storeProduct.billingPeriod}, ${storeProduct.currency}, ${storeProduct.priceAmount},
						true
					FROM projects
					JOIN products ON products.project_id = projects.id
						AND products.key = ${storeProduct.productKey}
					WHERE projects.key = ${project.key}
					ON CONFLICT (project_id, provider, external_product_id)
					WHERE external_price_id IS NULL
					DO UPDATE SET
						product_id = EXCLUDED.product_id,
						channel = EXCLUDED.channel,
						external_price_id = EXCLUDED.external_price_id,
						billing_period = EXCLUDED.billing_period,
						currency = EXCLUDED.currency,
						price_amount = EXCLUDED.price_amount,
						active = EXCLUDED.active,
						updated_at = now()
				`;
			} else {
				await sql`
					INSERT INTO store_products (
						project_id,
						product_id,
						provider,
						channel,
						external_product_id,
						external_price_id,
						billing_period,
						currency,
						price_amount,
						active
					)
					SELECT projects.id, products.id, ${storeProduct.provider}, ${storeProduct.channel},
						${storeProduct.externalProductId}, ${storeProduct.externalPriceId},
						${storeProduct.billingPeriod}, ${storeProduct.currency}, ${storeProduct.priceAmount},
						true
					FROM projects
					JOIN products ON products.project_id = projects.id
						AND products.key = ${storeProduct.productKey}
					WHERE projects.key = ${project.key}
					ON CONFLICT (project_id, provider, external_product_id, external_price_id)
					WHERE external_price_id IS NOT NULL
					DO UPDATE SET
						product_id = EXCLUDED.product_id,
						channel = EXCLUDED.channel,
						billing_period = EXCLUDED.billing_period,
						currency = EXCLUDED.currency,
						price_amount = EXCLUDED.price_amount,
						active = EXCLUDED.active,
						updated_at = now()
				`;
			}
		}
	}
}

export async function resetAndSeedIntegrationData(sql: SQL): Promise<void> {
	await resetPublicBillingTables(sql);
	await seedIntegrationProjectsAndCatalog(sql);
}
