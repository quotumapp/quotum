import type {
	BillingChannel,
	BillingProvider,
	CatalogCompatibilityTarget,
	ProviderOperation,
	RuntimeCapabilityVerdict,
} from "../shared/provider-capabilities";

export {
	type CatalogCompatibilityTarget,
	type CatalogCompatibilityTargetKind,
	catalogCompatibilityTargetKinds,
} from "../shared/provider-capabilities";

/** Whether one provider binding of a catalog entry can be built from its declaration. */
export type CatalogProviderCompatibility = {
	target: CatalogCompatibilityTarget;
	provider: BillingProvider;
	channel: BillingChannel;
	/** The bound product, or null for a hypothetical binding the catalog does not declare. */
	productKey: string | null;
	/** Contract-ordered operations the binding needs. */
	requiredOperations: ProviderOperation[];
	/** False when any verdict is blocked; undetermined verdicts do not make a binding incompatible. */
	compatible: boolean;
	/**
	 * The required operations that are not available, blocked or undetermined, in contract order;
	 * empty when every one is available.
	 */
	verdicts: RuntimeCapabilityVerdict[];
};
