import { capabilityErrorCodes } from "../billing/errors";
import { catalogProviderCompatibility } from "../catalog/provider-compatibility";
import type { CatalogIntent } from "../catalog/types";
import { BillingRepository } from "../db/repository";
import type {
	EnvironmentBillingPort,
	ReadinessCapabilityDetail,
	ReadinessConnectionState,
} from "../platform/connections/ports";
import { MerchantError } from "../platform/security";
import {
	connectionConfigurationFacts,
	evaluateRuntimeCapability,
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
	providerConnectionSummary,
	runtimeCapabilityLookup,
} from "../providers/capabilities";
import type { CatalogProviderCompatibility } from "../providers/catalog-compatibility-types";
import {
	type BillingProvider,
	billingProviders,
	type CapabilityConfigurationFacts,
	type CatalogCompatibilityTarget,
} from "../shared/provider-capabilities";
import { connectionDescription } from "./connections";
import { PostgresProjectInstanceContextResolver } from "./project-instance-persistence";

/**
 * The published catalog's bindings that the environment's connections cannot serve, one entry per
 * blocked provider operation with the catalog targets that need it, in catalog order. Reads the
 * connection rows only; undetermined verdicts are left out.
 */
export function catalogCapabilityReadiness(
	catalog: CatalogIntent,
	connections: readonly ReadinessConnectionState[],
	capabilities: ProviderCapabilityLookup = providerCapabilityCatalog,
): ReadinessCapabilityDetail[] {
	const facts = new Map<BillingProvider, CapabilityConfigurationFacts>();
	for (const provider of billingProviders) {
		if (capabilities.get(provider)?.availability !== "available") continue;
		const row = connections.find((connection) => connection.kind === provider);
		const description = row === undefined ? null : connectionDescription(row);
		facts.set(
			provider,
			connectionConfigurationFacts(providerConnectionSummary(description), description?.settings),
		);
	}
	const compatibility = catalogProviderCompatibility(catalog, {
		capabilities: runtimeCapabilityLookup(capabilities),
		through: "configuration",
		configuration: (provider) => facts.get(provider),
	});
	const judged: Pick<CatalogProviderCompatibility, "target" | "verdicts">[] = [];
	for (const plan of catalog.plans) {
		// A plan without a trial or add-on is no capability target, so its own bindings are judged
		// here, on the subscription product they sell, ahead of the plan's prices.
		if ((plan.trialDays ?? 0) <= 0 && plan.kind !== "addon") {
			for (const binding of plan.providerBindings) {
				const configuration = facts.get(binding.provider);
				if (configuration === undefined) continue;
				judged.push({
					target: { kind: "plan", key: plan.key },
					verdicts: [
						evaluateRuntimeCapability(
							binding.provider,
							"catalog.product.subscription",
							{ configuration },
							{ through: "configuration", capabilities },
						),
					],
				});
			}
		}
		judged.push(
			...compatibility.filter(({ target }) => target.kind !== "topup" && target.key === plan.key),
		);
	}
	judged.push(...compatibility.filter(({ target }) => target.kind === "topup"));
	const details = new Map<
		string,
		ReadinessCapabilityDetail & { targets: CatalogCompatibilityTarget[] }
	>();
	for (const entry of judged) {
		for (const verdict of entry.verdicts) {
			if (verdict.outcome !== "blocked" || verdict.blockingLayer === null) continue;
			const key = `${verdict.provider}:${verdict.operation}`;
			let detail = details.get(key);
			if (detail === undefined) {
				const reason = verdict.reasons.find(
					({ layer, code }) => layer === verdict.blockingLayer && code !== "FACT_UNAVAILABLE",
				);
				detail = {
					code: capabilityErrorCodes[verdict.blockingLayer].code,
					connectionKind: verdict.provider,
					provider: verdict.provider,
					operation: verdict.operation,
					targets: [],
					...(reason === undefined ? {} : { reason }),
				};
				details.set(key, detail);
			}
			const { targets } = detail;
			if (!targets.some((target) => sameTarget(target, entry.target))) targets.push(entry.target);
		}
	}
	return [...details.values()];
}

function sameTarget(left: CatalogCompatibilityTarget, right: CatalogCompatibilityTarget): boolean {
	return (
		left.kind === right.kind &&
		left.key === right.key &&
		(left.priceKey ?? null) === (right.priceKey ?? null)
	);
}

export function createEnvironmentBillingPort(): EnvironmentBillingPort {
	const repository = new BillingRepository();
	const resolver = new PostgresProjectInstanceContextResolver();
	const context = async (id: string) => {
		const result = await resolver.resolveInstanceId(id);
		if (result.kind !== "resolved")
			throw new MerchantError("CONTEXT_UNAVAILABLE", "Environment is unavailable.", 404);
		return result.context;
	};
	return {
		async catalogReadiness(id, connections) {
			const published = await repository.getPublishedCatalog(await context(id));
			const providers = new Set<string>();
			const inspect = (value: unknown): void => {
				if (!value || typeof value !== "object") return;
				if (Array.isArray(value)) {
					for (const item of value) inspect(item);
					return;
				}
				for (const [key, child] of Object.entries(value)) {
					if (key === "providerBindings" && Array.isArray(child))
						for (const binding of child) {
							if (typeof binding.provider === "string") providers.add(binding.provider);
						}
					else inspect(child);
				}
			};
			inspect(published.catalog);
			return {
				revisionId: published.revisionId,
				ready: published.catalog !== null,
				providers: [...providers],
				capabilityDetails:
					published.catalog === null
						? []
						: catalogCapabilityReadiness(published.catalog, connections),
			};
		},
		async promote(input) {
			const source = await context(input.sourceInstanceId),
				target = await context(input.targetInstanceId);
			if (
				source.logicalProjectId !== target.logicalProjectId ||
				source.environment !== "sandbox" ||
				target.environment !== "production"
			)
				throw new MerchantError(
					"INVALID_PROMOTION",
					"Promotion must stay within the same project.",
				);
			const original = await repository.getPublishedCatalog(source),
				destination = await repository.getPublishedCatalog(target);
			if (!original.catalog)
				throw new MerchantError("CATALOG_REQUIRED", "Publish a sandbox catalog first.", 409);
			// Provider product/price identifiers belong to their environment. The merchant maps live IDs
			// in the ordinary catalog workbench before previewing and publishing the reviewed revision.
			const catalog = JSON.parse(JSON.stringify(original.catalog), (key, value) =>
				key === "providerBindings" ? [] : value,
			);
			return {
				catalog,
				sourceRevisionId: original.revisionId,
				targetRevisionId: destination.revisionId,
			};
		},
	};
}
