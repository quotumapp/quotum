/**
 * Wire types of the capability and available-actions reads. They carry admitted providers only and
 * are built from persisted state, never from a provider call.
 */

import type { SubscriptionStatus } from "../billing/types";
import type { ProjectInstanceContext } from "../projects/context";
import type {
	BillingChannel,
	BillingProvider,
	RuntimeCapabilityVerdict,
} from "../shared/provider-capabilities";

/** A provider connection as persisted; `validated` applies no freshness window. */
export interface ProviderConnectionSummary {
	/** An active connection version exists. */
	configured: boolean;
	enabled: boolean;
	validated: boolean;
	validatedAt: string | null;
	accountIdentity: string | null;
}

export interface ProviderEnvironmentCapability {
	provider: BillingProvider;
	channel: BillingChannel;
	connectionKind: string;
	/** Null when the runtime cannot describe connections; verdicts are then undetermined. */
	connection: ProviderConnectionSummary | null;
	/** Every operation in contract order, evaluated through the configuration layer. */
	operations: RuntimeCapabilityVerdict[];
}

export interface ProviderEnvironmentCapabilities {
	schemaVersion: 1;
	generatedAt: string;
	providers: ProviderEnvironmentCapability[];
}

/** The subscription's pending or processing change, of which there is at most one. */
export interface SubscriptionPendingChange {
	changeId: string;
	status: "pending" | "processing";
	effectiveMode: "immediate" | "period_end";
	effectiveAt: string;
}

export interface SubscriptionAvailableActions {
	/** The provider's subscription id, as in the billing summary. */
	id: string;
	provider: BillingProvider;
	channel: BillingChannel;
	status: SubscriptionStatus;
	planKey: string | null;
	currentPeriodEnd: string | null;
	cancelAtPeriodEnd: boolean;
	pendingChange: SubscriptionPendingChange | null;
	actions: RuntimeCapabilityVerdict[];
}

export interface BillingAccountAvailableActions {
	schemaVersion: 1;
	billingAccountId: string;
	customerExists: boolean;
	generatedAt: string;
	account: RuntimeCapabilityVerdict[];
	subscriptions: SubscriptionAvailableActions[];
}

/** Read-only capability views; implementations never decrypt a secret or call a provider. */
export interface ProviderCapabilityReads {
	environment(project: ProjectInstanceContext): Promise<ProviderEnvironmentCapabilities>;
	availableActions(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<BillingAccountAvailableActions>;
}
