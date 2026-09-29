import { describe, expect, it } from "bun:test";
import { PlanGrantRepository, supersedeBasePlanGrants } from "../../src/db/repository/plan-grants";
import { renderDrizzleSql } from "../helpers/drizzle-sql";
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

describe("default-plan passes", () => {
	it("backs a pass off by its own id and project after a slice fails, then rethrows", async () => {
		const failure = new Error("slice failed");
		const writes: string[] = [];
		const database = {
			async execute(query: unknown) {
				const text = renderDrizzleSql(query);
				if (text.includes("SET attempts = attempts + 1")) {
					writes.push(text);
					return [{ id: "7" }];
				}
				if (
					text.includes("FOR UPDATE SKIP LOCKED") &&
					text.includes("default_plan_reconciliations")
				) {
					throw failure;
				}
				if (text.includes("FROM default_plan_reconciliations")) {
					return [{ id: "7", project_id: "project-id" }];
				}
				return [];
			},
			async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
				return await callback(this);
			},
		};

		const outcome = await new PlanGrantRepository(database as never)
			.reconcilePlanGrants(25)
			.catch((error: unknown) => error);

		expect(outcome).toBe(failure);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatch(
			/WHERE project_id = \$\d+\s+AND id = \$\d+::bigint\s+AND status = 'pending'/,
		);
		expect(writes[0]).toContain(
			"LEAST(power(2, attempts) * interval '30 seconds', interval '1 hour')",
		);
	});
});
