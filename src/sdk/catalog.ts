import type { AuthoredCatalogIntent } from "../catalog/types";

/**
 * Types a catalog-as-code file. The canonical spelling (`basePrice`, `providerPriced`, item `reset`,
 * `expiry` and `overage`) is preferred; the legacy spelling is accepted until the 1.0 release
 * candidate, and preview reports it as deprecated.
 */
export function defineCatalog<T extends AuthoredCatalogIntent>(catalog: T): T {
	return catalog;
}
