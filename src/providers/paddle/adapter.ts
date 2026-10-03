import type { ProviderRegistryEntry } from "../contract";
import { adapterGroup } from "../contract";
import { paddleCapabilities } from "./capabilities";
import { PaddleBillingService } from "./service";

export const paddleRegistryEntry: ProviderRegistryEntry<"paddle"> = {
	provider: "paddle",
	declaration: paddleCapabilities,
	connectionKind: "paddle",
	overrideKey: "paddleBillingService",
	label: "Paddle",
	notConfiguredStatus: 503,
	accountIdentity: (config) => config.accountIdentity,
	build: ({ project, config, repository, providerOperations }) =>
		new PaddleBillingService(project, config, repository, providerOperations),
	wrap: (service, accountIdentity) => ({
		provider: "paddle",
		declaration: paddleCapabilities,
		accountIdentity,
		commercial: adapterGroup({
			preview: service.previewCommercialAction?.bind(service),
			execute: service.executeCommercialAction?.bind(service),
		}),
		webhooks: { ingest: service.handleWebhook.bind(service) },
		checkout: {
			createHosted: service.createCheckoutSession.bind(service),
			status: service.getCheckoutSessionStatus.bind(service),
		},
		replay: adapterGroup({ replayStoreEvent: service.replayStoreEvent?.bind(service) }),
		reconciliation: adapterGroup({
			reconcileSubscription: service.reconcileSubscription?.bind(service),
		}),
	}),
};
