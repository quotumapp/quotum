import { type BillingProvider, billingProviders } from "../../billing/types";

/**
 * Provider enum values derived from `billingProviders`. Wire schemas that published a different
 * order name their leading providers so the generated contract keeps its enum order; every other
 * provider follows in declaration order.
 */
export function billingProviderValues(
	...leading: BillingProvider[]
): [BillingProvider, ...BillingProvider[]] {
	const rest = billingProviders.filter((provider) => !leading.includes(provider));
	return [...leading, ...rest] as [BillingProvider, ...BillingProvider[]];
}
