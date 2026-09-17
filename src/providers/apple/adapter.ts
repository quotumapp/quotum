import type { ProviderRegistryEntry, ProviderServiceSource } from "../contract";
import { adapterGroup, type ProviderAdapter } from "../contract";
import { appleCapabilities } from "./capabilities";
import { AppleStoreKitClient, buildAppleStoreKitConfig } from "./client";
import { AppleStoreKitService } from "./service";

/** Wraps an Apple StoreKit service without changing what any of its methods do. */
export function wrapAppleService(
	service: ProviderServiceSource<"apple">,
	accountIdentity: string | null = null,
): ProviderAdapter<"apple"> {
	return {
		provider: "apple",
		declaration: appleCapabilities,
		accountIdentity,
		webhooks: { ingest: service.handleNotification.bind(service) },
		replay: adapterGroup({ replayStoreEvent: service.replayStoreEvent?.bind(service) }),
		reconciliation: adapterGroup({
			reconcileSubscription: service.reconcileSubscription?.bind(service),
		}),
		purchases: {
			verify: service.verifyPurchase.bind(service),
			accountLink: service.getOrCreateAppAccountToken.bind(service),
		},
	};
}

export const appleRegistryEntry: ProviderRegistryEntry<"apple"> = {
	provider: "apple",
	declaration: appleCapabilities,
	connectionKind: "apple",
	overrideKey: "appleStoreKitService",
	label: "Apple StoreKit",
	notConfiguredStatus: 501,
	accountIdentity: (config) => config.accountIdentity ?? null,
	build({ project, config, repository, clientFactories }) {
		const clientConfig = buildAppleStoreKitConfig(config);
		return new AppleStoreKitService({
			bundleId: config.bundleId,
			environment: config.environment,
			client:
				clientFactories.apple?.(clientConfig, project.projectInstanceKey) ??
				new AppleStoreKitClient(clientConfig),
			repository,
		});
	},
	wrap: wrapAppleService,
};
