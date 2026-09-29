import { InvalidRequestError } from "../billing/errors";
import type { CatalogIntent, CatalogPlanIntent } from "./types";

/**
 * The rules for the default plan of a new intent. An account holds it with no provider and no
 * payment, the way it holds a promotional plan grant (billing core G19), so it must be a public base
 * plan without a price (which also rules out licensed quantities, since they are priced), and hold
 * nothing else a grant cannot: entity or license-pool scopes, rollover or a trial. Every allocation
 * must reset, because a one-time allowance would be issued again each time an account falls back.
 */
export function assertDefaultPlan(catalog: CatalogIntent): void {
	const marker = catalog.defaultPlan;
	if (marker === undefined || marker === null) return;
	const refuse = (reason: string) =>
		new InvalidRequestError(`Default plan ${marker.planKey} ${reason}`);
	const plan = catalog.plans.find((candidate) => candidate.key === marker.planKey);
	if (plan === undefined) throw refuse("must be an active plan of this catalog");
	if ((plan.kind ?? "base") !== "base") throw refuse("must be a base plan");
	if ((plan.visibility ?? "public") !== "public") throw refuse("must be public");
	if (isPriced(plan)) throw refuse("must have no price or provider binding");
	if (plan.trialDays !== null) throw refuse("cannot declare a trial");
	for (const item of plan.items) {
		if ((item.allocationScope ?? "account") !== "account") {
			throw refuse(`item ${item.featureKey} must be allocated to the account`);
		}
		if (item.rollover !== undefined && item.rollover !== null) {
			throw refuse(`item ${item.featureKey} cannot roll over`);
		}
		if (item.itemKind === "allocation" && item.resetInterval === null) {
			throw refuse(`allocation ${item.featureKey} must reset`);
		}
	}
}

function isPriced(plan: CatalogPlanIntent): boolean {
	return (
		plan.currency !== null ||
		plan.baseAmountMinor !== null ||
		plan.billingInterval !== null ||
		(plan.basePrice ?? null) !== null ||
		plan.providerBindings.length > 0 ||
		plan.items.some((item) => (item.price ?? null) !== null)
	);
}
