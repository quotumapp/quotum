import type { CanonicalCatalog } from "./types";

/**
 * The order `quotum catalog format` writes an object's keys in: identity first, then what a reader
 * needs to understand the rest. A key not listed here follows the listed ones, alphabetically, so
 * the output never depends on the order a file happened to spell its keys in.
 */
const keyOrder = [
	// Catalog
	"features",
	"plans",
	"topups",
	"rateCards",
	"defaultPlan",
	"retiredFeatureKeys",
	"retiredPlanKeys",
	"retiredTopupKeys",
	// Feature, plan, top-up and price identity
	"key",
	"name",
	"version",
	"kind",
	"meterKind",
	"unit",
	"creditScale",
	"filterDimensions",
	"visibility",
	"customerBillingAccountId",
	"tierRank",
	"trialDays",
	"trialRequiresPaymentMethod",
	"trialEndBehavior",
	"upgradeProrationBehavior",
	"downgradeProrationBehavior",
	"basePrice",
	"providerPriced",
	// Plan item and top-up
	"itemKind",
	"controlKind",
	"featureKey",
	"meterFeatureKey",
	"walletFeatureKey",
	"quantity",
	"limitValue",
	"reset",
	"expiry",
	"overage",
	"allocationScope",
	"rollover",
	"price",
	"maxQuantity",
	// Cadence, expiry and overage
	"mode",
	"policy",
	"interval",
	"intervalCount",
	"seconds",
	// Price
	"currency",
	"unitAmountMinor",
	"ratePerUnit",
	"billingUnits",
	"billingInterval",
	"billingIntervalCount",
	"minimumQuantity",
	"maximumQuantity",
	"taxBehavior",
	"pricingModel",
	"tiers",
	"upToQuantity",
	"flatAmountMinor",
	"items",
	"controls",
	"providerBindings",
	// Binding
	"productKey",
	"provider",
	"channel",
	// Default plan
	"planKey",
	"entitlementKeys",
];

const keyRank = new Map(keyOrder.map((key, index) => [key, index]));

/** `value` with every object's keys in the {@link keyOrder} order, recursively. */
export function orderCatalogKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(orderCatalogKeys);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value).sort(([left], [right]) => {
		const leftRank = keyRank.get(left) ?? keyOrder.length;
		const rightRank = keyRank.get(right) ?? keyOrder.length;
		return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
	});
	return Object.fromEntries(entries.map(([key, entry]) => [key, orderCatalogKeys(entry)]));
}

/** The kinds of catalog file `quotum catalog format` writes. */
export type CatalogFileLanguage = "json" | "ts" | "js";

/**
 * A catalog file holding `canonical`: the bare intent for JSON, or a module exporting `catalog`
 * (and `expectedRevision` when the source file declared one, `null` included) for TypeScript and
 * JavaScript. The type import is erased when the module is loaded, so the file loads without the
 * package installed beside it.
 */
export function catalogFileText(
	canonical: CanonicalCatalog,
	language: CatalogFileLanguage,
	expectedRevision?: number | null,
): string {
	const json = JSON.stringify(orderCatalogKeys(canonical), null, "\t");
	if (language === "json") return `${json}\n`;
	const typed = language === "ts";
	const lines = ["// Canonical catalog intent, written by `quotum catalog format`."];
	if (typed) lines.push('import type { CanonicalCatalog } from "quotum-api/sdk";');
	lines.push("");
	if (expectedRevision !== undefined) {
		lines.push(
			`export const expectedRevision${typed ? ": number | null" : ""} = ${String(expectedRevision)};`,
			"",
		);
	}
	lines.push(`export const catalog${typed ? ": CanonicalCatalog" : ""} = ${json};`);
	return `${lines.join("\n")}\n`;
}
