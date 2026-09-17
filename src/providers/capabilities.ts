import type { ProductType } from "../billing/types";
import type {
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
} from "../catalog/types";
import {
	type BillingProvider,
	billingProviders,
	type DeclaredProvider,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	providerOperations,
} from "../shared/provider-capabilities";
import { appleCapabilities } from "./apple/capabilities";
import { googleCapabilities } from "./google/capabilities";
import { paddleCapabilities } from "./paddle/capabilities";
import { stripeCapabilities } from "./stripe/capabilities";

/** Every declaration, planned ones included, in contract order. */
export const providerCapabilityDeclarations: readonly ProviderCapabilityDeclaration[] = [
	appleCapabilities,
	googleCapabilities,
	stripeCapabilities,
	paddleCapabilities,
];

export const providerCapabilityCatalog: ReadonlyMap<
	DeclaredProvider,
	ProviderCapabilityDeclaration
> = new Map(
	providerCapabilityDeclarations.map((declaration) => [declaration.provider, declaration]),
);

export function providerCapabilityDeclaration(
	provider: DeclaredProvider,
): ProviderCapabilityDeclaration {
	const declaration = providerCapabilityCatalog.get(provider);
	if (declaration === undefined) {
		throw new Error(`Provider ${String(provider)} has no capability declaration`);
	}
	return declaration;
}

/** Providers the runtime admits: declared available, in `billingProviders` order. */
export function admittedProviders(): BillingProvider[] {
	return billingProviders.filter(
		(provider) => providerCapabilityCatalog.get(provider)?.availability === "available",
	);
}

/**
 * A catalog construct whose provider binding must support the operations it requires: an adopted
 * store product, a plan, a price component (the plan's base price when `item` is null, otherwise
 * the priced plan item; the plan's other components decide hybrid pricing) or a top-up.
 */
export type CatalogCapabilityTarget =
	| { kind: "product"; productType: ProductType }
	| { kind: "plan"; plan: Pick<CatalogPlanIntent, "kind" | "trialDays"> }
	| {
			kind: "price";
			plan: Pick<CatalogPlanIntent, "basePrice" | "items">;
			item: Pick<CatalogPlanItemIntent, "itemKind" | "price"> | null;
	  }
	| { kind: "topup" };

/** The provider operations a binding on `target` requires, in contract order. */
export function requiredOperationsFor(target: CatalogCapabilityTarget): ProviderOperation[] {
	const required = new Set<ProviderOperation>();
	switch (target.kind) {
		case "product":
			required.add(`catalog.product.${target.productType}`);
			break;
		case "plan":
			required.add("catalog.product.subscription");
			if ((target.plan.trialDays ?? 0) > 0) required.add("catalog.trial");
			if (target.plan.kind === "addon") required.add("catalog.addon");
			break;
		case "price": {
			const price = target.item === null ? target.plan.basePrice : target.item.price;
			if (price === undefined || price === null) {
				throw new Error("A price capability target requires a price component");
			}
			required.add("catalog.product.subscription");
			required.add(pricingModelOperation(price));
			if (target.item !== null) {
				required.add(
					target.item.itemKind === "licensed_quantity"
						? "catalog.price.licensed"
						: "catalog.price.postpaid_usage",
				);
			}
			const hasBasePrice = target.plan.basePrice !== undefined && target.plan.basePrice !== null;
			if (hasBasePrice && target.plan.items.some((item) => isPriced(item))) {
				required.add("catalog.price.hybrid");
			}
			break;
		}
		case "topup":
			required.add("catalog.product.consumable");
			required.add("catalog.topup");
			break;
	}
	return providerOperations.filter((operation) => required.has(operation));
}

function pricingModelOperation(price: Pick<CatalogPriceIntent, "pricingModel">): ProviderOperation {
	return (price.pricingModel ?? "flat") === "flat" ? "catalog.price.flat" : "catalog.price.tiered";
}

function isPriced(item: Pick<CatalogPlanItemIntent, "price">): boolean {
	return item.price !== undefined && item.price !== null;
}
