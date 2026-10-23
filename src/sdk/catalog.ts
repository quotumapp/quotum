import type { AuthoredCatalogIntent } from "../catalog/types";

/** Types a canonical catalog-as-code file with optional authoring defaults. */
export function defineCatalog<T extends AuthoredCatalogIntent>(catalog: T): T {
	return catalog;
}
