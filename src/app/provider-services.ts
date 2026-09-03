import { BillingError, NotConfiguredError } from "../billing/errors";
import type { BillingRepository } from "../db/repository";
import type { AppleBillingEnv, BillingEnv, GooglePlayBillingEnv, StripeBillingEnv } from "../env";
import type { ProjectContext } from "../projects/context";
import { AppleStoreKitClient, buildAppleStoreKitConfig } from "../providers/apple/client";
import { AppleStoreKitService } from "../providers/apple/service";
import { GooglePlayDeveloperClient } from "../providers/google/client";
import { buildGooglePlayConfig } from "../providers/google/config";
import { GooglePlayBillingService } from "../providers/google/service";
import { buildStripeConfig, StripeBillingClient } from "../providers/stripe/client";
import { StripeBillingService } from "../providers/stripe/service";
import type {
	AppleStoreKitServiceLike,
	GooglePlayBillingServiceLike,
	ProjectProviderServiceResolver,
	ProjectProviderServiceSet,
	StripeBillingServiceLike,
} from "./types";

export function createProjectProviderServiceResolver({
	env,
	getRepository,
	projectProviderServices,
	legacyServices,
}: {
	env: BillingEnv;
	getRepository: () => BillingRepository;
	projectProviderServices: Partial<Record<string, Partial<ProjectProviderServiceSet>>> | undefined;
	legacyServices: {
		appleStoreKitService: AppleStoreKitServiceLike | null | undefined;
		googlePlayBillingService: GooglePlayBillingServiceLike | null | undefined;
		stripeBillingService: StripeBillingServiceLike | null | undefined;
	};
}): ProjectProviderServiceResolver {
	const cache = new Map<string, ProjectProviderServiceSet>();

	const servicesForProject = (project: ProjectContext) => {
		const cached = cache.get(project.projectKey);
		if (cached !== undefined) {
			return cached;
		}

		const overrides = projectProviderServices?.[project.projectKey];
		const projectConfig = env.projects.find((candidate) => candidate.key === project.projectKey);
		if (projectConfig === undefined || !projectConfig.active) {
			throw new BillingError(
				"Billing project is not configured",
				"BILLING_PROJECT_NOT_CONFIGURED",
				404,
			);
		}

		const appleOverride = serviceOverride(overrides, "appleStoreKitService");
		const googleOverride = serviceOverride(overrides, "googlePlayBillingService");
		const stripeOverride = serviceOverride(overrides, "stripeBillingService");
		const services = {
			appleStoreKitService:
				appleOverride !== undefined
					? appleOverride
					: legacyService(legacyServices.appleStoreKitService, () =>
							createAppleStoreKitServiceFromConfig(
								project,
								projectConfig.apple ?? null,
								getRepository,
							),
						),
			googlePlayBillingService:
				googleOverride !== undefined
					? googleOverride
					: legacyService(legacyServices.googlePlayBillingService, () =>
							createGooglePlayBillingServiceFromConfig(
								project,
								projectConfig.googlePlay ?? null,
								getRepository,
							),
						),
			stripeBillingService:
				stripeOverride !== undefined
					? stripeOverride
					: legacyService(legacyServices.stripeBillingService, () =>
							createStripeBillingServiceFromConfig(
								project,
								projectConfig.stripe ?? null,
								projectConfig.projectionContract ?? "billing_state_v1",
								getRepository,
							),
						),
		};
		cache.set(project.projectKey, services);
		return services;
	};

	return {
		appleStoreKitService(project) {
			return servicesForProject(project).appleStoreKitService;
		},
		googlePlayBillingService(project) {
			return servicesForProject(project).googlePlayBillingService;
		},
		stripeBillingService(project) {
			return servicesForProject(project).stripeBillingService;
		},
	};
}

function serviceOverride<Key extends keyof ProjectProviderServiceSet>(
	overrides: Partial<ProjectProviderServiceSet> | undefined,
	key: Key,
): ProjectProviderServiceSet[Key] | undefined {
	if (overrides !== undefined && Object.hasOwn(overrides, key)) {
		return overrides[key] ?? null;
	}

	return undefined;
}

function legacyService<Service>(
	legacy: Service | null | undefined,
	createDefault: () => Service | null,
): Service | null {
	return legacy === undefined ? createDefault() : legacy;
}

function createAppleStoreKitServiceFromConfig(
	project: ProjectContext,
	apple: AppleBillingEnv | null,
	getRepository: () => BillingRepository,
): AppleStoreKitService | null {
	if (apple === null) {
		return null;
	}

	return new AppleStoreKitService({
		bundleId: apple.bundleId,
		environment: apple.environment,
		client: new AppleStoreKitClient(buildAppleStoreKitConfig(apple)),
		repository: getRepository().forProject(project),
	});
}

function createGooglePlayBillingServiceFromConfig(
	project: ProjectContext,
	googlePlay: GooglePlayBillingEnv | null,
	getRepository: () => BillingRepository,
): GooglePlayBillingService | null {
	if (googlePlay === null) {
		return null;
	}

	const config = buildGooglePlayConfig(googlePlay);
	return new GooglePlayBillingService({
		config,
		client: new GooglePlayDeveloperClient(config),
		repository: getRepository().forProject(project),
	});
}

function createStripeBillingServiceFromConfig(
	project: ProjectContext,
	stripe: StripeBillingEnv | null,
	projectionContract: "billing_state_v1",
	getRepository: () => BillingRepository,
): StripeBillingService | null {
	if (stripe === null) {
		return null;
	}

	const config = buildStripeConfig(stripe);
	return new StripeBillingService({
		config: { ...config, projectKey: project.projectKey, projectionContract },
		client: new StripeBillingClient(config),
		repository: getRepository().forProject(project),
	});
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
