import type { AppleBillingEnv, GooglePlayBillingEnv, StripeBillingEnv } from "../env";
import type { ProjectInstanceContext } from "./context";

export interface RuntimeConnectionConfigs {
	apple: AppleBillingEnv;
	google: GooglePlayBillingEnv;
	stripe: StripeBillingEnv;
	projection: {
		projectionUrl: string;
		projectionSecret: string;
		projectionContract: "billing_state_v1";
		/** Usage-driven snapshot delivery; absent means coalesced. */
		usageDelivery?: "coalesced" | "off";
	};
}
export type RuntimeConnectionKind = keyof RuntimeConnectionConfigs;
export type ProviderConnectionKind = Exclude<RuntimeConnectionKind, "projection">;
/** Persisted, non-secret connection state. */
export interface RuntimeConnectionDescription {
	enabled: boolean;
	/** An active version exists. */
	active: boolean;
	/** The active version was validated; no freshness window applies. */
	validated: boolean;
	validatedAt: string | null;
	accountIdentity: string | null;
	/** Scalar string and boolean settings of the active version. */
	settings: Record<string, string | boolean>;
}
/** Billing-owned port. Platform persistence and secret custody stay behind composition. */
export interface RuntimeConnectionResolver {
	resolve<K extends RuntimeConnectionKind>(
		project: ProjectInstanceContext,
		kind: K,
		purpose?: "new" | "recovery",
	): Promise<RuntimeConnectionConfigs[K] | null>;
	/**
	 * Persisted state only: never decrypts secrets, refreshes OAuth tokens or calls a provider.
	 * Null means the project has no connection row of this kind.
	 */
	describe?(
		project: ProjectInstanceContext,
		kind: ProviderConnectionKind,
	): Promise<RuntimeConnectionDescription | null>;
}
export const noRuntimeConnections: RuntimeConnectionResolver = {
	async resolve() {
		return null;
	},
	async describe() {
		return null;
	},
};
