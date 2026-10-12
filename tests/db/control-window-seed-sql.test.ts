import { describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import {
	chargedToEarlierWindowSql,
	recordedControlConsumptionSql,
} from "../../src/db/repository/controls-enterprise";
import { renderDrizzleSql } from "../helpers/drizzle-sql";

const scope = {
	projectId: "11111111-1111-4111-8111-111111111111",
	policyId: "7",
	customerId: "22222222-2222-4222-8222-222222222222",
	windowStartAt: "1970-01-01T00:00:00.000Z",
	windowEndAt: null,
	now: new Date("2026-10-12T00:00:00.000Z"),
};

describe("the usage a limit's new window starts from", () => {
	it("looks for a charge to an earlier window only for a window that can have one", () => {
		const probe = renderDrizzleSql(chargedToEarlierWindowSql());
		const guard = probe.indexOf("policy.interval <> 'lifetime'");
		// A lifetime window spans every time, so the lookup that costs a probe per confirmation and
		// correction never runs for it. The guard must come before the lookup.
		expect(guard).toBeGreaterThanOrEqual(0);
		expect(guard).toBeLessThan(probe.indexOf("EXISTS"));
		// A window of another cadence still never counts as the window that held the usage.
		expect(probe).toContain("charged_policy.control_kind = policy.control_kind");
		expect(probe).toContain("charged.window_start_at");
	});

	it("leaves a plain consumption out of the lookup and keeps it for the rest", () => {
		const seed = renderDrizzleSql(recordedControlConsumptionSql(scope, drizzleSql`false`));
		expect(seed).toContain(
			"event.operation = 'consume' OR NOT (policy.interval <> 'lifetime' AND EXISTS (",
		);
		expect(seed).toContain("policy.control_kind = 'usage_limit'");
	});
});
