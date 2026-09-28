import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { resetIntervalSql, resetSplitsBillingPeriodSql } from "../../src/db/repository/cadence-sql";
import { executeRows } from "../../src/db/repository/query";
import type { QueryExecutor } from "../../src/db/repository/types";
import {
	addCadence,
	type BillingCadenceUnit,
	billingCadenceUnits,
	type Cadence,
	type CadenceUnit,
	cadenceSplits,
	cadenceUnits,
} from "../../src/shared/cadence";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);

const counts = [1, 2, 3, 12];
const billings: Array<{ unit: BillingCadenceUnit | null; count: number }> = [
	...billingCadenceUnits.flatMap((unit) => [1, 3].map((count) => ({ unit, count }))),
	{ unit: null, count: 1 },
];

localDescribe("cadence SQL", () => {
	let context: LocalPostgresContext;
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("splits a billing period exactly when the application does", async () => {
		const resets = cadenceUnits.flatMap((unit) => counts.map((count) => ({ unit, count })));
		const rows = await executeRows<{
			reset_interval: CadenceUnit;
			reset_interval_count: number;
			billing_interval: BillingCadenceUnit | null;
			billing_interval_count: number;
			splits: boolean;
		}>(
			context.db as unknown as QueryExecutor,
			drizzleSql`
				SELECT pi.reset_interval, pi.reset_interval_count, pv.billing_interval,
					pv.billing_interval_count, ${resetSplitsBillingPeriodSql("pi", "pv")} AS splits
				FROM (VALUES ${drizzleSql.join(
					resets.map(({ unit, count }) => drizzleSql`(${unit}::text, ${count}::integer)`),
					drizzleSql`, `,
				)}) AS pi(reset_interval, reset_interval_count)
				CROSS JOIN (VALUES ${drizzleSql.join(
					billings.map(({ unit, count }) => drizzleSql`(${unit}::text, ${count}::integer)`),
					drizzleSql`, `,
				)}) AS pv(billing_interval, billing_interval_count)
			`,
		);
		expect(rows).toHaveLength(resets.length * billings.length);
		for (const row of rows) {
			const reset: Cadence = { unit: row.reset_interval, count: row.reset_interval_count };
			const billing: Cadence | null =
				row.billing_interval === null
					? null
					: { unit: row.billing_interval, count: row.billing_interval_count };
			expect({ reset, billing, splits: row.splits }).toEqual({
				reset,
				billing,
				splits: cadenceSplits(reset, billing),
			});
		}
	});

	it("adds a reset interval the way the application does away from month ends", async () => {
		const start = new Date("2026-01-15T09:30:00.000Z");
		const resets = cadenceUnits.flatMap((unit) => counts.map((count) => ({ unit, count })));
		const rows = await executeRows<{
			reset_interval: CadenceUnit;
			reset_interval_count: number;
			ends_at: Date | string;
		}>(
			context.db as unknown as QueryExecutor,
			drizzleSql`
				SELECT pi.reset_interval, pi.reset_interval_count,
					((${start.toISOString()}::timestamptz AT TIME ZONE 'UTC') + ${resetIntervalSql("pi")})
						AT TIME ZONE 'UTC' AS ends_at
				FROM (VALUES ${drizzleSql.join(
					resets.map(({ unit, count }) => drizzleSql`(${unit}::text, ${count}::integer)`),
					drizzleSql`, `,
				)}) AS pi(reset_interval, reset_interval_count)
			`,
		);
		expect(rows).toHaveLength(resets.length);
		for (const row of rows) {
			const reset: Cadence = { unit: row.reset_interval, count: row.reset_interval_count };
			expect({ reset, endsAt: new Date(row.ends_at).toISOString() }).toEqual({
				reset,
				endsAt: addCadence(start, reset).toISOString(),
			});
		}
	});
});
