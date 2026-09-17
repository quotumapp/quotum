import type { CommercialActionIntent } from "../billing/commercial";
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
	evaluateCapability,
	isBillingProvider,
	isDeclaredProvider,
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

/** The declarations a consumer reads; injectable so a test can vary them without a global. */
export type ProviderCapabilityLookup = Pick<
	ReadonlyMap<DeclaredProvider, ProviderCapabilityDeclaration>,
	"get"
>;

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
 * Whether the provider has built `operation`, judged on the declaration alone: the provider and
 * implementation layers, with no facts and so no configuration or per-call conditions. This is the
 * runtime's single definition of "implemented".
 */
export function implementsOperation(
	declaration: ProviderCapabilityDeclaration,
	operation: ProviderOperation,
): boolean {
	return (
		evaluateCapability(declaration, operation, {}, { through: "implementation" }).outcome ===
		"available"
	);
}

/** Admitted providers whose declaration implements `operation`, in `billingProviders` order. */
export function providersImplementing(
	operation: ProviderOperation,
	lookup: ProviderCapabilityLookup = providerCapabilityCatalog,
): BillingProvider[] {
	return billingProviders.filter((provider) => {
		const declaration = lookup.get(provider);
		return (
			declaration !== undefined &&
			declaration.availability === "available" &&
			implementsOperation(declaration, operation)
		);
	});
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

/**
 * The operations building `target` asks of a provider binding. Product types are left out: the
 * catalog rules these gates replace never checked which product types a provider sells.
 */
export function catalogConstructOperations(target: CatalogCapabilityTarget): ProviderOperation[] {
	return requiredOperationsFor(target).filter(
		(operation) => !operation.startsWith("catalog.product."),
	);
}

/** Whether a binding on `provider` can carry `target`; an undeclared provider never can. */
export function bindingImplementsCatalogTarget(
	lookup: ProviderCapabilityLookup,
	provider: string,
	target: CatalogCapabilityTarget,
): boolean {
	if (!isDeclaredProvider(provider)) return false;
	const declaration = lookup.get(provider);
	if (declaration === undefined || declaration.availability !== "available") return false;
	return catalogConstructOperations(target).every((operation) =>
		implementsOperation(declaration, operation),
	);
}

/** What a customer must do to buy credits from `provider`, once the catalog offers them. */
export function purchaseActionFor(
	provider: BillingProvider,
	lookup: ProviderCapabilityLookup = providerCapabilityCatalog,
): "purchase_required" | "provider_action_required" {
	const declaration = lookup.get(provider);
	return declaration !== undefined && implementsOperation(declaration, "topup.customer_initiated")
		? "purchase_required"
		: "provider_action_required";
}

/** The operation each commercial preview action needs from the provider that will execute it. */
export const commercialActionOperations: Record<CommercialActionIntent["kind"], ProviderOperation> =
	{
		checkout_plan: "checkout.plan",
		checkout_product: "checkout.hosted",
		subscription_change: "subscription.change.preview",
	};

/**
 * The provider a commercial preview reports. A declaration that is not admitted or has not built
 * the action is a wiring mistake, not a request error, so it throws rather than returning null.
 */
export function commercialPreviewProvider(
	declaration: ProviderCapabilityDeclaration,
	action: CommercialActionIntent["kind"],
): BillingProvider {
	const operation = commercialActionOperations[action];
	const provider = declaration.provider;
	if (!isBillingProvider(provider) || declaration.availability !== "available") {
		throw new Error(`Provider ${provider} is not admitted for ${operation}`);
	}
	if (!implementsOperation(declaration, operation)) {
		throw new Error(`Provider ${provider} does not implement ${operation}`);
	}
	return provider;
}
