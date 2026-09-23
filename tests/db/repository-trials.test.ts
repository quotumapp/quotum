import { describe, expect, it } from "bun:test";
import { recordSubscriptionTrial } from "../../src/db/repository/trials";
import { FakeDatabase } from "./repository-fixture";

describe("recordSubscriptionTrial", () => {
	it("writes the bounds only when absent, for a later trial or a moved end, and never clears them", async () => {
		const database = new FakeDatabase([[]], { strict: true });

		await recordSubscriptionTrial(database as never, "project-id", "subscription-id", {
			start: new Date("2026-05-31T00:00:00.000Z"),
			end: new Date("2026-06-07T00:00:00.000Z"),
		});

		database.assertConsumed();
		const [query] = database.queries;
		expect(query).toMatch(
			/trial_start_at = \$\d+::timestamptz,\s+trial_end_at = \$\d+::timestamptz/,
		);
		expect(query).toContain("trial_ending_notified_at = NULL");
		expect(query).toContain("trial_end_at IS NULL");
		expect(query).toMatch(/OR \$\d+::timestamptz >= trial_end_at/);
		expect(query).toMatch(
			/OR \(trial_start_at = \$\d+::timestamptz AND trial_end_at <> \$\d+::timestamptz\)/,
		);
		expect(query).not.toMatch(/trial_(start|end)_at = NULL/);
		expect(database.boundParameter("project_id")).toBe("project-id");
		expect(database.boundParameter("id")).toBe("subscription-id");
		expect(database.params[0]).toContain("2026-06-07T00:00:00.000Z");
	});

	it("skips bounds that do not describe a period", async () => {
		const database = new FakeDatabase([], { strict: true });

		await recordSubscriptionTrial(database as never, "project-id", "subscription-id", {
			start: new Date("2026-06-07T00:00:00.000Z"),
			end: new Date("2026-06-07T00:00:00.000Z"),
		});

		expect(database.queries).toEqual([]);
	});
});
