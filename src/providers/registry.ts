import type { ProjectProviderServiceSet } from "../app/types";
import { CapabilityError, NotConfiguredError } from "../billing/errors";
import type { BillingRepository } from "../db/repository";
import { noRuntimeConnections, type RuntimeConnectionResolver } from "../projects/connections";
import type { ProjectInstanceContext } from "../projects/context";
import {
	type BillingProvider,
	billingProviders,
	type CapabilityConfigurationFacts,
	type CapabilityFacts,
	type CapabilityVerdict,
	type DeclaredProvider,
	evaluateCapability,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
} from "../shared/provider-capabilities";
import { appleRegistryEntry } from "./apple/adapter";
import {
	connectionConfigurationFacts,
	providerCapabilityDeclaration,
	providerCapabilityDeclarations,
	providerConnectionSummary,
} from "./capabilities";
import type { ProviderConnectionSummary } from "./capability-read-types";
import {
	type AnyProviderAdapter,
	type AnyProviderRegistryEntry,
	adapterServesOperation,
	missingAdapterOperations,
	type ProviderAdapter,
	type ProviderClientFactories,
	type ProviderRegistryEntry,
	type ProviderServiceSource,
	type ProviderServiceTypes,
} from "./contract";
import { googleRegistryEntry } from "./google/adapter";
import { stripeRegistryEntry } from "./stripe/adapter";

export type ProviderPurpose = "new" | "recovery";

/** A provider's persisted connection state and the configuration facts it gives the evaluator. */
export interface ProviderConnectionState {
	connection: ProviderConnectionSummary | null;
	configuration: CapabilityConfigurationFacts | undefined;
}

/** Admitted providers in `billingProviders` order. */
export const defaultProviderRegistryEntries: readonly AnyProviderRegistryEntry[] = [
	appleRegistryEntry,
	googleRegistryEntry,
	stripeRegistryEntry,
];

export interface ProviderRegistryDependencies {
	connections?: RuntimeConnectionResolver;
	getRepository: () => BillingRepository;
	/** Per project instance key; an own key, even null, replaces the connection build. */
	overrides?: Partial<Record<string, Partial<ProjectProviderServiceSet>>>;
	/** App-wide services; any value other than undefined replaces the connection build. */
	legacyServices?: { [Key in keyof ProjectProviderServiceSet]?: ProjectProviderServiceSet[Key] };
	clientFactories?: ProviderClientFactories;
	entries?: readonly AnyProviderRegistryEntry[];
}

export interface ProviderRegistry {
	/** Every declaration, planned ones included. */
	declarations(): readonly ProviderCapabilityDeclaration[];
	/** Providers the runtime can build, in `billingProviders` order. */
	admitted(): BillingProvider[];
	/** The entry's human-readable name, as used in not-configured messages. */
	label(provider: BillingProvider): string;
	/** The provider service for the request path, or null when the project has none. */
	service<P extends BillingProvider>(
		project: ProjectInstanceContext,
		provider: P,
		purpose?: ProviderPurpose,
	): Promise<ProviderServiceTypes[P] | null>;
	adapter<P extends BillingProvider>(
		project: ProjectInstanceContext,
		provider: P,
		purpose?: ProviderPurpose,
	): Promise<ProviderAdapter<P> | null>;
	/**
	 * The adapter, which must have a method for `operation`. The declaration is checked first,
	 * without resolving a connection; a missing adapter or method throws not-configured.
	 */
	require<P extends BillingProvider>(
		project: ProjectInstanceContext,
		provider: P,
		operation: ProviderOperation,
		purpose?: ProviderPurpose,
	): Promise<ProviderAdapter<P>>;
	/**
	 * Connection state for capability reads, with `resolve`'s precedence: an override or legacy
	 * service counts as a configured, enabled and validated connection (none when null). Without an
	 * override it reads persisted state through the resolver's `describe`, and both fields are
	 * unknown when the resolver has none. Never resolves a connection or builds a service.
	 */
	describe(
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<ProviderConnectionState>;
	/** Evaluates the declaration against the caller's facts; providers are always named explicitly. */
	verdict(
		project: ProjectInstanceContext,
		provider: DeclaredProvider,
		operation: ProviderOperation,
		facts?: CapabilityFacts,
	): Promise<CapabilityVerdict>;
}

type ResolvedService<P extends BillingProvider> =
	| { source: "override"; service: ProviderServiceSource<P> | null }
	| {
			source: "connection";
			service: ProviderServiceSource<P> | null;
			accountIdentity: string | null;
	  };

/** Worker writes that move money and would need an uncertain-write ledger to recover. */
const uncertainWriteGuardedOperations = [
	"subscription.change.apply",
	"subscription.change.period_end",
	"settlement.collect_finalized_charge",
	"adjustment.issue",
	"topup.automatic",
] as const satisfies readonly ProviderOperation[];

function declaresImplementation(
	declaration: ProviderCapabilityDeclaration,
	operation: ProviderOperation,
): boolean {
	// Level alone decides: workers call adapter groups without consulting verification status.
	const level = declaration.operations[operation].level;
	return level === "native" || level === "quotum_composed";
}

export function createProviderRegistry({
	connections = noRuntimeConnections,
	getRepository,
	overrides,
	legacyServices,
	clientFactories = {},
	entries = defaultProviderRegistryEntries,
}: ProviderRegistryDependencies): ProviderRegistry {
	const entriesByProvider = new Map<BillingProvider, AnyProviderRegistryEntry>();
	for (const entry of entries) {
		if (entry.declaration.provider !== entry.provider) {
			throw new Error(`Provider registry entry ${entry.provider} carries another declaration`);
		}
		if (entry.declaration.availability !== "available") {
			throw new Error(`Provider ${entry.provider} is not available and cannot be registered`);
		}
		if (entry.declaration.writeSemantics.uncertainWrite === "reconcile_required") {
			const guarded = uncertainWriteGuardedOperations.filter((operation) =>
				declaresImplementation(entry.declaration, operation),
			);
			if (guarded.length > 0) {
				throw new Error(
					`Provider ${entry.provider} requires reconciliation of uncertain writes and cannot implement ${guarded.join(", ")} until an uncertain-write ledger exists`,
				);
			}
		}
		if (entriesByProvider.has(entry.provider)) {
			throw new Error(`Provider ${entry.provider} is registered twice`);
		}
		entriesByProvider.set(entry.provider, entry);
	}

	const entryFor = <P extends BillingProvider>(provider: P): ProviderRegistryEntry<P> => {
		const entry = entriesByProvider.get(provider);
		if (entry === undefined) {
			throw new Error(`Provider ${String(provider)} is not admitted by the runtime`);
		}
		return entry as unknown as ProviderRegistryEntry<P>;
	};

	/** The service replacing the connection build, null for an explicit none, undefined for none. */
	const overrideFor = <P extends BillingProvider>(
		project: ProjectInstanceContext,
		entry: ProviderRegistryEntry<P>,
	): ProviderServiceSource<P> | null | undefined => {
		const projectOverrides = overrides?.[project.projectInstanceKey];
		if (projectOverrides !== undefined && Object.hasOwn(projectOverrides, entry.overrideKey)) {
			const service = projectOverrides[entry.overrideKey] as ProviderServiceSource<P> | undefined;
			return service ?? null;
		}
		return legacyServices?.[entry.overrideKey] as ProviderServiceSource<P> | null | undefined;
	};

	const resolve = async <P extends BillingProvider>(
		project: ProjectInstanceContext,
		provider: P,
		purpose: ProviderPurpose,
	): Promise<ResolvedService<P>> => {
		const entry = entryFor(provider);
		const override = overrideFor(project, entry);
		if (override !== undefined) {
			return { source: "override", service: override };
		}
		const config = await connections.resolve(project, entry.connectionKind, purpose);
		if (config === null) {
			return { source: "connection", service: null, accountIdentity: null };
		}
		return {
			source: "connection",
			service: entry.build({
				project,
				config,
				repository: getRepository().forProject(project),
				clientFactories,
			}),
			accountIdentity: entry.accountIdentity(config),
		};
	};

	const adapter = async <P extends BillingProvider>(
		project: ProjectInstanceContext,
		provider: P,
		purpose: ProviderPurpose = "new",
	): Promise<ProviderAdapter<P> | null> => {
		const resolved = await resolve(project, provider, purpose);
		if (resolved.service === null) return null;
		const entry = entryFor(provider);
		if (resolved.source === "override") return entry.wrap(resolved.service, null);
		const built = entry.wrap(resolved.service, resolved.accountIdentity);
		const missing = missingAdapterOperations(built as AnyProviderAdapter);
		if (missing.length > 0) {
			throw new Error(
				`Provider ${provider} adapter has no method for declared operations: ${missing.join(", ")}`,
			);
		}
		return built;
	};

	return {
		declarations: () => providerCapabilityDeclarations,
		admitted: () => billingProviders.filter((provider) => entriesByProvider.has(provider)),
		label: (provider) => entryFor(provider).label,
		async service(project, provider, purpose = "new") {
			return (await resolve(project, provider, purpose)).service;
		},
		adapter,
		async require(project, provider, operation, purpose = "new") {
			const { declaration, label, notConfiguredStatus } = entryFor(provider);
			const verdict = evaluateCapability(declaration, operation, {}, { through: "implementation" });
			if (verdict.blockingLayer !== null) {
				throw new CapabilityError(
					`${label} provider does not support ${operation}`,
					verdict.blockingLayer,
					{ verdict: { ...verdict, provider } },
				);
			}
			const resolved = await adapter(project, provider, purpose);
			if (resolved === null) {
				throw new NotConfiguredError(
					`${label} provider is not configured`,
					undefined,
					notConfiguredStatus,
				);
			}
			if (!adapterServesOperation(resolved as AnyProviderAdapter, operation)) {
				throw new NotConfiguredError(
					`${label} provider does not serve ${operation}`,
					undefined,
					notConfiguredStatus,
					{ provider, operation },
				);
			}
			return resolved;
		},
		async describe(project, provider) {
			const entry = entryFor(provider);
			const override = overrideFor(project, entry);
			if (override !== undefined) {
				const present = override !== null;
				const connection: ProviderConnectionSummary = {
					configured: present,
					enabled: present,
					validated: present,
					validatedAt: null,
					accountIdentity: null,
				};
				return { connection, configuration: connectionConfigurationFacts(connection) };
			}
			if (connections.describe === undefined) {
				return { connection: null, configuration: undefined };
			}
			const description = await connections.describe(project, entry.connectionKind);
			const connection = providerConnectionSummary(description);
			return {
				connection,
				configuration: connectionConfigurationFacts(connection, description?.settings ?? {}),
			};
		},
		async verdict(_project, provider, operation, facts = {}) {
			return evaluateCapability(providerCapabilityDeclaration(provider), operation, facts);
		},
	};
}
