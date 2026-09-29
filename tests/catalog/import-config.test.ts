import { describe, expect, it } from "bun:test";
import { parseCatalogImports } from "../../src/catalog/import-config";

const subscription = {
	key: "premium_monthly",
	name: "Premium Monthly",
	kind: "subscription" as const,
	plan: "premium",
	currency: "usd",
	amountCents: 799,
	credits: 1,
	interval: "month" as const,
	entitlementKey: "paid",
	externalProductId: "prod_premium",
	externalPriceId: "price_premium_monthly",
};

describe("parseCatalogImports", () => {
	it("parses catalog-only project imports", () => {
		expect(
			parseCatalogImports(
				JSON.stringify([{ projectInstanceKey: "acme", catalog: [subscription] }]),
			),
		).toEqual([
			{
				projectInstanceKey: "acme",
				catalog: [{ ...subscription, currency: "USD", intervalCount: 1, active: true }],
			},
		]);
	});

	it("rejects duplicate instance and catalog keys", () => {
		const project = { projectInstanceKey: "acme", catalog: [subscription] };
		expect(() => parseCatalogImports(JSON.stringify([project, project]))).toThrow(
			"duplicate project instance keys",
		);
		expect(() =>
			parseCatalogImports(JSON.stringify([{ ...project, catalog: [subscription, subscription] }])),
		).toThrow("duplicate catalog keys");
	});

	it("keeps catalog data out of runtime configuration concerns", () => {
		expect(() =>
			parseCatalogImports(
				JSON.stringify([
					{
						projectInstanceKey: "acme",
						projectionUrl: "https://projection.example.com",
						catalog: [subscription],
					},
				]),
			),
		).toThrow("BILLING_CATALOG_IMPORT_JSON is invalid");
	});
});
