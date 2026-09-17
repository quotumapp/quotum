import { NotConfiguredError } from "../billing/errors";
import type { BillingRepository } from "../db/repository";
import type { RuntimeConnectionResolver } from "../projects/connections";
import { createProviderRegistry, type ProviderRegistry } from "../providers/registry";
import type {
	AppleStoreKitServiceLike,
	GooglePlayBillingServiceLike,
	ProjectProviderServiceResolver,
	ProjectProviderServiceSet,
	StripeBillingServiceLike,
} from "./types";

export function createProjectProviderServiceResolver({
	connections,
	getRepository,
	projectProviderServices,
	legacyServices,
}: {
	connections?: RuntimeConnectionResolver;
	getRepository: () => BillingRepository;
	projectProviderServices: Partial<Record<string, Partial<ProjectProviderServiceSet>>> | undefined;
	legacyServices: {
		appleStoreKitService: AppleStoreKitServiceLike | null | undefined;
		googlePlayBillingService: GooglePlayBillingServiceLike | null | undefined;
		stripeBillingService: StripeBillingServiceLike | null | undefined;
	};
}): ProjectProviderServiceResolver {
	return projectProviderServiceResolver(
		createProviderRegistry({
			connections,
			getRepository,
			overrides: projectProviderServices,
			legacyServices,
		}),
	);
}

/** The request path's per-provider service lookups, answered by the provider registry. */
export function projectProviderServiceResolver(
	registry: ProviderRegistry,
): ProjectProviderServiceResolver {
	return {
		appleStoreKitService: (project, purpose = "new") => registry.service(project, "apple", purpose),
		googlePlayBillingService: (project, purpose = "new") =>
			registry.service(project, "google", purpose),
		stripeBillingService: (project, purpose = "new") =>
			registry.service(project, "stripe", purpose),
	};
}

export function requireAppleStoreKitService(
	service: AppleStoreKitServiceLike | null,
): AppleStoreKitServiceLike {
	if (service === null) {
		throw new NotConfiguredError(
			"Apple StoreKit provider is not configured",
			"BILLING_PROVIDER_NOT_CONFIGURED",
			501,
		);
	}

	return service;
}

export function requireGooglePlayBillingService(
	service: GooglePlayBillingServiceLike | null,
): GooglePlayBillingServiceLike {
	if (service === null) {
		throw new NotConfiguredError(
			"Google Play provider is not configured",
			"BILLING_PROVIDER_NOT_CONFIGURED",
			501,
		);
	}

	return service;
}

export function requireStripeBillingService(
	service: StripeBillingServiceLike | null,
): StripeBillingServiceLike {
	if (service === null) {
		throw new NotConfiguredError(
			"Stripe provider is not configured",
			"BILLING_PROVIDER_NOT_CONFIGURED",
			503,
		);
	}

	return service;
}
