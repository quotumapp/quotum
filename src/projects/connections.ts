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
/** Billing-owned port. Platform persistence and secret custody stay behind composition. */
export interface RuntimeConnectionResolver {
	resolve<K extends RuntimeConnectionKind>(
		project: ProjectInstanceContext,
		kind: K,
		purpose?: "new" | "recovery",
	): Promise<RuntimeConnectionConfigs[K] | null>;
}
export const noRuntimeConnections: RuntimeConnectionResolver = {
	async resolve() {
		return null;
	},
};
