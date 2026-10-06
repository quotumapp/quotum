import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
	addCadence,
	type CadenceUnit,
	cadenceUnits,
	maxExpirySeconds,
	unitHours,
	unitMonths,
} from "../../shared/cadence";

/**
 * SQL over stored cadence columns, generated from the unit table in `shared/cadence` so the
 * database and the application never disagree about a unit. Aliases and column names are code
 * constants, never caller input.
 */

function unitCase(unitColumn: string, measure: (unit: CadenceUnit) => number | null): SQL {
	const branches = cadenceUnits.flatMap((unit) => {
		const value = measure(unit);
		return value === null ? [] : [`WHEN '${unit}' THEN ${value}`];
	});
	return drizzleSql.raw(`(CASE ${unitColumn} ${branches.join(" ")} END)`);
}

/**
 * Whether a plan item's reset splits its plan version's billing period into several windows; the
 * SQL form of `periodSplits`. A fixed reset on a calendar billing interval always splits; otherwise
 * the reset splits when it is strictly shorter than the billing interval in the same measure. A
 * version without a billing cadence (an unpriced plan) bills by the subscription's recorded period,
 * so the reset splits that period, given as `period`, when it is shorter than it.
 */
export function resetSplitsBillingPeriodSql(
	itemAlias: string,
	versionAlias: string,
	period?: { start: SQL; end: SQL },
): SQL {
	const resetCount = drizzleSql.raw(`${itemAlias}.reset_interval_count`);
	const billingCount = drizzleSql.raw(`${versionAlias}.billing_interval_count`);
	const resetMonths = unitCase(`${itemAlias}.reset_interval`, unitMonths);
	const resetHours = unitCase(`${itemAlias}.reset_interval`, unitHours);
	const billingMonths = unitCase(`${versionAlias}.billing_interval`, unitMonths);
	const billingHours = unitCase(`${versionAlias}.billing_interval`, unitHours);
	const byBillingCadence = drizzleSql`COALESCE(
		(${resetHours} IS NOT NULL AND ${billingMonths} IS NOT NULL)
		OR ${resetMonths} * ${resetCount} < ${billingMonths} * ${billingCount}
		OR ${resetHours} * ${resetCount} < ${billingHours} * ${billingCount},
		false
	)`;
	if (period === undefined) return byBillingCadence;
	const billingInterval = drizzleSql.raw(`${versionAlias}.billing_interval`);
	return drizzleSql`(CASE WHEN ${billingInterval} IS NULL THEN COALESCE(
		((${period.start} AT TIME ZONE 'UTC') + ${resetIntervalSql(itemAlias)}) AT TIME ZONE 'UTC'
			< ${period.end},
		false
	) ELSE ${byBillingCadence} END)`;
}

/**
 * Whether a plan item grants a lifetime allowance: it neither resets nor expires, so a subscription
 * holds it once, from its first period until a version switch or the subscription's end ends it,
 * rather than once per period.
 */
export function lifetimeItemSql(itemAlias: string): SQL {
	return drizzleSql.raw(
		`(${itemAlias}.reset_interval IS NULL AND ${itemAlias}.expires_after_seconds IS NULL AND ${itemAlias}.expiry_interval IS NULL)`,
	);
}

/** A stored cadence (a unit column and its count column) as a Postgres interval, or NULL. */
function cadenceIntervalSql(unitColumn: string, countColumn: string): SQL {
	const branches = cadenceUnits.map((unit) => {
		const months = unitMonths(unit);
		return months === null
			? `WHEN '${unit}' THEN make_interval(hours => ${unitHours(unit)} * ${countColumn})`
			: `WHEN '${unit}' THEN make_interval(months => ${months} * ${countColumn})`;
	});
	return drizzleSql.raw(`(CASE ${unitColumn} ${branches.join(" ")} END)`);
}

/** A plan item's reset cadence as a Postgres interval, or NULL when the item does not reset. */
export function resetIntervalSql(itemAlias: string): SQL {
	return cadenceIntervalSql(`${itemAlias}.reset_interval`, `${itemAlias}.reset_interval_count`);
}

/** Whether a plan item or top-up option expires, after an exact duration or a calendar cadence. */
export function expiresSql(alias: string): SQL {
	return drizzleSql.raw(
		`(${alias}.expires_after_seconds IS NOT NULL OR ${alias}.expiry_interval IS NOT NULL)`,
	);
}

/**
 * When something anchored at `anchor` expires under the expiry columns at `alias`, or NULL when it
 * never does. A calendar expiry adds its cadence in UTC: month units add whole months to the anchor,
 * so a month-end anchor clamps to a shorter month's last day as reset windows do (`addUtcMonths`),
 * and fixed units add exact hours. An exact expiry adds its seconds.
 */
export function expiresAtSql(anchor: SQL, alias: string): SQL {
	const interval = cadenceIntervalSql(`${alias}.expiry_interval`, `${alias}.expiry_interval_count`);
	return drizzleSql`(CASE
		WHEN ${drizzleSql.raw(`${alias}.expiry_interval`)} IS NOT NULL
			THEN ((${anchor} AT TIME ZONE 'UTC') + ${interval}) AT TIME ZONE 'UTC'
		WHEN ${drizzleSql.raw(`${alias}.expires_after_seconds`)} IS NOT NULL
			THEN ${anchor} + LEAST(${drizzleSql.raw(`${alias}.expires_after_seconds`)}, ${maxExpirySeconds}::bigint) * interval '1 second'
	END)`;
}

/** A plan item's or top-up option's stored expiry. */
export interface StoredExpiry {
	expires_after_seconds: number | string | null;
	expiry_interval: CadenceUnit | null;
	expiry_interval_count: number | null;
}

/** The application form of `expiresAtSql`: when something anchored at `anchor` expires, or null. */
export function storedExpiresAt(anchor: Date, expiry: StoredExpiry): Date | null {
	if (expiry.expiry_interval !== null) {
		return addCadence(anchor, {
			unit: expiry.expiry_interval,
			count: expiry.expiry_interval_count ?? 1,
		});
	}
	if (expiry.expires_after_seconds !== null) {
		return new Date(
			anchor.getTime() + Math.min(Number(expiry.expires_after_seconds), maxExpirySeconds) * 1000,
		);
	}
	return null;
}
