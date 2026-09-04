import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase } from "./repository-fixture";

describe("BillingRepository core", () => {
	it("reads entitlement snapshots from billing tables", async () => {
		const database = new FakeDatabase([
			[{ id: "customer-id" }],
			[
				{
					key: "premium",
					active: true,
					expires_at: new Date("2026-01-01T00:00:00.000Z"),
					metadata: { source: "subscription" },
				},
			],
		]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.getEntitlementSnapshot(projectInstanceContext("wiseley"), "user-1"),
		).resolves.toEqual({
			billingAccountId: "user-1",
			generatedAt: expect.any(String),
			entitlements: [
				{
					key: "premium",
					active: true,
					expiresAt: "2026-01-01T00:00:00.000Z",
					metadata: { source: "subscription" },
				},
			],
		});
		const queries = database.queries.join("\n");
		expect(queries).not.toContain("FROM projects");
		expect(queries).toContain("FROM entitlements");
		expect(queries).not.toContain("FROM billing.entitlements");
		expect(queries).toContain("e.project_id = $1");
		expect(queries).toContain(JSON.stringify(projectInstanceContext("wiseley").projectInstanceId));
	});

	it("reads null-expiry subscription entitlements as inactive while preserving purchase entitlements", async () => {
		const database = new FakeDatabase([[{ id: "customer-id" }], []]);
		const repository = new BillingRepository(database as never);

		await repository.getEntitlementSnapshot(projectInstanceContext("wiseley"), "user-1");

		const queries = database.queries.join("\n");
		expect(queries).toContain("e.source_purchase_id IS NOT NULL");
		expect(queries).toContain("e.expires_at IS NOT NULL");
		expect(queries).toContain("e.expires_at > now()");
		expect(queries).not.toContain("e.active AND (e.expires_at IS NULL OR e.expires_at > now())");
	});

	it("recomputes entitlements from cancelled subscriptions until non-null expiry", async () => {
		const database = new FakeDatabase([[{ id: "customer-id" }], [], [{ id: "customer-id" }], []]);
		const repository = new BillingRepository(database as never);

		await repository.recomputeCustomerEntitlements(projectInstanceContext("wiseley"), "user-1");

		const queries = database.queries.join("\n");
		expect(queries).toContain(
			"s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')",
		);
		expect(queries).toContain("s.expires_at IS NOT NULL");
		expect(queries).toContain("s.expires_at > now()");
		expect(queries).not.toContain("s.expires_at IS NULL OR s.expires_at > now()");
	});

	it("creates provider customer tokens inside the supplied project", async () => {
		const database = new FakeDatabase([
			[{ id: "customer-id" }],
			[],
			[{ id: "provider-customer-id" }],
		]);
		const repository = new BillingRepository(database as never);

		const token = await repository.getOrCreateProviderCustomerToken(
			projectInstanceContext("wiseley"),
			"user-1",
			"apple",
		);

		expect(token).toBeString();
		const queries = database.queries.join("\n");
		expect(queries).not.toContain("FROM projects");
		expect(queries).toContain("pc.project_id = $1");
		expect(queries).toContain(JSON.stringify(projectInstanceContext("wiseley").projectInstanceId));
	});

	it("retries rolled-back billing transactions after PostgreSQL deadlocks", async () => {
		const database = new FakeDatabase([[{ id: "customer-id" }], [], [{ id: "customer-id" }], []]);
		const runTransaction = database.transaction.bind(database);
		let attempts = 0;
		database.transaction = async (callback) => {
			attempts += 1;
			if (attempts < 3) {
				throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
			}
			return await runTransaction(callback);
		};
		const repository = new BillingRepository(database as never);

		await repository.recomputeCustomerEntitlements(projectInstanceContext("wiseley"), "user-1");

		expect(attempts).toBe(3);
	});
});
