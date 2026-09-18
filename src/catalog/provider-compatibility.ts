import { CapabilityError } from "../billing/errors";
import {
	type CatalogCapabilityTarget,
	catalogConstructOperations,
	implementsOperation,
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
} from "../providers/capabilities";
import type {
	CatalogCompatibilityTarget,
	CatalogProviderCompatibility,
} from "../providers/catalog-compatibility-types";
import {
	evaluateCapability,
	isBillingProvider,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	type RuntimeCapabilityVerdict,
} from "../shared/provider-capabilities";
import type { CatalogIntent, CatalogPlanIntent, CatalogProviderBindingIntent } from "./types";

/** A catalog entry whose provider bindings must implement the operations its construct needs. */
export interface CatalogCapabilityEntry {
	target: CatalogCompatibilityTarget;
	construct: CatalogCapabilityTarget;
	bindings: CatalogProviderBindingIntent[];
}

/**
 * The catalog entries that ask something of their bindings, in catalog order: per plan, the plan
 * itself when it has a trial or is an add-on, then its base price and item prices; then top-ups.
 */
export function catalogCapabilityTargets(catalog: CatalogIntent): CatalogCapabilityEntry[] {
	const entries: CatalogCapabilityEntry[] = [];
	for (const plan of catalog.plans) {
		if ((plan.trialDays ?? 0) > 0 || plan.kind === "addon") {
			entries.push({
				target: { kind: "plan", key: plan.key },
				construct: { kind: "plan", plan },
				bindings: effectivePlanBindings(plan),
			});
		}
		if (plan.basePrice !== undefined && plan.basePrice !== null) {
			entries.push({
				target: { kind: "price", key: plan.key, priceKey: plan.basePrice.key },
				construct: { kind: "price", plan, item: null },
				bindings: plan.basePrice.providerBindings,
			});
		}
		for (const item of plan.items) {
			if (item.price === undefined || item.price === null) continue;
			entries.push({
				target: { kind: "price", key: plan.key, priceKey: item.price.key },
				construct: { kind: "price", plan, item },
				bindings: item.price.providerBindings,
			});
		}
	}
	for (const topup of catalog.topups) {
		entries.push({
			target: { kind: "topup", key: topup.key },
			construct: { kind: "topup" },
			bindings: topup.providerBindings,
		});
	}
	return entries;
}

/** A plan's own bindings, or its base price's when it declares none. */
function effectivePlanBindings(plan: CatalogPlanIntent): CatalogProviderBindingIntent[] {
	return plan.providerBindings.length > 0
		? plan.providerBindings
		: (plan.basePrice?.providerBindings ?? []);
}

/** Every binding of every entry, judged on the declarations alone, in catalog order. */
export function catalogProviderCompatibility(
	catalog: CatalogIntent,
	options: { capabilities?: ProviderCapabilityLookup } = {},
): CatalogProviderCompatibility[] {
	const capabilities = options.capabilities ?? providerCapabilityCatalog;
	return catalogCapabilityTargets(catalog).flatMap(({ target, construct, bindings }) => {
		const requiredOperations = catalogConstructOperations(construct);
		return bindings.map((binding) => {
			const declaration = bindingDeclaration(capabilities, binding);
			const verdicts = requiredOperations
				.filter((operation) => !implementsOperation(declaration, operation))
				.map((operation) => blockedVerdict(declaration, binding, operation));
			return {
				target,
				provider: binding.provider,
				channel: binding.channel,
				productKey: binding.productKey,
				requiredOperations,
				compatible: verdicts.length === 0,
				verdicts,
			};
		});
	});
}

/**
 * Rejects a catalog with one error that lists every binding its provider's declaration cannot
 * build, so a merchant sees all of them at once.
 */
export function assertCatalogProviderCompatibility(
	catalog: CatalogIntent,
	capabilities: ProviderCapabilityLookup,
): void {
	const incompatible = catalogProviderCompatibility(catalog, { capabilities }).filter(
		({ compatible }) => !compatible,
	);
	const [first] = incompatible;
	if (first === undefined) return;
	const operations = first.verdicts.map(({ operation }) => operation);
	const verb = operations.length === 1 ? "is" : "are";
	const others = incompatible.length - 1;
	const more = others === 0 ? "" : ` (and ${others} more)`;
	const binding = `${targetLabel(first.target)} cannot bind ${first.provider}`;
	throw new CapabilityError(
		`${binding}: ${listed(operations)} ${verb} not supported${more}`,
		first.verdicts[0]?.blockingLayer ?? "implementation",
		{ providerCompatibility: incompatible },
	);
}

function bindingDeclaration(
	capabilities: ProviderCapabilityLookup,
	binding: CatalogProviderBindingIntent,
): ProviderCapabilityDeclaration {
	const declaration = isBillingProvider(binding.provider)
		? capabilities.get(binding.provider)
		: undefined;
	if (declaration === undefined) {
		throw new Error(`Provider ${String(binding.provider)} has no capability declaration`);
	}
	return declaration;
}

function blockedVerdict(
	declaration: ProviderCapabilityDeclaration,
	binding: CatalogProviderBindingIntent,
	operation: ProviderOperation,
): RuntimeCapabilityVerdict {
	const verdict = evaluateCapability(declaration, operation, {}, { through: "implementation" });
	return { ...verdict, provider: binding.provider };
}

function targetLabel(target: CatalogCompatibilityTarget): string {
	switch (target.kind) {
		case "plan":
			return `Plan ${target.key}`;
		case "price":
			return `Plan ${target.key} price ${target.priceKey}`;
		case "topup":
			return `Top-up ${target.key}`;
	}
}

function listed(operations: ProviderOperation[]): string {
	return operations.length <= 1
		? operations.join("")
		: `${operations.slice(0, -1).join(", ")} and ${operations.at(-1)}`;
}
