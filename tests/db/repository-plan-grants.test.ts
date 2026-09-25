import { describe, expect, it } from "bun:test";
import { supersedeBasePlanGrants } from "../../src/db/repository/plan-grants";
import { FakeDatabase } from "./repository-fixture";

describe("supersedeBasePlanGrants", () => {
	it("locks the customer before superseding active base grants and clamping their allowances", async () => {
		const database = new FakeDatabase([[], []], { strict: true });

		await supersedeBasePlanGrants(database as never, {
			projectId: "project-id",
			customerId: "customer-id",
			subscriptionId: "subscription-id",
			planVersionId: "7",
		});

		database.assertConsumed();
		const [lock, supersede] = database.queries;
		expect(lock).toMatch(/FROM customers\s+WHERE project_id = \$1 AND id = \$2\s+FOR UPDATE/);
		expect(supersede).toContain("status = 'superseded'");
		expect(supersede).toContain("g.plan_kind = 'base'");
		expect(supersede).toContain("g.ends_at > now()");
		expect(supersede).toContain("version.plan_kind = 'base'");
		expect(supersede).toMatch(/UPDATE balance_allocations allocation\s+SET expires_at = now\(\)/);
	});
});
