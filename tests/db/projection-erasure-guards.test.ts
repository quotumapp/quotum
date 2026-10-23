import { describe, expect, it } from "bun:test";
import {
	enqueueProjectionSyncJob,
	nextProjectionSequence,
} from "../../src/db/repository/entitlements";
import { ProjectionJobBillingRepository } from "../../src/db/repository/projection-jobs";
import { FakeDatabase } from "./repository-fixture";

describe("projection erasure guards", () => {
	it("locks the customer before admitting an owned processing job", async () => {
		const database = new FakeDatabase([[{ id: "customer", erased_at: null }], [{ id: "job" }]], {
			strict: true,
		});
		const repository = new ProjectionJobBillingRepository(database as never);
		expect(await repository.prepareProjectionSyncJobDelivery("project", "job", "worker")).toBe(
			"ready",
		);
		expect(database.queries[0]).toContain("FOR SHARE OF customer");
		expect(database.queries[1]).toContain("FOR UPDATE");
		expect(database.queries[1]).toContain("status = 'processing' AND locked_by =");
		expect(database.params[1]).toEqual(["project", "customer", "job", "worker"]);
		database.assertConsumed();
	});

	it("parks an erased owned job without a delivery marker", async () => {
		const database = new FakeDatabase(
			[[{ id: "customer", erased_at: "2026-10-23" }], [{ id: "job" }], []],
			{ strict: true },
		);
		const repository = new ProjectionJobBillingRepository(database as never);
		expect(await repository.prepareProjectionSyncJobDelivery("project", "job", "worker")).toBe(
			"skipped",
		);
		expect(database.queries[2]).toContain("status = 'pending', next_attempt_at = 'infinity'");
		expect(database.queries[2]).toContain("status = 'processing' AND locked_by =");
		expect(database.queries[2]).not.toContain("last_error");
		expect(database.params[2]).toEqual(["project", "customer", "job", "worker"]);
		database.assertConsumed();
	});

	it.each([false, true])(
		"leaves a missing or lost claim untouched (customer found: %j)",
		async (found) => {
			const responses = found ? [[{ id: "customer", erased_at: null }], []] : [[]];
			const database = new FakeDatabase(responses, { strict: true });
			expect(
				await new ProjectionJobBillingRepository(
					database as never,
				).prepareProjectionSyncJobDelivery("project", "job", "worker"),
			).toBe("skipped");
			expect(
				database.queries.every((query) => !query.includes("UPDATE projection_sync_jobs")),
			).toBe(true);
			database.assertConsumed();
		},
	);

	it("refuses sequence advances for an erased or missing customer", async () => {
		const database = new FakeDatabase([[]], { strict: true });
		await expect(nextProjectionSequence(database as never, "project", "customer")).rejects.toThrow(
			"projection sequence customer customer was not found",
		);
		expect(database.queries[0]).toContain("AND erased_at IS NULL");
	});

	it("checks erasure under the event enqueue lock before any sequence, payload or outbound fact", async () => {
		const database = new FakeDatabase([[{ project_id: "project", erased_at: "2026-10-23" }]], {
			strict: true,
		});
		expect(
			await enqueueProjectionSyncJob(database as never, {
				customerId: "customer",
				idempotencyKey: "refund",
				reason: "provider_webhook",
				payload: {
					billingAccountId: "original",
					reason: "provider_webhook",
					entitlements: {
						billingAccountId: "original",
						generatedAt: "2026-10-23T00:00:00.000Z",
						entitlements: [],
					},
				},
			}),
		).toBe(false);
		expect(database.queries[0]).toContain("FOR NO KEY UPDATE");
		database.assertConsumed();
	});
});
