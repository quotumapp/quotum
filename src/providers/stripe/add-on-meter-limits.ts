import { BillingError } from "../../billing/errors";

export interface AddOnMeterLimitRepository {
	addOnMeterLimitConflicts?(billingAccountId: string, planVersionId: string): Promise<string[]>;
}

/**
 * Refuses an add-on whose meter limits could not add up with the ones the account already holds
 * on the same features: an add-on's limit adds its quantity to theirs within one window, which
 * needs hard caps with the same reset. Publication refuses such a catalog, so this catches an
 * account whose other plans were bought from an earlier revision.
 */
export async function assertAddOnMeterLimitsCombine(
	repository: AddOnMeterLimitRepository,
	billingAccountId: string,
	plan: { kind: "base" | "addon"; planVersionId: string },
): Promise<void> {
	if (plan.kind !== "addon" || repository.addOnMeterLimitConflicts === undefined) return;
	const featureKeys = await repository.addOnMeterLimitConflicts(
		billingAccountId,
		plan.planVersionId,
	);
	if (featureKeys.length === 0) return;
	throw new BillingError(
		`The add-on's meter limits on ${featureKeys.join(", ")} cannot add to the limits this billing account holds`,
		"ADDON_METER_LIMIT_CONFLICT",
		409,
		{ details: { featureKeys } },
	);
}
