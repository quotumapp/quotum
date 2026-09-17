import type { ProviderRegistryEntry, ProviderServiceSource } from "../contract";
import { adapterGroup, type ProviderAdapter } from "../contract";
import { googleCapabilities } from "./capabilities";
import { GooglePlayDeveloperClient } from "./client";
import { buildGooglePlayConfig } from "./config";
import { GooglePlayBillingService } from "./service";

/** Wraps a Google Play Billing service without changing what any of its methods do. */
export function wrapGoogleService(
	service: ProviderServiceSource<"google">,
	accountIdentity: string | null = null,
): ProviderAdapter<"google"> {
	return {
		provider: "google",
		declaration: googleCapabilities,
		accountIdentity,
		webhooks: {
			ingest: service.handleRtdn.bind(service),
			...(service.verifyRtdnAuthorization === undefined
				? {}
				: { verifyAuthorization: service.verifyRtdnAuthorization.bind(service) }),
		},
		replay: adapterGroup({ replayStoreEvent: service.replayStoreEvent?.bind(service) }),
		reconciliation: adapterGroup({
			reconcileSubscription: service.reconcileSubscription?.bind(service),
		}),
		purchases: {
			verify: service.verifyPurchase.bind(service),
			accountLink: service.getAccountLink.bind(service),
		},
	};
}

export const googleRegistryEntry: ProviderRegistryEntry<"google"> = {
	provider: "google",
	declaration: googleCapabilities,
	connectionKind: "google",
	overrideKey: "googlePlayBillingService",
	label: "Google Play",
	notConfiguredStatus: 501,
	accountIdentity: (config) => config.accountIdentity ?? null,
	build({ project, config, repository, clientFactories }) {
		const clientConfig = buildGooglePlayConfig(config);
		return new GooglePlayBillingService({
			config: clientConfig,
			client:
				clientFactories.google?.(clientConfig, project.projectInstanceKey) ??
				new GooglePlayDeveloperClient(clientConfig),
			repository,
		});
	},
	wrap: wrapGoogleService,
};
