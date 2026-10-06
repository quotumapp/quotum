import { describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { expiresAtSql, storedExpiresAt } from "../../src/db/repository/cadence-sql";
import { maxExpirySeconds } from "../../src/shared/cadence";
import { renderDrizzleSql } from "../helpers/drizzle-sql";

const anchor = new Date("2026-10-06T00:00:00.000Z");
const none = { expiry_interval: null, expiry_interval_count: null } as const;

describe("exact-duration expiry in stored catalogs", () => {
	it("adds the stored seconds up to the bound", () => {
		expect(storedExpiresAt(anchor, { ...none, expires_after_seconds: 3_600 })?.toISOString()).toBe(
			"2026-10-06T01:00:00.000Z",
		);
		expect(
			storedExpiresAt(anchor, { ...none, expires_after_seconds: "86400" })?.toISOString(),
		).toBe("2026-10-07T00:00:00.000Z");
	});

	it("clamps a stored duration beyond ten years instead of leaving the date range", () => {
		const clamped = new Date(anchor.getTime() + maxExpirySeconds * 1000).toISOString();
		for (const seconds of [maxExpirySeconds + 1, 9_000_000_000_000, "9007199254740991"]) {
			expect(
				storedExpiresAt(anchor, { ...none, expires_after_seconds: seconds })?.toISOString(),
			).toBe(clamped);
		}
	});

	it("clamps in SQL with the same bound", () => {
		const rendered = renderDrizzleSql(
			expiresAtSql(drizzleSql`${anchor.toISOString()}::timestamptz`, "options"),
		);
		expect(rendered).toContain("LEAST(options.expires_after_seconds, $3::bigint)");
		expect(rendered).toContain(
			`-- params: ["${anchor.toISOString()}","${anchor.toISOString()}",${maxExpirySeconds}]`,
		);
	});
});
