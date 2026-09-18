import type {
	BillingChannel,
	BillingProvider,
	ProviderOperation,
	RuntimeCapabilityVerdict,
} from "../shared/provider-capabilities";

export const catalogCompatibilityTargetKinds = ["plan", "price", "topup"] as const;
export type CatalogCompatibilityTargetKind = (typeof catalogCompatibilityTargetKinds)[number];

/**
 * The catalog entry a binding belongs to: `key` is the plan or top-up key, and `priceKey` names
 * the plan's base or item price for a `price` target.
 */
export type CatalogCompatibilityTarget = {
	kind: CatalogCompatibilityTargetKind;
	key: string;
	priceKey?: string | null;
};

/** Whether one provider binding of a catalog entry can be built from its declaration. */
export type CatalogProviderCompatibility = {
	target: CatalogCompatibilityTarget;
	provider: BillingProvider;
	channel: BillingChannel;
	productKey: string | null;
	/** Contract-ordered operations the binding needs. */
	requiredOperations: ProviderOperation[];
	compatible: boolean;
	/** The blocked verdicts, in contract order; empty when `compatible`. */
	verdicts: RuntimeCapabilityVerdict[];
};
