import type { BillingEnv } from "../env";
import { type DestinationPolicy, publicDestinationPolicy } from "../shared/safe-http";

/**
 * Where projection receivers may be. Private networks are for headless operators, who run the
 * receiving backends themselves; the merchant platform keeps public HTTPS for every merchant.
 */
export function projectionDestinationPolicy(
	env: Pick<BillingEnv, "projectionReceivers">,
	merchantPlatformEnabled: boolean,
): DestinationPolicy {
	if (env.projectionReceivers === undefined) return publicDestinationPolicy;
	if (merchantPlatformEnabled)
		throw new Error(
			"BILLING_PROJECTION_ALLOWED_NETWORKS and BILLING_PROJECTION_ALLOW_INSECURE_HTTP require QUOTUM_MERCHANT_ENABLED=false",
		);
	return env.projectionReceivers;
}
