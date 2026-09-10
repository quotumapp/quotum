import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(process.cwd(), "migrations");
const files = readdirSync(migrationsDir)
	.filter((file) => file.endsWith(".sql"))
	.sort();
const read = (file: string) => readFileSync(join(migrationsDir, file), "utf8");

const platform = read("001_platform.sql");
const billingCore = read("002_billing_core.sql");
const metering = read("003_metering_and_pricing.sql");
const merchant = read("004_merchant.sql");

describe("baseline schema files", () => {
	it("uses one ordered baseline file per domain", () => {
		expect(files).toEqual([
			"001_platform.sql",
			"002_billing_core.sql",
			"003_metering_and_pricing.sql",
			"004_merchant.sql",
		]);
		for (const file of files) expect(file).toMatch(/^\d{3}_[a-z_]+\.sql$/);
		for (const file of files)
			expect(read(file)).not.toMatch(/^\s*ALTER TABLE \w+\s+(ADD|DROP) COLUMN/m);
	});

	it("declares extensions and the billing projects table in the platform file", () => {
		expect(platform).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
		expect(platform).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
		expect(platform).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? projects \(/);
		expect(platform).toContain("idx_billing_projects_key");
		expect(platform).not.toContain("CREATE SCHEMA IF NOT EXISTS billing");
	});

	it("creates the billing core tables without provider RPC functions or roles", () => {
		for (const table of [
			"customers",
			"products",
			"store_products",
			"provider_customers",
			"subscriptions",
			"purchases",
			"entitlements",
			"store_events",
			"projection_sync_jobs",
			"checkout_requests",
			"credit_grants",
			"credit_grant_provider_objects",
			"credit_reversals",
			"billing_invoices",
		]) {
			expect(billingCore).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
		}
		expect(billingCore).toContain("billing_account_id TEXT NOT NULL");
		expect(billingCore).not.toContain("app_user_id");
		expect(billingCore).toContain("idx_billing_customers_billing_account_id_trgm");
		expect(billingCore).toContain("idx_billing_projection_sync_jobs_idempotency");
		expect(billingCore).toContain("idx_billing_subscriptions_provider_reconciliation_due");
		expect(billingCore).toContain("jsonb_typeof(payload->'balances') = 'array'");
		expect(billingCore).toContain("NOT (payload ? 'operation')");
		expect(billingCore).toContain("last_provider_event_created");
		expect(billingCore).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
		for (const file of files) {
			const sql = read(file);
			expect(sql).not.toContain("service_role");
			expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
		}
	});

	it("creates the catalog, metering, pricing, controls, and commercial tables", () => {
		for (const table of [
			"metering_settings",
			"catalog_revisions",
			"catalog_drafts",
			"catalog_provider_operations",
			"features",
			"plans",
			"plan_versions",
			"plan_items",
			"rate_card_entries",
			"balance_allocations",
			"client_idempotency_claims",
			"worker_delivery_claims",
			"usage_windows",
			"reservations",
			"usage_events",
			"usage_event_rollups",
			"price_components",
			"provider_price_bindings",
			"subscription_items",
			"subscription_changes",
			"usage_invoice_periods",
			"usage_invoice_adjustments",
			"price_tiers",
			"rate_card_tiers",
			"enterprise_contracts",
			"control_policies",
			"usage_alerts",
			"auto_topup_policies",
			"auto_topup_jobs",
			"catalog_migration_jobs",
			"license_pools",
			"license_assignments",
			"commercial_action_previews",
		]) {
			expect(metering).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
		}
		expect(metering).toContain("PARTITION BY RANGE (recorded_at)");
		expect(metering).toContain("PARTITION OF usage_events");
		expect(metering).toContain("idx_billing_usage_windows_scope_period");
		expect(metering).toContain("idx_billing_usage_events_customer_feature_time");
		expect(metering).toContain("licensed_quantity");
		expect(metering).toContain("rollover_origin_allocation_id");
		expect(metering).toContain("customer_specific");
		expect(metering).toContain("commercial_action_previews_project_token_unique");
		expect(metering).toContain("ADD CONSTRAINT projects_published_catalog_revision_fk");
		expect(metering).toContain("ADD CONSTRAINT plans_active_version_fk");
	});

	it("keeps platform identity and merchant tables in platform-owned files", () => {
		expect(platform).toContain("CREATE TABLE platform_organizations");
		expect(platform).toContain("CREATE TABLE platform_projects");
		expect(platform).toContain("CREATE TABLE platform_project_api_credentials");
		expect(platform).toContain(
			"platform_project_id UUID NOT NULL REFERENCES platform_projects(id)",
		);
		expect(platform).toContain("lifecycle_status TEXT NOT NULL");
		expect(platform).not.toContain("resolve_project_id");
		expect(platform).not.toMatch(/secret[^\n]*TEXT/iu);
		for (const table of [
			"platform_auth_users",
			"platform_principals",
			"platform_merchant_sessions",
			"platform_memberships",
			"platform_onboarding_drafts",
			"platform_service_principals",
		]) {
			expect(merchant).toContain(`CREATE TABLE ${table} (`);
		}
		expect(merchant).not.toMatch(/CREATE TABLE (?!platform_)/);
	});
});
