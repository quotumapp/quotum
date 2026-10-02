import { InvalidRequestError } from "../billing/errors";
import type { CatalogIntent, CatalogPlanIntent, CatalogProviderBindingIntent } from "./types";

/**
 * Refuses a new plan whose legacy price fields disagree with its `basePrice` (PC-09). A plan may
 * spell its price twice: plan-level `currency`, `baseAmountMinor`, `billingInterval`,
 * `billingIntervalCount` and `providerBindings`, and the full `basePrice` object. Normalization keeps
 * `basePrice`'s amount, currency and cadence, so a disagreement would publish one value silently and
 * discard the other. The comparison therefore reads the intent as submitted next to its normalized
 * form (plans keep their order), and it runs on new intents only: a catalog stored with both
 * spellings stays readable.
 *
 * Bindings conflict when the legacy list binds a provider channel that `basePrice` also binds, to
 * different products. Legacy bindings on channels the price does not bind, such as App Store and
 * Google Play products whose price the store owns, are not a conflict.
 */
export function assertPriceSpellingsAgree(
	submitted: CatalogIntent,
	normalized: CatalogIntent,
): void {
	for (const [index, plan] of normalized.plans.entries()) {
		const price = plan.basePrice ?? null;
		const legacy = submitted.plans[index];
		if (price === null || legacy === undefined) continue;
		const conflict = (field: string, legacyValue: unknown, priceField: string, value: unknown) =>
			new InvalidRequestError(
				`Plan ${plan.key} ${field} ${String(legacyValue)} conflicts with basePrice ${priceField} ${String(value)}`,
			);
		const currency = legacy.currency?.trim().toUpperCase() ?? null;
		if (currency !== null && currency !== price.currency) {
			throw conflict("currency", currency, "currency", price.currency);
		}
		if (legacy.baseAmountMinor !== null && legacy.baseAmountMinor !== price.unitAmountMinor) {
			throw conflict(
				"baseAmountMinor",
				legacy.baseAmountMinor,
				"unitAmountMinor",
				price.unitAmountMinor,
			);
		}
		if (legacy.billingInterval !== null && legacy.billingInterval !== price.billingInterval) {
			throw conflict(
				"billingInterval",
				legacy.billingInterval,
				"billingInterval",
				price.billingInterval,
			);
		}
		const legacyCount = legacy.billingIntervalCount ?? (legacy.billingInterval === null ? null : 1);
		const priceCount = price.billingIntervalCount ?? 1;
		if (legacyCount !== null && legacyCount !== priceCount) {
			throw conflict("billingIntervalCount", legacyCount, "billingIntervalCount", priceCount);
		}
		// Normalization keeps the legacy list whenever one was submitted.
		if (legacy.providerBindings.length > 0) assertBindingsAgree(plan);
	}
}

function assertBindingsAgree(plan: CatalogPlanIntent): void {
	const priced = groupByChannel(plan.basePrice?.providerBindings ?? []);
	const listed = groupByChannel(plan.providerBindings);
	for (const [channel, products] of priced) {
		const legacy = listed.get(channel);
		if (legacy === undefined || sameKeys(legacy, products)) continue;
		throw new InvalidRequestError(
			`Plan ${plan.key} providerBindings ${channel} ${legacy.join(", ")} conflict with basePrice providerBindings ${channel} ${products.join(", ")}`,
		);
	}
}

function groupByChannel(bindings: CatalogProviderBindingIntent[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const binding of bindings) {
		const channel = `${binding.provider}/${binding.channel}`;
		groups.set(channel, [...(groups.get(channel) ?? []), binding.productKey].sort());
	}
	return groups;
}

function sameKeys(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * Refuses a price that can never charge on a new plan. Only a licensed quantity (charged in advance)
 * and a meter limit that allows overage (charged in arrears for usage above its quantity) bill their
 * price: Checkout leaves metered components out, and usage invoicing and metering read an overage
 * price only for an `allowed` limit. A price on an allocation or on a `blocked` limit would be shown
 * in the plan's pricing and never billed. A catalog stored with one stays readable.
 */
export function assertItemPricesCharge(catalog: CatalogIntent): void {
	for (const plan of catalog.plans) {
		for (const item of plan.items) {
			if (item.price === undefined || item.price === null) continue;
			if (item.itemKind === "allocation") {
				throw new InvalidRequestError(
					`Plan ${plan.key} allocation ${item.featureKey} cannot declare a price: allowances are not billed`,
				);
			}
			if (item.itemKind === "meter_limit" && item.overagePolicy === "blocked") {
				throw new InvalidRequestError(
					`Plan ${plan.key} meter limit ${item.featureKey} cannot declare a price while it blocks overage: only allowed overage is billed`,
				);
			}
		}
	}
}

/**
 * A plan's base price is its amount and currency together. A plan-level `currency` without
 * `baseAmountMinor` only names the currency its item prices use, but an amount without a currency
 * is no price at all, and `plan_versions_price_check` would refuse it at publish.
 */
export function assertBaseAmountHasCurrency(catalog: CatalogIntent): void {
	for (const plan of catalog.plans) {
		if (plan.baseAmountMinor !== null && plan.currency === null) {
			throw new InvalidRequestError(`Plan ${plan.key} baseAmountMinor requires a currency`);
		}
	}
}

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
