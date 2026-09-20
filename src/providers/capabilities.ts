import type { CommercialActionIntent } from "../billing/commercial";
import type { ProductType } from "../billing/types";
import type {
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
} from "../catalog/types";
import type { RuntimeConnectionDescription } from "../projects/connections";
import {
	type BillingProvider,
	billingProviders,
	type CapabilityCondition,
	type CapabilityConfigurationFacts,
	type CapabilityFacts,
	type CapabilityLayer,
	type DeclaredProvider,
	evaluateCapability,
	isBillingProvider,
	isDeclaredProvider,
	type OperationSupport,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	providerOperations,
	type RuntimeCapabilityVerdict,
} from "../shared/provider-capabilities";
import { appleCapabilities } from "./apple/capabilities";
import type { ProviderConnectionSummary } from "./capability-read-types";
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

/** The connection state a capability read reports; nothing counts without an active version. */
export function providerConnectionSummary(
	description: RuntimeConnectionDescription | null,
): ProviderConnectionSummary {
	if (!description?.active) {
		return {
			configured: false,
			enabled: false,
			validated: false,
			validatedAt: null,
			accountIdentity: null,
		};
	}
	return {
		configured: true,
		enabled: description.enabled,
		validated: description.validated,
		validatedAt: description.validatedAt,
		accountIdentity: description.accountIdentity,
	};
}

export function connectionConfigurationFacts(
	summary: ProviderConnectionSummary,
	settings: Record<string, string | boolean> = {},
): CapabilityConfigurationFacts {
	return {
		connectionEnabled: summary.enabled,
		connectionValidated: summary.validated,
		accountFlags: settings,
	};
}

/**
 * Operations served on the recovery path. Webhooks (src/app/webhook-routes.ts) and workers
 * (src/composition/worker-providers.ts) resolve connections with purpose "recovery", which
 * `ConnectionRepository.active` serves even when the connection is disabled, so these operations
 * need a validated connection but not an enabled one.
 */
export const recoveryPurposeOperations = [
	"webhook.ingest",
	"event.replay",
	"subscription.reconcile",
	"settlement.collect_finalized_charge",
	"adjustment.issue",
	"refund.sync",
	"topup.automatic",
] as const satisfies readonly ProviderOperation[];

const runtimeDeclarations = new WeakMap<
	ProviderCapabilityDeclaration,
	ProviderCapabilityDeclaration
>();

/**
 * The declaration the runtime evaluates: every operation also requires a validated connection and,
 * off the recovery path, an enabled one. Evaluation only; status labels,
 * contracts/v1/provider-capabilities.json and the docs table render the declaration itself. The
 * copy is memoized and the source is never mutated.
 */
export function runtimeCapabilityDeclaration(
	declaration: ProviderCapabilityDeclaration,
): ProviderCapabilityDeclaration {
	const cached = runtimeDeclarations.get(declaration);
	if (cached !== undefined) return cached;
	const operations = Object.fromEntries(
		Object.entries(declaration.operations).map(([operation, support]) => [
			operation,
			runtimeOperationSupport(operation as ProviderOperation, support),
		]),
	) as Record<ProviderOperation, OperationSupport>;
	const runtime = { ...declaration, operations };
	runtimeDeclarations.set(declaration, runtime);
	return runtime;
}

function runtimeOperationSupport(
	operation: ProviderOperation,
	support: OperationSupport,
): OperationSupport {
	const kinds: Array<"connection_enabled" | "connection_validated"> = (
		recoveryPurposeOperations as readonly ProviderOperation[]
	).includes(operation)
		? ["connection_validated"]
		: ["connection_enabled", "connection_validated"];
	const implicit = kinds
		.filter((kind) => !support.conditions.some((condition) => condition.kind === kind))
		.map((kind): CapabilityCondition => ({ kind }));
	return { ...support, conditions: [...implicit, ...support.conditions] };
}

/** Runtime declarations over `base`. */
export function runtimeCapabilityLookup(
	base: ProviderCapabilityLookup = providerCapabilityCatalog,
): ProviderCapabilityLookup {
	return {
		get(provider) {
			const declaration = base.get(provider);
			return declaration === undefined ? undefined : runtimeCapabilityDeclaration(declaration);
		},
	};
}

/** Evaluates the runtime declaration of an admitted provider; `capabilities` supplies the base. */
export function evaluateRuntimeCapability(
	provider: BillingProvider,
	operation: ProviderOperation,
	facts: CapabilityFacts,
	options?: { through?: CapabilityLayer; capabilities?: ProviderCapabilityLookup },
): RuntimeCapabilityVerdict {
	const declaration = runtimeCapabilityLookup(options?.capabilities).get(provider);
	if (declaration === undefined) {
		throw new Error(`Provider ${provider} has no capability declaration`);
	}
	const verdict = evaluateCapability(declaration, operation, facts, { through: options?.through });
	return { ...verdict, provider };
}
