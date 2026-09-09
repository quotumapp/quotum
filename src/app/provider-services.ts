import { NotConfiguredError } from "../billing/errors";
import type { BillingRepository } from "../db/repository";
import type { AppleBillingEnv, GooglePlayBillingEnv, StripeBillingEnv } from "../env";
import { noRuntimeConnections, type RuntimeConnectionResolver } from "../projects/connections";
import type { ProjectInstanceContext } from "../projects/context";
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
	connections = noRuntimeConnections,
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
	return {
		async appleStoreKitService(project, purpose = "new") {
			const override = serviceOverride(
				projectProviderServices?.[project.projectInstanceKey],
				"appleStoreKitService",
			);
			if (override !== undefined) return override;
			if (legacyServices.appleStoreKitService !== undefined)
				return legacyServices.appleStoreKitService;
			return createAppleStoreKitServiceFromConfig(
				project,
				await connections.resolve(project, "apple", purpose),
				getRepository,
			);
		},
		async googlePlayBillingService(project, purpose = "new") {
			const override = serviceOverride(
				projectProviderServices?.[project.projectInstanceKey],
				"googlePlayBillingService",
			);
			if (override !== undefined) return override;
			if (legacyServices.googlePlayBillingService !== undefined)
				return legacyServices.googlePlayBillingService;
			return createGooglePlayBillingServiceFromConfig(
				project,
				await connections.resolve(project, "google", purpose),
				getRepository,
			);
		},
		async stripeBillingService(project, purpose = "new") {
			const override = serviceOverride(
				projectProviderServices?.[project.projectInstanceKey],
				"stripeBillingService",
			);
			if (override !== undefined) return override;
			if (legacyServices.stripeBillingService !== undefined)
				return legacyServices.stripeBillingService;
			return createStripeBillingServiceFromConfig(
				project,
				await connections.resolve(project, "stripe", purpose),
				"billing_state_v1",
				getRepository,
			);
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

function createAppleStoreKitServiceFromConfig(
	project: ProjectInstanceContext,
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
	project: ProjectInstanceContext,
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
	project: ProjectInstanceContext,
	stripe: StripeBillingEnv | null,
	projectionContract: "billing_state_v1",
	getRepository: () => BillingRepository,
): StripeBillingService | null {
	if (stripe === null) {
		return null;
	}

	const config = buildStripeConfig(stripe);
	return new StripeBillingService({
		config: { ...config, projectKey: project.projectInstanceKey, projectionContract },
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
