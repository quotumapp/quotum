import { describe, expect, it } from "bun:test";
import { workerRetryAtSql, workerStaleBeforeSql } from "../../src/db/repository/worker-clock";
import { renderDrizzleSql, renderDrizzleSqlParams } from "../helpers/drizzle-sql";

describe("database worker durations", () => {
	it("keeps terminal retries null and zero-delay retries on the database clock", () => {
		expect(renderDrizzleSql(workerRetryAtSql(null))).toContain("NULL::timestamptz");
		expect(renderDrizzleSql(workerRetryAtSql(0))).toContain("clock_timestamp()");
		expect(renderDrizzleSqlParams(workerRetryAtSql(0))).toEqual([0]);
		expect(renderDrizzleSql(workerStaleBeforeSql(300_000))).toContain("statement_timestamp()");
		expect(renderDrizzleSqlParams(workerStaleBeforeSql(300_000))).toEqual([300_000]);
	});

	it("rejects invalid durations before producing a persistence statement", () => {
		for (const duration of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
			expect(() => workerRetryAtSql(duration)).toThrow("nonnegative integer");
			expect(() => workerStaleBeforeSql(duration)).toThrow("positive integer");
		}
		expect(() => workerStaleBeforeSql(0)).toThrow("positive integer");
	});
});
