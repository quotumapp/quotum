import { type BillingProvider, billingProviders } from "../../billing/types";

/**
 * Provider enum values derived from `billingProviders`. Wire schemas that published a different
 * order name their leading providers so the generated contract keeps its enum order; every other
 * provider follows in declaration order. A repeated leading provider is listed once.
 */
export function billingProviderValues(
	...leading: BillingProvider[]
): [BillingProvider, ...BillingProvider[]] {
	const first = [...new Set(leading)];
	const rest = billingProviders.filter((provider) => !first.includes(provider));
	return [...first, ...rest] as [BillingProvider, ...BillingProvider[]];
}
