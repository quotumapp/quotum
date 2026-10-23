import type { CatalogPlanIntent } from "./types";

/**
 * The currency a plan version records: its base price's, and none for a plan without a base price.
 * Item prices keep their own currency on their price components, so a plan priced only by its items,
 * such as a seat-only plan or a meter limit with postpaid overage, records neither an amount nor a
 * currency (`plan_versions_price_check` requires both or neither).
 */
export function planVersionCurrency(
	plan: Pick<CatalogPlanIntent, "baseAmountMinor" | "currency">,
): string | null {
	return plan.baseAmountMinor === null ? null : plan.currency;
}
