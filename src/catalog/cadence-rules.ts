import { assertCadence, controlCadence } from "../billing/cadence";
import { InvalidRequestError } from "../billing/errors";
import {
	type Cadence,
	type CadenceUnit,
	cadenceFitsWithin,
	describeCadence,
	isCalendarUnit,
} from "../shared/cadence";
import type {
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
	CatalogRolloverExpiryIntent,
	CatalogTopupIntent,
} from "./types";

/** Rolled-over quantity can outlive its window by at most ten years (formerly 120 months). */
const maxRolloverExpirySpan: Cadence = { unit: "year", count: 10 };

/** A calendar expiry spans at most ten years, as a rollover expiry does. */
const maxExpirySpan: Cadence = { unit: "year", count: 10 };

/** The calendar cadence after which an allocation or a top-up expires, or null when it has none. */
export function expiryCadence(source: {
	expiryInterval?: CadenceUnit | null;
	expiryIntervalCount?: number | null;
}): Cadence | null {
	if (source.expiryInterval === undefined || source.expiryInterval === null) return null;
	return { unit: source.expiryInterval, count: source.expiryIntervalCount ?? 1 };
}

/**
 * A calendar expiry is a published unit with a count from 1 to 1,000, spans at most ten years and
 * can be hourly: it is a point in time, not a window maintenance grants. It cannot be combined with
 * an exact duration, and a count needs an interval.
 */
function assertExpiry(
	source: {
		expiresAfterSeconds: number | null;
		expiryInterval?: CadenceUnit | null;
		expiryIntervalCount?: number | null;
	},
	label: string,
): void {
	const cadence = expiryCadence(source);
	if (cadence === null) {
		if (source.expiryIntervalCount !== undefined && source.expiryIntervalCount !== null) {
			throw new InvalidRequestError(`${label} expiry count requires an interval`);
		}
		return;
	}
	if (source.expiresAfterSeconds !== null) {
		throw new InvalidRequestError(`${label} cannot expire both after seconds and on a cadence`);
	}
	assertCadence(cadence, `${label} expiry`, "window", maxExpirySpan);
}

/** The cadence rules for a new top-up: its calendar expiry, when it has one. */
export function assertTopupCadences(topup: CatalogTopupIntent): void {
	assertExpiry(topup, `Top-up ${topup.key}`);
}

export function planItemResetCadence(item: CatalogPlanItemIntent): Cadence | null {
	if (item.resetInterval === null) return null;
	return { unit: item.resetInterval, count: item.resetIntervalCount ?? 1 };
}

export function planBillingCadence(
	plan: Pick<CatalogPlanIntent, "billingInterval" | "billingIntervalCount">,
): Cadence | null {
	if (plan.billingInterval === null) return null;
	return { unit: plan.billingInterval, count: plan.billingIntervalCount ?? 1 };
}

export function priceBillingCadence(
	price: Pick<CatalogPriceIntent, "billingInterval" | "billingIntervalCount">,
): Cadence {
	return { unit: price.billingInterval, count: price.billingIntervalCount ?? 1 };
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
	if (billing === null) {
		if (plan.billingIntervalCount !== undefined && plan.billingIntervalCount !== null) {
			throw new InvalidRequestError(
				`Plan ${plan.key} billingIntervalCount requires a billingInterval`,
			);
		}
	} else {
		assertCadence(billing, `Plan ${plan.key} billing interval`, "billing");
	}
	for (const item of plan.items) {
		const label = `Plan ${plan.key} item ${item.featureKey}`;
		const reset = planItemResetCadence(item);
		if (reset === null) {
			if (item.resetIntervalCount !== undefined && item.resetIntervalCount !== null) {
				throw new InvalidRequestError(`${label} resetIntervalCount requires a resetInterval`);
			}
		} else {
			assertCadence(reset, `${label} reset`, item.itemKind === "allocation" ? "grant" : "window");
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
		if (expiry !== null) {
			assertCadence(expiry, `${label} rollover expiry`, "grant", maxRolloverExpirySpan);
		}
		assertExpiry(item, label);
	}
	for (const control of plan.controls ?? []) {
		controlCadence(control.interval, control.intervalCount, `Plan ${plan.key} control`);
	}
}
