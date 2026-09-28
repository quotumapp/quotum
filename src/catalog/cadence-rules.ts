import { assertCadence, controlCadence } from "../billing/cadence";
import { InvalidRequestError } from "../billing/errors";
import {
	type Cadence,
	cadenceFitsWithin,
	describeCadence,
	isCalendarUnit,
} from "../shared/cadence";
import type {
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogRolloverExpiryIntent,
} from "./types";

/** Rolled-over quantity can outlive its window by at most ten years (formerly 120 months). */
const maxRolloverExpirySpan: Cadence = { unit: "year", count: 10 };

export function planItemResetCadence(item: CatalogPlanItemIntent): Cadence | null {
	if (item.resetInterval === null) return null;
	return { unit: item.resetInterval, count: item.resetIntervalCount ?? 1 };
}

export function planBillingCadence(plan: CatalogPlanIntent): Cadence | null {
	return plan.billingInterval === null ? null : { unit: plan.billingInterval, count: 1 };
}

/** The cadence after which rolled-over quantity expires, or null when it never does. */
export function rolloverExpiryCadence(expiry: CatalogRolloverExpiryIntent): Cadence | null {
	if (expiry.mode === "forever") return null;
	if (expiry.mode === "months") return { unit: "month", count: expiry.months };
	return { unit: expiry.interval, count: expiry.intervalCount };
}

/** The canonical spelling of a rollover expiry: `months` becomes `after` with a month interval. */
export function normalizeRolloverExpiry(
	expiry: CatalogRolloverExpiryIntent,
): CatalogRolloverExpiryIntent {
	if (expiry.mode === "forever") return { mode: "forever" };
	const cadence = rolloverExpiryCadence(expiry);
	if (cadence === null) return { mode: "forever" };
	return { mode: "after", interval: cadence.unit, intervalCount: cadence.count };
}

/**
 * The cadence rules for a new plan: every reset and rollover expiry is a published unit with a
 * count in range and a bounded span; a reset fits its billing interval; and postpaid overage, which
 * is invoiced once per closed window, needs a window of at least a month.
 */
export function assertPlanCadences(plan: CatalogPlanIntent): void {
	const billing = planBillingCadence(plan);
	for (const item of plan.items) {
		const label = `Plan ${plan.key} item ${item.featureKey}`;
		const reset = planItemResetCadence(item);
		if (reset === null) {
			if (item.resetIntervalCount !== undefined && item.resetIntervalCount !== null) {
				throw new InvalidRequestError(`${label} resetIntervalCount requires a resetInterval`);
			}
		} else {
			assertCadence(reset, `${label} reset`);
			if (
				billing !== null &&
				(item.itemKind === "meter_limit" || item.itemKind === "allocation") &&
				!cadenceFitsWithin(reset, billing)
			) {
				throw new InvalidRequestError(
					`${label} cannot reset every ${describeCadence(reset)} on a plan billed every ${describeCadence(billing)}`,
				);
			}
			if (item.overagePolicy === "allowed" && !isCalendarUnit(reset.unit)) {
				throw new InvalidRequestError(
					`${label} can allow postpaid overage only with a reset of a month or longer; overage is invoiced once per window`,
				);
			}
		}
		const expiry =
			item.rollover === undefined || item.rollover === null
				? null
				: rolloverExpiryCadence(item.rollover.expiry);
		if (expiry !== null) assertCadence(expiry, `${label} rollover expiry`, maxRolloverExpirySpan);
	}
	for (const control of plan.controls ?? []) {
		controlCadence(control.interval, control.intervalCount, `Plan ${plan.key} control`);
	}
}
