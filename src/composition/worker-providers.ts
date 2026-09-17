import type { BillingProvider } from "../billing/types";
import type { ProjectInstanceContext } from "../projects/context";
import type { ProviderAdapter } from "../providers/contract";
import type { ProviderRegistry } from "../providers/registry";
import type { AutoTopupWorkerAdapter } from "../workers/auto-topup";
import type { PromotionMaintenanceAdapter } from "../workers/promotion-maintenance";
import type { RecurringBillingWorkerAdapter } from "../workers/recurring-billing";
import type { StoreEventReplayProviders } from "../workers/store-event-replay";
import type { SubscriptionReconciliationProviders } from "../workers/subscription-reconciliation";

export interface WorkerProviderSelectors {
	storeEventReplay(
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<StoreEventReplayProviders>;
	subscriptionReconciliation(
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<SubscriptionReconciliationProviders>;
	recurringBilling(
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<RecurringBillingWorkerAdapter>;
	autoTopup(
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<AutoTopupWorkerAdapter>;
	/** Null when the project has no connection for the provider, so the worker defers the job. */
	promotionMaintenance(
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<PromotionMaintenanceAdapter | null>;
}

/**
 * Worker lookups over the shared provider registry, keyed by the provider each job stores. They
 * resolve connections for recovery, so work already queued still drains after a connection is
 * disabled for new work.
 */
export function createWorkerProviderSelectors(registry: ProviderRegistry): WorkerProviderSelectors {
	const adapterFor = (
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<ProviderAdapter | null> => registry.adapter(project, provider, "recovery");
	const configuredAdapterFor = async (
		project: ProjectInstanceContext,
		provider: BillingProvider,
	): Promise<ProviderAdapter> => {
		const adapter = await adapterFor(project, provider);
		if (adapter === null) {
			throw new Error(
				`${registry.label(provider)} is not configured for ${project.projectInstanceKey}`,
			);
		}
		return adapter;
	};

	return {
		async storeEventReplay(project, provider) {
			return onlyProvider(provider, (await adapterFor(project, provider))?.replay ?? null);
		},
		async subscriptionReconciliation(project, provider) {
			return onlyProvider(provider, (await adapterFor(project, provider))?.reconciliation ?? null);
		},
		recurringBilling: configuredAdapterFor,
		autoTopup: configuredAdapterFor,
		promotionMaintenance: adapterFor,
	};
}

/** The per-provider record the replay and reconciliation workers read, with one provider set. */
function onlyProvider<T>(
	provider: BillingProvider,
	value: T | null,
): Record<BillingProvider, T | null> {
	const providers: Record<BillingProvider, T | null> = { apple: null, google: null, stripe: null };
	providers[provider] = value;
	return providers;
}
