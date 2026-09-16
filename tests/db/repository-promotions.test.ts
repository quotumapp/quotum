import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import { FakeDatabase } from "./repository-fixture";

describe("PromotionRepository", () => {
	it("sweeps expired reservations without waiting on locked rows and returns the uses", async () => {
		const database = new FakeDatabase(
			[
				[
					{ project_id: "project-b", promotion_code_id: "code-2" },
					{ project_id: "project-a", promotion_code_id: "code-1" },
					{ project_id: "project-a", promotion_code_id: "code-1" },
				],
				[{ id: "code-1" }],
				[{ id: "code-2" }],
			],
			{ strict: true },
		);
		const repository = new BillingRepository(database as never);

		expect(await repository.promotions.releaseExpiredPromotionReservations(50)).toBe(3);

		database.assertConsumed();
		expect(database.queries[0]).toContain("FOR UPDATE OF r SKIP LOCKED");
		expect(database.queries[0]).toContain("sc.status IN ('pending', 'processing')");
		expect(database.queries[1]).toContain("GREATEST(reserved_count - $1, 0)");
		expect(database.params[1]).toEqual([2, "project-a", "code-1"]);
		expect(database.params[2]).toEqual([1, "project-b", "code-2"]);
	});
});
