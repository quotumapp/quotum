import { describe, expect, it } from "bun:test";
import {
	integrationProjects,
	publicBillingTableResetOrder,
	seededStoreProducts,
} from "./catalog-fixtures";

describe("integration catalog fixtures", () => {
	it("uses public billing tables in dependency reset order", () => {
		expect(publicBillingTableResetOrder).toEqual([
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
		]);
		expect(publicBillingTableResetOrder.some((table) => table.includes("."))).toBe(false);
	});

	it("defines deterministic projects with HTTP projection delivery config", () => {
		expect(integrationProjects.map((project) => project.key)).toEqual(["voysee", "wiseley"]);
		for (const project of integrationProjects) {
			expect(project.projectionUrl).toBe(`https://${project.key}.projection.integration.test`);
			expect(project.projectionSecret).toBe(`${project.key}-projection-secret`);
		}
	});

	it("matches fake provider payload catalog ids", () => {
		expect(seededStoreProducts).toContainEqual({
			productKey: "premium_monthly",
			provider: "apple",
			channel: "ios",
			externalProductId: "premium_monthly",
			externalPriceId: null,
			billingPeriod: "month",
			currency: null,
			priceAmount: null,
		});
		expect(seededStoreProducts).toContainEqual({
			productKey: "echo_credits_10",
			provider: "stripe",
			channel: "web",
			externalProductId: "prod_stripe_credits_10",
			externalPriceId: "price_credits_10",
			billingPeriod: "one_time",
			currency: "usd",
			priceAmount: 499,
		});
	});
});
