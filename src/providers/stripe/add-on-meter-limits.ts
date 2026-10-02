import { BillingError } from "../../billing/errors";

export interface AddOnMeterLimitRepository {
	addOnMeterLimitConflicts?(billingAccountId: string, planVersionId: string): Promise<string[]>;
	meterLimitScopeConflicts?(billingAccountId: string, planVersionId: string): Promise<string[]>;
}

/**
 * Refuses a plan whose meter limits declare another scope than the limits the account already
 * holds on the same features (PC-04): an account cap and an entity cap on one feature have no
 * agreed combination. Base plans never conflict with each other, because an account holds one.
 */
export async function assertMeterLimitScopesAgree(
	repository: AddOnMeterLimitRepository,
	billingAccountId: string,
	plan: { planVersionId: string },
): Promise<void> {
	if (repository.meterLimitScopeConflicts === undefined) return;
	const featureKeys = await repository.meterLimitScopeConflicts(
		billingAccountId,
		plan.planVersionId,
	);
	if (featureKeys.length === 0) return;
	throw new BillingError(
		`The plan's meter limits on ${featureKeys.join(", ")} declare a different scope than the limits this billing account already holds`,
		"ADDON_METER_LIMIT_CONFLICT",
		409,
		{ details: { reason: "scope", featureKeys } },
	);
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
