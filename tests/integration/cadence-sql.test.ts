import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import {
	expiresAtSql,
	resetIntervalSql,
	resetSplitsBillingPeriodSql,
	storedExpiresAt,
} from "../../src/db/repository/cadence-sql";
import { periodSplits } from "../../src/db/repository/meter-limit-windows";
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
	maxExpirySeconds,
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

	it("splits a recorded period exactly when the application does for a version without a cadence", async () => {
		const periods = [
			{ start: new Date("2026-01-31T09:30:00.000Z"), end: new Date("2026-02-28T09:30:00.000Z") },
			{ start: new Date("2026-03-10T00:00:00.000Z"), end: new Date("2027-03-10T00:00:00.000Z") },
			{ start: new Date("2026-03-10T00:00:00.000Z"), end: new Date("2026-03-11T00:00:00.000Z") },
		];
		const resets = cadenceUnits.flatMap((unit) => counts.map((count) => ({ unit, count })));
		for (const period of periods) {
			const rows = await executeRows<{
				reset_interval: CadenceUnit;
				reset_interval_count: number;
				splits: boolean;
			}>(
				context.db as unknown as QueryExecutor,
				drizzleSql`
					SELECT pi.reset_interval, pi.reset_interval_count,
						${resetSplitsBillingPeriodSql("pi", "pv", {
							start: drizzleSql`${period.start.toISOString()}::timestamptz`,
							end: drizzleSql`${period.end.toISOString()}::timestamptz`,
						})} AS splits
					FROM (VALUES ${drizzleSql.join(
						resets.map(({ unit, count }) => drizzleSql`(${unit}::text, ${count}::integer)`),
						drizzleSql`, `,
					)}) AS pi(reset_interval, reset_interval_count)
					CROSS JOIN (VALUES (NULL::text, 1::integer)) AS pv(billing_interval, billing_interval_count)
				`,
			);
			expect(rows).toHaveLength(resets.length);
			for (const row of rows) {
				const reset: Cadence = { unit: row.reset_interval, count: row.reset_interval_count };
				expect({ reset, period, splits: row.splits }).toEqual({
					reset,
					period,
					splits: periodSplits(reset, null, period.start, period.end),
				});
			}
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

	it("expires a calendar cadence the way the application does, at month ends and leap days", async () => {
		const anchors = [
			"2026-01-15T09:30:00.000Z",
			"2028-01-31T23:30:00.000Z",
			"2028-02-29T12:00:00.000Z",
			"2027-03-01T00:00:00.000Z",
			"2026-08-31T06:00:00.000Z",
		];
		const expiries = cadenceUnits.flatMap((unit) =>
			counts.map((count) => ({ seconds: null, unit, count })),
		);
		const rows = await executeRows<{
			anchor: Date | string;
			expires_after_seconds: string | null;
			expiry_interval: CadenceUnit | null;
			expiry_interval_count: number;
			expires_at: Date | string | null;
		}>(
			context.db as unknown as QueryExecutor,
			drizzleSql`
				SELECT anchors.anchor, item.expires_after_seconds, item.expiry_interval,
					item.expiry_interval_count, ${expiresAtSql(drizzleSql`anchors.anchor`, "item")} AS expires_at
				FROM (VALUES ${drizzleSql.join(
					anchors.map((anchor) => drizzleSql`(${anchor}::timestamptz)`),
					drizzleSql`, `,
				)}) AS anchors(anchor)
				CROSS JOIN (VALUES ${drizzleSql.join(
					[
						...expiries,
						{ seconds: 31_536_000, unit: null, count: 1 },
						{ seconds: maxExpirySeconds, unit: null, count: 1 },
						{ seconds: maxExpirySeconds + 1, unit: null, count: 1 },
						{ seconds: 9_000_000_000_000, unit: null, count: 1 },
						{ seconds: Number.MAX_SAFE_INTEGER, unit: null, count: 1 },
						{ seconds: null, unit: null, count: 1 },
					].map(
						({ seconds, unit, count }) =>
							drizzleSql`(${seconds}::bigint, ${unit}::text, ${count}::integer)`,
					),
					drizzleSql`, `,
				)}) AS item(expires_after_seconds, expiry_interval, expiry_interval_count)
			`,
		);
		expect(rows).toHaveLength(anchors.length * (expiries.length + 6));
		for (const row of rows) {
			const anchor = new Date(row.anchor);
			const expected = storedExpiresAt(anchor, row);
			expect({
				anchor: anchor.toISOString(),
				interval: row.expiry_interval,
				count: row.expiry_interval_count,
				seconds: row.expires_after_seconds,
				expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
			}).toEqual({
				anchor: anchor.toISOString(),
				interval: row.expiry_interval,
				count: row.expiry_interval_count,
				seconds: row.expires_after_seconds,
				expiresAt: expected?.toISOString() ?? null,
			});
		}
		const at = (anchor: string, unit: CadenceUnit | null, count: number, seconds?: number) =>
			storedExpiresAt(new Date(anchor), {
				expires_after_seconds: seconds ?? null,
				expiry_interval: unit,
				expiry_interval_count: count,
			})?.toISOString();
		// A year after a leap day ends on the last day of February; a year after March 1 keeps the
		// date across a leap year, where 365 days of seconds fall a day short.
		expect(at("2028-02-29T12:00:00.000Z", "year", 1)).toBe("2029-02-28T12:00:00.000Z");
		expect(at("2027-03-01T00:00:00.000Z", "year", 1)).toBe("2028-03-01T00:00:00.000Z");
		expect(at("2027-03-01T00:00:00.000Z", null, 1, 31_536_000)).toBe("2028-02-29T00:00:00.000Z");
		// A month-end anchor clamps to a shorter month and recovers its day afterwards.
		expect(at("2028-01-31T23:30:00.000Z", "month", 1)).toBe("2028-02-29T23:30:00.000Z");
		expect(at("2028-01-31T23:30:00.000Z", "month", 2)).toBe("2028-03-31T23:30:00.000Z");
		expect(at("2026-08-31T06:00:00.000Z", "quarter", 1)).toBe("2026-11-30T06:00:00.000Z");
		expect(at("2026-01-15T09:30:00.000Z", "week", 2)).toBe("2026-01-29T09:30:00.000Z");
		expect(at("2026-01-15T09:30:00.000Z", null, 1)).toBeUndefined();
		// A stored duration beyond ten years expires at ten years, in the database and here alike.
		expect(at("2026-01-15T09:30:00.000Z", null, 1, 9_000_000_000_000)).toBe(
			new Date(Date.parse("2026-01-15T09:30:00.000Z") + maxExpirySeconds * 1000).toISOString(),
		);
	});
});
