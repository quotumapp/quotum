import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import { driverError } from "../helpers/postgres-errors";
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
			repository.getEntitlementSnapshot(projectInstanceContext("globex"), "user-1"),
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
		// The only project read is the published default plan, by the context's id.
		expect(queries.match(/FROM projects/g)?.length).toBe(
			queries.match(/FROM projects project\s+JOIN catalog_revisions/g)?.length,
		);
		expect(queries).toContain("FROM entitlements");
		expect(queries).not.toContain("FROM billing.entitlements");
		expect(queries).toContain("e.project_id = $1");
		expect(database.boundParameter("e.project_id")).toBe(
			projectInstanceContext("globex").projectInstanceId,
		);
	});

	it("never reads an inactive entitlement's status as running", async () => {
		const database = new FakeDatabase([
			[{ id: "customer-id" }],
			[
				{
					key: "a",
					active: false,
					expires_at: null,
					metadata: { source: "plan_grant", status: "active" },
				},
				{
					key: "b",
					active: false,
					expires_at: null,
					metadata: { source: "purchase", status: "completed" },
				},
				{
					key: "c",
					active: false,
					expires_at: null,
					metadata: { source: "subscription", status: "refunded" },
				},
				{
					key: "d",
					active: true,
					expires_at: null,
					metadata: { source: "subscription", status: "cancelled" },
				},
				{ key: "e", active: false, expires_at: null, metadata: {} },
			],
		]);
		const repository = new BillingRepository(database as never);

		const snapshot = await repository.getEntitlementSnapshot(
			projectInstanceContext("globex"),
			"user-1",
		);

		expect(snapshot.entitlements.map((entry) => [entry.key, entry.metadata.status])).toEqual([
			["a", "inactive"],
			["b", "inactive"],
			["c", "refunded"],
			["d", "cancelled"],
			["e", undefined],
		]);
	});

	it("records the last source's status when a recompute deactivates an entitlement", async () => {
		const database = new FakeDatabase([[{ id: "customer-id" }], [], [{ id: "customer-id" }], []]);
		const repository = new BillingRepository(database as never);

		await repository.recomputeCustomerEntitlements(projectInstanceContext("globex"), "user-1");

		const index = database.queries.findIndex((query) => query.includes("WITH active_sources"));
		const recompute = database.queries[index] ?? "";
		const deactivation = recompute.slice(recompute.indexOf("UPDATE entitlements e"));
		expect(deactivation).toContain("metadata = e.metadata || COALESCE(");
		expect(deactivation).toContain(
			"WHERE s.project_id = e.project_id AND s.id = e.source_subscription_id",
		);
		expect(deactivation).toContain(
			"WHERE pu.project_id = e.project_id AND pu.id = e.source_purchase_id",
		);
		expect(deactivation).toContain(
			"WHERE g.project_id = e.project_id AND g.id = e.source_plan_grant_id",
		);
		expect(deactivation).toContain("THEN 'inactive'");
		expect((database.params[index] ?? []).map(String)).toContain(
			JSON.stringify(["active", "grace_period", "billing_retry", "cancelled", "completed"]),
		);
	});

	it("reads null-expiry subscription entitlements as inactive while preserving purchase entitlements", async () => {
		const database = new FakeDatabase([[{ id: "customer-id" }], []]);
		const repository = new BillingRepository(database as never);

		await repository.getEntitlementSnapshot(projectInstanceContext("globex"), "user-1");

		const queries = database.queries.join("\n");
		expect(queries).toContain("e.source_purchase_id IS NOT NULL");
		expect(queries).toContain("e.expires_at IS NOT NULL");
		expect(queries).toContain("e.expires_at > now()");
		expect(queries).not.toContain("e.active AND (e.expires_at IS NULL OR e.expires_at > now())");
	});

	it("recomputes entitlements from cancelled subscriptions until non-null expiry", async () => {
		const database = new FakeDatabase([[{ id: "customer-id" }], [], [{ id: "customer-id" }], []]);
		const repository = new BillingRepository(database as never);

		await repository.recomputeCustomerEntitlements(projectInstanceContext("globex"), "user-1");

		// The default-plan read that precedes it counts null-expiry subscriptions as funding.
		const queries = database.queries.find((query) => query.includes("WITH active_sources")) ?? "";
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
			projectInstanceContext("globex"),
			"user-1",
			"apple",
		);

		expect(token).toBeString();
		const queries = database.queries.join("\n");
		expect(queries).not.toContain("FROM projects");
		expect(queries).toContain("pc.project_id = $1");
		expect(database.boundParameter("pc.project_id")).toBe(
			projectInstanceContext("globex").projectInstanceId,
		);
	});

	it("retries rolled-back billing transactions after PostgreSQL deadlocks", async () => {
		// Bun's driver reports the SQLSTATE on the wrapped cause's `errno`; other executors put it on
		// the top-level `code`. Both shapes must trigger the retry.
		const deadlocks = [
			() => driverError("40P01", "deadlock detected"),
			() => Object.assign(new Error("deadlock detected"), { code: "40P01" }),
		];
		for (const deadlock of deadlocks) {
			const database = new FakeDatabase([[{ id: "customer-id" }], [], [{ id: "customer-id" }], []]);
			const runTransaction = database.transaction.bind(database);
			let attempts = 0;
			database.transaction = async (callback) => {
				attempts += 1;
				if (attempts < 3) {
					throw deadlock();
				}
				return await runTransaction(callback);
			};
			const repository = new BillingRepository(database as never);

			await repository.recomputeCustomerEntitlements(projectInstanceContext("globex"), "user-1");

			expect(attempts).toBe(3);
		}
	});

	it("exhausts deadlock retries then rethrows", async () => {
		const database = new FakeDatabase([]);
		let attempts = 0;
		database.transaction = async () => {
			attempts += 1;
			throw driverError("40P01", "deadlock detected");
		};
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recomputeCustomerEntitlements(projectInstanceContext("globex"), "user-1"),
		).rejects.toMatchObject({ cause: { errno: "40P01" } });
		expect(attempts).toBe(3);
	});

	it("rethrows serialization and unique-violation errors immediately", async () => {
		for (const code of ["40001", "23505"]) {
			const database = new FakeDatabase([]);
			let attempts = 0;
			database.transaction = async () => {
				attempts += 1;
				throw driverError(code, code);
			};
			const repository = new BillingRepository(database as never);

			await expect(
				repository.recomputeCustomerEntitlements(projectInstanceContext("globex"), "user-1"),
			).rejects.toMatchObject({ cause: { errno: code } });
			expect(attempts).toBe(1);
		}
	});
});
