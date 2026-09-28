import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { type CadenceUnit, cadenceUnits, unitHours, unitMonths } from "../../shared/cadence";

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
 * SQL form of `cadenceSplits`. A fixed reset on a calendar billing interval always splits; otherwise
 * the reset splits when it is strictly shorter than the billing interval in the same measure.
 */
export function resetSplitsBillingPeriodSql(itemAlias: string, versionAlias: string): SQL {
	const resetCount = drizzleSql.raw(`${itemAlias}.reset_interval_count`);
	const billingCount = drizzleSql.raw("1");
	const resetMonths = unitCase(`${itemAlias}.reset_interval`, unitMonths);
	const resetHours = unitCase(`${itemAlias}.reset_interval`, unitHours);
	const billingMonths = unitCase(`${versionAlias}.billing_interval`, unitMonths);
	const billingHours = unitCase(`${versionAlias}.billing_interval`, unitHours);
	return drizzleSql`COALESCE(
		(${resetHours} IS NOT NULL AND ${billingMonths} IS NOT NULL)
		OR ${resetMonths} * ${resetCount} < ${billingMonths} * ${billingCount}
		OR ${resetHours} * ${resetCount} < ${billingHours} * ${billingCount},
		false
	)`;
}

/** A plan item's reset cadence as a Postgres interval, or NULL when the item does not reset. */
export function resetIntervalSql(itemAlias: string): SQL {
	const count = `${itemAlias}.reset_interval_count`;
	const branches = cadenceUnits.map((unit) => {
		const months = unitMonths(unit);
		return months === null
			? `WHEN '${unit}' THEN make_interval(hours => ${unitHours(unit)} * ${count})`
			: `WHEN '${unit}' THEN make_interval(months => ${months} * ${count})`;
	});
	return drizzleSql.raw(`(CASE ${itemAlias}.reset_interval ${branches.join(" ")} END)`);
}
