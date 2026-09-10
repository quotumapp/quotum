import { describe, expect, it } from "bun:test";
import { AdminBillingRepository } from "../../src/db/admin-repository";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase } from "./repository-fixture";

describe("AdminBillingRepository", () => {
	it("searches all declared customer match types with a bounded query pattern", async () => {
		const database = new FakeDatabase([]);
		const repository = new AdminBillingRepository(
			{ providerReconciliationStaleAfterMs: 1000 },
			database as never,
		);

		await repository.searchCustomers(projectInstanceContext("wiseley"), {
			query: "GPA.123",
			limit: 10,
			cursor: null,
		});

		const query = database.queries[0];
		expect(query).toContain("'billing_account_id'::text");
		expect(query).toContain("'customer_id'::text");
		expect(query).toContain("'provider_customer'::text");
		expect(query).toContain("'transaction_id'::text");
		expect(query).toContain("'original_transaction_id'::text");
		expect(query).toContain("'order_id'::text");
		expect(query).toContain("'entitlement_key'::text");
		expect(query).toContain('"GPA.123%"');
		expect(query).not.toContain('"%GPA.123');
		expect(query).not.toContain("%GPA.123%");
		expect(query).toContain("SELECT DISTINCT ON (id)");
	});

	it("builds the next cursor from the exact database timestamp without exposing it", async () => {
		const row = {
			id: "123e4567-e89b-12d3-a456-426614174000",
			key: "premium",
			entitlementKey: "premium",
			creditAmount: null,
			name: "Premium",
			description: null,
			type: "subscription",
			active: true,
			metadata: {},
			createdAt: new Date("2026-01-01T00:00:00.123Z"),
			updatedAt: new Date("2026-01-01T00:00:00.123Z"),
			cursorCreatedAt: "2026-01-01T00:00:00.123456Z",
		};
		const database = new FakeDatabase([
			[row, { ...row, id: "223e4567-e89b-12d3-a456-426614174000" }],
		]);
		const repository = new AdminBillingRepository(
			{ providerReconciliationStaleAfterMs: 1000 },
			database as never,
		);

		const result = await repository.listCatalogProducts(projectInstanceContext("wiseley"), {
			limit: 1,
			cursor: null,
		});

		expect(result.nextCursor).not.toBeNull();
		expect(result.items[0]).not.toHaveProperty("cursorCreatedAt");
		expect(database.queries[0]).toContain("to_char");
	});

	it("lists purchases with direct table queries and normalized timestamps", async () => {
		const database = new FakeDatabase([
			[
				{
					id: "purchase-id",
					customerId: "customer-id",
					billingAccountId: "user-1",
					provider: "stripe",
					channel: "web",
					purchaseKind: "consumable",
					status: "completed",
					transactionId: "pi_123",
					originalTransactionId: null,
					productKey: "echo_pack",
					entitlementKey: "echoes",
					externalProductId: "prod_123",
					externalPriceId: "price_123",
					purchasedAt: new Date("2026-01-01T00:00:00.000Z"),
					invalidatedAt: null,
					invalidationReason: null,
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			],
		]);
		const repository = new AdminBillingRepository(
			{ providerReconciliationStaleAfterMs: 1000 },
			database as never,
		);

		const result = await repository.listPurchases(projectInstanceContext("wiseley"), {
			limit: 10,
			cursor: null,
			provider: "stripe",
		});

		expect(result.nextCursor).toBeNull();
		expect(result.items[0]?.purchasedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(result.items[0]?.provider).toBe("stripe");
		expect(database.queries[0]).toContain("project_id =");
		expect(database.boundParameter("project_id", 0)).toBe(
			projectInstanceContext("wiseley").projectInstanceId,
		);
	});

	it("computes a default staleBefore for subscription needs-attention queries", async () => {
		const database = new FakeDatabase([]);
		const repository = new AdminBillingRepository(
			{
				providerReconciliationStaleAfterMs: 60_000,
				now: () => new Date("2026-01-01T00:01:00.000Z"),
			},
			database as never,
		);

		await repository.listSubscriptions(projectInstanceContext("wiseley"), {
			limit: 10,
			cursor: null,
			needsAttention: true,
		});

		expect(database.queries[0]).toContain("provider_reconciled_at");
		expect(database.queries[0]).toContain("project_id =");
	});

	it("throws when customer drilldown cannot find the customer", async () => {
		const repository = new AdminBillingRepository(
			{ providerReconciliationStaleAfterMs: 1000 },
			new FakeDatabase([[]]) as never,
		);

		await expect(
			repository.getCustomerByBillingAccountId(projectInstanceContext("wiseley"), "missing-user"),
		).rejects.toThrow("Billing customer was not found");
	});

	it("keeps customer drilldown related lists explicitly bounded", async () => {
		const database = new FakeDatabase([
			[
				{
					id: "customer-id",
					projectKey: "wiseley",
					billingAccountId: "user-1",
					email: null,
					metadata: {},
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			],
			[],
			[],
			[],
			[],
			[],
			[{ id: "project-id" }],
			[{ id: "customer-id" }],
			[],
		]);
		const repository = new AdminBillingRepository(
			{ providerReconciliationStaleAfterMs: 1000 },
			database as never,
		);

		await repository.getCustomerByBillingAccountId(projectInstanceContext("wiseley"), "user-1");

		expect(database.queries.join("\n")).toContain(",6]");
		expect(database.queries.join("\n")).toContain('"s".status IN');
		expect(database.queries.join("\n")).toContain(
			'"active","grace_period","billing_retry","cancelled"',
		);
	});

	it("assembles a windowed stats summary with accurate counts and provider recency", async () => {
		// Promise.all evaluates the five queries in array order: store events,
		// projection jobs, subscriptions, providers, recent store events.
		const database = new FakeDatabase([
			[
				{ status: "failed", count: 3 },
				{ status: "processed", count: 5 },
			],
			[{ status: "failed", count: 2 }],
			[{ active: 4, gracePeriod: 1, needsAttention: 2 }],
			[{ provider: "stripe", lastEventAt: new Date("2026-01-01T00:00:00.000Z") }],
			[],
		]);
		const repository = new AdminBillingRepository(
			{ providerReconciliationStaleAfterMs: 1000 },
			database as never,
		);

		const result = await repository.getStatsSummary(projectInstanceContext("wiseley"), {});

		expect(result.storeEvents).toEqual({
			pending: 0,
			processing: 0,
			processed: 5,
			skipped: 0,
			failed: 3,
		});
		expect(result.projectionJobs).toEqual({
			pending: 0,
			processing: 0,
			succeeded: 0,
			failed: 2,
		});
		expect(result.subscriptions).toEqual({
			active: 4,
			gracePeriod: 1,
			needsAttention: 2,
		});
		expect(result.providers.stripe?.lastEventAt).toBe("2026-01-01T00:00:00.000Z");
		expect(result.providers.apple).toBeUndefined();
		expect(result.recentStoreEvents).toEqual([]);

		const sql = database.queries.join("\n");
		expect(sql).toContain("GROUP BY se.processing_status");
		expect(sql).toContain("GROUP BY jobs.status");
		expect(sql).toContain("GROUP BY se.provider");
		expect(sql).toContain("MAX(se.created_at)");
		expect(sql).toContain("COUNT(*) FILTER (WHERE s.status = 'active')");
		expect(sql).toContain("provider_reconciliation_error IS NOT NULL");
	});

	it("applies provider/channel/window filters to store events but only window filters to projection jobs", async () => {
		const database = new FakeDatabase([[], [], [], [], []]);
		const repository = new AdminBillingRepository(
			{ providerReconciliationStaleAfterMs: 1000 },
			database as never,
		);

		await repository.getStatsSummary(projectInstanceContext("wiseley"), {
			provider: "stripe",
			from: "2026-01-01T00:00:00.000Z",
		});

		// queries[0] = store event counts, queries[1] = projection job counts
		expect(database.queries[0]).toContain('"se".provider =');
		expect(database.queries[0]).toContain('"se".created_at >=');
		expect(database.queries[1]).not.toContain('".provider =');
		expect(database.queries[1]).toContain('"jobs".created_at >=');
	});
});
