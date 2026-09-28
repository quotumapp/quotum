import { CapabilityError } from "../billing/errors";
import {
	type CatalogCapabilityTarget,
	catalogConstructOperations,
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
} from "../providers/capabilities";
import type {
	CatalogCompatibilityTarget,
	CatalogProviderCompatibility,
} from "../providers/catalog-compatibility-types";
import { type CadenceUnit, describeCadence } from "../shared/cadence";
import {
	type BillingChannel,
	type BillingProvider,
	billingProviders,
	type CapabilityConfigurationFacts,
	type CapabilityFacts,
	conditionReasonCode,
	declaresBillingCadence,
	evaluateCapability,
	isBillingProvider,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	type RuntimeCapabilityVerdict,
} from "../shared/provider-capabilities";
import { planBillingCadence } from "./cadence-rules";
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

/** How {@link catalogProviderCompatibility} judges a catalog; the defaults are the publish gate. */
export interface CatalogProviderCompatibilityOptions {
	capabilities?: ProviderCapabilityLookup;
	/**
	 * The last layer judged: `implementation` reads the declarations alone, while `configuration`
	 * also checks each provider's connection. Per-call conditions never apply to a catalog, so
	 * `operation` is not a choice.
	 */
	through?: "implementation" | "configuration";
	/**
	 * The connection facts of `provider`, read only through `configuration`. Undefined means they
	 * are unknown, so its connection conditions come back undetermined.
	 */
	configuration?: (provider: BillingProvider) => CapabilityConfigurationFacts | undefined;
	/**
	 * Also judges, after each entry's bindings, one hypothetical binding per available admitted
	 * provider the entry does not bind, in `billingProviders` order.
	 */
	includeUnbound?: boolean;
}

/**
 * Every binding of every entry, in catalog order, judged on the declarations alone unless
 * `through` is `configuration`. A binding is compatible unless one of its verdicts is blocked.
 */
export function catalogProviderCompatibility(
	catalog: CatalogIntent,
	options: CatalogProviderCompatibilityOptions = {},
): CatalogProviderCompatibility[] {
	const capabilities = options.capabilities ?? providerCapabilityCatalog;
	const through = options.through ?? "implementation";
	const factsFor = (provider: BillingProvider): CapabilityFacts => {
		if (through !== "configuration") return {};
		const configuration = options.configuration?.(provider);
		return configuration === undefined ? {} : { configuration };
	};
	return catalogCapabilityTargets(catalog).flatMap(({ target, construct, bindings }) => {
		const requiredOperations = catalogConstructOperations(construct);
		const judge = (
			declaration: ProviderCapabilityDeclaration,
			provider: BillingProvider,
			channel: BillingChannel,
			productKey: string | null,
		): CatalogProviderCompatibility => {
			const facts = factsFor(provider);
			const verdicts = requiredOperations
				.map(
					(operation): RuntimeCapabilityVerdict => ({
						...evaluateCapability(declaration, operation, facts, { through }),
						provider,
					}),
				)
				.filter(({ outcome }) => outcome !== "available");
			return {
				target,
				provider,
				channel,
				productKey,
				requiredOperations,
				compatible: verdicts.every(({ outcome }) => outcome !== "blocked"),
				verdicts,
			};
		};
		const entries = bindings.map((binding) =>
			judge(
				bindingDeclaration(capabilities, binding),
				binding.provider,
				binding.channel,
				binding.productKey,
			),
		);
		if (options.includeUnbound !== true) return entries;
		for (const provider of billingProviders) {
			const declaration = capabilities.get(provider);
			if (declaration?.availability !== "available") continue;
			if (bindings.some((binding) => binding.provider === provider)) continue;
			entries.push(judge(declaration, provider, declaration.channel, null));
		}
		return entries;
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
	const incompatible = inCatalogOrder(catalog, [
		...catalogProviderCompatibility(catalog, { capabilities }).filter(
			({ compatible }) => !compatible,
		),
		...catalogBillingCadenceIncompatibility(catalog, capabilities),
	]);
	const [first] = incompatible;
	if (first === undefined) return;
	const operations = first.verdicts.map(({ operation }) => operation);
	const verb = operations.length === 1 ? "is" : "are";
	const others = incompatible.length - 1;
	const more = others === 0 ? "" : ` (and ${others} more)`;
	const binding = `${targetLabel(first.target)} cannot bind ${first.provider}`;
	const interval = first.verdicts
		.flatMap(({ reasons }) => reasons)
		.find(({ code }) => code === conditionReasonCode.billing_interval)?.observed;
	const problem =
		interval === undefined
			? `${listed(operations)} ${verb} not supported`
			: `it does not bill every ${describeCadence({
					unit: interval.billingInterval as CadenceUnit,
					count: Number(interval.billingIntervalCount),
				})}`;
	throw new CapabilityError(
		`${binding}: ${problem}${more}`,
		first.verdicts[0]?.blockingLayer ?? "implementation",
		{ providerCompatibility: incompatible },
	);
}

/**
 * The bindings whose provider does not sell their plan's billing interval: a plan's own bindings
 * sell the subscription product, and each price recurs at the plan's interval. The subscription
 * operation is what fails, at the provider layer, because no configuration can change it.
 */
export function catalogBillingCadenceIncompatibility(
	catalog: CatalogIntent,
	capabilities: ProviderCapabilityLookup,
): CatalogProviderCompatibility[] {
	const operation: ProviderOperation = "catalog.product.subscription";
	const entries: CatalogProviderCompatibility[] = [];
	for (const plan of catalog.plans) {
		const cadence = planBillingCadence(plan);
		if (cadence === null) continue;
		const judged: Array<{
			target: CatalogCompatibilityTarget;
			bindings: CatalogProviderBindingIntent[];
		}> = [
			{ target: { kind: "plan", key: plan.key }, bindings: plan.providerBindings },
			...[plan.basePrice ?? null, ...plan.items.map((item) => item.price ?? null)]
				.filter((price) => price !== null)
				.map((price) => ({
					target: { kind: "price" as const, key: plan.key, priceKey: price.key },
					bindings: price.providerBindings,
				})),
		];
		for (const { target, bindings } of judged) {
			for (const binding of bindings) {
				const declaration = bindingDeclaration(capabilities, binding);
				if (declaresBillingCadence(declaration, cadence)) continue;
				entries.push({
					target,
					provider: binding.provider,
					channel: binding.channel,
					productKey: binding.productKey,
					requiredOperations: [operation],
					compatible: false,
					verdicts: [
						{
							provider: binding.provider,
							operation,
							outcome: "blocked",
							level: declaration.operations[operation].level,
							blockingLayer: "provider",
							reasons: [
								{
									code: conditionReasonCode.billing_interval,
									layer: "provider",
									observed: {
										billingInterval: cadence.unit,
										billingIntervalCount: cadence.count,
									},
									resolution: { kind: "none" },
								},
							],
						},
					],
				});
			}
		}
	}
	return entries;
}

/**
 * Orders incompatible bindings as the catalog lists their entries, merging two reports on one
 * binding into a single entry.
 */
function inCatalogOrder(
	catalog: CatalogIntent,
	entries: CatalogProviderCompatibility[],
): CatalogProviderCompatibility[] {
	const positions = new Map<string, number>();
	const position = (target: CatalogCompatibilityTarget) => {
		const key = `${target.kind}:${target.key}:${target.priceKey ?? ""}`;
		if (!positions.has(key)) positions.set(key, positions.size);
		return key;
	};
	for (const plan of catalog.plans) {
		position({ kind: "plan", key: plan.key });
		if (plan.basePrice !== undefined && plan.basePrice !== null) {
			position({ kind: "price", key: plan.key, priceKey: plan.basePrice.key });
		}
		for (const item of plan.items) {
			if (item.price !== undefined && item.price !== null) {
				position({ kind: "price", key: plan.key, priceKey: item.price.key });
			}
		}
	}
	for (const topup of catalog.topups) position({ kind: "topup", key: topup.key });
	const merged = new Map<string, CatalogProviderCompatibility & { order: number }>();
	for (const [index, entry] of entries.entries()) {
		const key = `${position(entry.target)}|${entry.provider}|${entry.productKey ?? ""}`;
		const existing = merged.get(key);
		if (existing === undefined) {
			merged.set(key, { ...entry, order: index });
			continue;
		}
		existing.compatible = false;
		existing.requiredOperations = [
			...new Set([...existing.requiredOperations, ...entry.requiredOperations]),
		];
		existing.verdicts = [...existing.verdicts, ...entry.verdicts];
	}
	return [...merged.entries()]
		.sort(([left, a], [right, b]) => {
			const byTarget =
				(positions.get(left.split("|")[0] ?? "") ?? 0) -
				(positions.get(right.split("|")[0] ?? "") ?? 0);
			return byTarget !== 0 ? byTarget : a.order - b.order;
		})
		.map(([, { order: _order, ...entry }]) => entry);
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
