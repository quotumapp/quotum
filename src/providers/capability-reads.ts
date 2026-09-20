import type { AvailableActionFacts } from "../billing/insights";
import type { ProjectInstanceContext } from "../projects/context";
import {
	type BillingProvider,
	type CapabilityConditionKind,
	type CapabilityConfigurationFacts,
	type CapabilityOperationFacts,
	type ProviderOperation,
	providerOperations,
} from "../shared/provider-capabilities";
import {
	evaluateRuntimeCapability,
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
} from "./capabilities";
import type {
	ProviderCapabilityReads,
	SubscriptionAvailableActions,
} from "./capability-read-types";
import type { ProviderRegistry } from "./registry";

/** Operations a billing account can start, reported for every admitted provider. */
export const accountActionOperations = [
	"checkout.hosted",
	"checkout.plan",
	"purchase.verify",
	"portal.session",
	"topup.customer_initiated",
	"topup.automatic",
	"promotion.code_entry",
] as const satisfies readonly ProviderOperation[];

/** Operations reported per subscription, against the subscription's own provider. */
export const subscriptionActionOperations = [
	"subscription.change.preview",
	"subscription.change.apply",
	"subscription.change.period_end",
] as const satisfies readonly ProviderOperation[];

/**
 * Condition kinds the available-actions facts decide. Any other kind on these operations would
 * always read as undetermined, so a test keeps the admitted declarations within these lists.
 */
export const accountActionConditionKinds = [
	"connection_enabled",
	"connection_validated",
	"account_flag",
	"saved_payment_method",
] as const satisfies readonly CapabilityConditionKind[];

export const subscriptionActionConditionKinds = [
	...accountActionConditionKinds,
	"subscription_state",
	"renewal_exclusion_window",
] as const satisfies readonly CapabilityConditionKind[];

export interface AvailableActionFactsReader {
	getAvailableActionFacts(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<AvailableActionFacts>;
}

/** Only a provider call could tell whether a saved payment method exists, so none is made. */
const paymentMethodFacts: CapabilityOperationFacts = { savedPaymentMethod: "unknown" };

/**
 * Capability reads over persisted connection state and billing rows. The registry is narrowed to
 * `admitted` and `describe`, so a read can never resolve a connection, build a service or call a
 * provider.
 */
export function createProviderCapabilityReads(deps: {
	registry: Pick<ProviderRegistry, "admitted" | "describe">;
	facts: AvailableActionFactsReader;
	capabilities?: ProviderCapabilityLookup;
	now?: () => Date;
}): ProviderCapabilityReads {
	const capabilities = deps.capabilities ?? providerCapabilityCatalog;
	const now = deps.now ?? (() => new Date());
	const withConfiguration = (configuration: CapabilityConfigurationFacts | undefined) =>
		configuration === undefined ? {} : { configuration };

	return {
		async environment(project) {
			const generatedAt = now().toISOString();
			const providers = await Promise.all(
				deps.registry.admitted().map(async (provider) => {
					const state = await deps.registry.describe(project, provider);
					const declaration = capabilities.get(provider);
					if (declaration === undefined) {
						throw new Error(`Provider ${provider} has no capability declaration`);
					}
					const facts = withConfiguration(state.configuration);
					return {
						provider,
						channel: declaration.channel,
						connectionKind: declaration.connectionKind,
						connection: state.connection,
						operations: providerOperations.map((operation) =>
							evaluateRuntimeCapability(provider, operation, facts, {
								through: "configuration",
								capabilities,
							}),
						),
					};
				}),
			);
			return { schemaVersion: 1, generatedAt, providers };
		},

		async availableActions(project, billingAccountId) {
			const generatedAt = now().toISOString();
			const admitted = deps.registry.admitted();
			const [states, facts] = await Promise.all([
				Promise.all(admitted.map((provider) => deps.registry.describe(project, provider))),
				deps.facts.getAvailableActionFacts(project, billingAccountId),
			]);
			const configurations = new Map<BillingProvider, CapabilityConfigurationFacts | undefined>(
				admitted.map((provider, index) => [provider, states[index]?.configuration]),
			);
			const configurationOf = (provider: BillingProvider) =>
				withConfiguration(configurations.get(provider));

			const account = admitted.flatMap((provider) =>
				accountActionOperations.map((operation) =>
					evaluateRuntimeCapability(
						provider,
						operation,
						{ ...configurationOf(provider), operation: paymentMethodFacts },
						{ through: "operation", capabilities },
					),
				),
			);
			const subscriptions = facts.subscriptions.map(
				(subscription): SubscriptionAvailableActions => {
					const operation: CapabilityOperationFacts = {
						...paymentMethodFacts,
						subscriptionState: subscription.status,
						now: generatedAt,
						...(subscription.currentPeriodEnd === null
							? {}
							: { nextRenewalAt: subscription.currentPeriodEnd }),
					};
					return {
						id: subscription.externalSubscriptionId,
						provider: subscription.provider,
						channel: subscription.channel,
						status: subscription.status,
						planKey: subscription.planKey,
						currentPeriodEnd: subscription.currentPeriodEnd,
						cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
						pendingChange: subscription.pendingChange,
						actions: subscriptionActionOperations.map((action) =>
							evaluateRuntimeCapability(
								subscription.provider,
								action,
								{ ...configurationOf(subscription.provider), operation },
								{ through: "operation", capabilities },
							),
						),
					};
				},
			);
			return {
				schemaVersion: 1,
				billingAccountId,
				customerExists: facts.customerExists,
				generatedAt,
				account,
				subscriptions,
			};
		},
	};
}
