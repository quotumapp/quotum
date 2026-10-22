import {
	type CapabilityFeasibility,
	type CapabilityFeasibilityStatus,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	providerOperations,
} from "../shared/provider-capabilities";

/** Use an explicit research date, never the generation date. */
export function assessedOn(reviewedOn: string) {
	return (
		status: CapabilityFeasibilityStatus,
		reason: string,
		...sources: CapabilityFeasibility["sources"]
	): CapabilityFeasibility => ({ status, reason, sources, reviewedOn });
}

/** Joins exhaustive research onto existing declarations without changing their runtime fields. */
export function withFeasibility(
	declaration: ProviderCapabilityDeclaration,
	assessments: Record<ProviderOperation, CapabilityFeasibility>,
): ProviderCapabilityDeclaration {
	return {
		...declaration,
		operations: Object.fromEntries(
			providerOperations.map((operation) => [
				operation,
				{ ...declaration.operations[operation], feasibility: assessments[operation] },
			]),
		) as ProviderCapabilityDeclaration["operations"],
	};
}
