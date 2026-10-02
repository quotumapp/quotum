import { describe, expect, it } from "bun:test";
import { catalogFileText, orderCatalogKeys } from "../../src/catalog/format";
import type { CanonicalCatalog } from "../../src/catalog/types";

const catalog = {
	rateCards: [],
	topups: [],
	plans: [],
	features: [
		{
			filterDimensions: [],
			creditScale: 0,
			unit: "credit",
			meterKind: "consumable",
			kind: "metered",
			name: "AI credits",
			key: "ai_credits",
		},
	],
} as unknown as CanonicalCatalog;

describe("catalog file formatting", () => {
	it("orders keys by their meaning, whatever order a file spelled them in", () => {
		expect(Object.keys(orderCatalogKeys(catalog) as object)).toEqual([
			"features",
			"plans",
			"topups",
			"rateCards",
		]);
		const [feature] = (orderCatalogKeys(catalog) as { features: object[] }).features;
		expect(Object.keys(feature ?? {})).toEqual([
			"key",
			"name",
			"kind",
			"meterKind",
			"unit",
			"creditScale",
			"filterDimensions",
		]);
		// A key the order does not know follows the known ones, alphabetically; arrays keep their order.
		expect(
			orderCatalogKeys({ zeta: 1, key: "k", alpha: [{ provider: "p", productKey: "x" }] }),
		).toEqual({ key: "k", alpha: [{ productKey: "x", provider: "p" }], zeta: 1 });
		expect(Object.keys(orderCatalogKeys({ zeta: 1, key: "k", alpha: 2 }) as object)).toEqual([
			"key",
			"alpha",
			"zeta",
		]);
		expect(orderCatalogKeys(null)).toBeNull();
		expect(orderCatalogKeys("text")).toBe("text");
	});

	it("writes JSON, or a module that keeps the declared expected revision", () => {
		const json = catalogFileText(catalog, "json");
		expect(json.endsWith("}\n")).toBe(true);
		expect(JSON.parse(json)).toEqual(orderCatalogKeys(catalog));

		const typed = catalogFileText(catalog, "ts", null);
		expect(typed).toContain('import type { CanonicalCatalog } from "quotum-api/sdk";');
		expect(typed).toContain("export const expectedRevision: number | null = null;");
		expect(typed).toContain("export const catalog: CanonicalCatalog = {");
		expect(catalogFileText(catalog, "ts", 4)).toContain(
			"export const expectedRevision: number | null = 4;",
		);
		// Without a declared expected revision, none is written: diff and push then follow the
		// current revision.
		expect(catalogFileText(catalog, "ts")).not.toContain("expectedRevision");

		const plain = catalogFileText(catalog, "js", 2);
		expect(plain).not.toContain("import");
		expect(plain).toContain("export const expectedRevision = 2;");
		expect(plain).toContain("export const catalog = {");
	});
});
