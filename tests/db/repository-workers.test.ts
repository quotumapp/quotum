import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase, purchaseProjectionInput } from "./repository-fixture";

describe("BillingRepository workers", () => {
	it("locks expiry reconciliation customers before subscriptions in a stable order", async () => {
		const database = new FakeDatabase([[]]);
		const repository = new BillingRepository(database as never);

		await expect(repository.reconcileExpiredSubscriptions(10)).resolves.toEqual({
			expiredSubscriptions: 0,
			affectedCustomers: 0,
			projectionJobs: 0,
		});

		const query = database.queries[0];
		expect(query).toContain("locked_customers AS MATERIALIZED");
		expect(query).toContain("ORDER BY c.id");
		expect(query.indexOf("FOR UPDATE OF c")).toBeLessThan(
			query.indexOf("FOR UPDATE OF s SKIP LOCKED"),
		);
	});

	it("claims projection jobs with skip-locked processing locks", async () => {
		const database = new FakeDatabase([
			[
				{
					id: "job-id",
					project_id: "project-id",
					project_key: "wiseley",
					customer_id: "customer-id",
					idempotency_key: "projection:key",
					reason: "provider_webhook",
					payload: {
						billingAccountId: "user-1",
						generatedAt: "2026-01-01T00:00:00.000Z",
						reason: "provider_webhook",
						entitlements: {
							billingAccountId: "user-1",
							generatedAt: "2026-01-01T00:00:00.000Z",
							entitlements: [],
						},
						balances: [],
					},
					status: "processing",
					attempts: 0,
					last_error: null,
					next_attempt_at: new Date("2026-01-01T00:00:00.000Z"),
					locked_at: new Date("2026-01-01T00:00:00.000Z"),
					locked_by: "worker-a",
					created_at: new Date("2026-01-01T00:00:00.000Z"),
					updated_at: new Date("2026-01-01T00:00:00.000Z"),
				},
			],
		]);
		const repository = new BillingRepository(database as never);

		const jobs = await repository.claimProjectionSyncJobs("worker-a", 1);

		expect(jobs[0]?.id).toBe("job-id");
		expect(jobs[0]?.project_key).toBe("wiseley");
		expect(database.queries[0]).toContain("FOR UPDATE OF jobs SKIP LOCKED");
		expect(database.queries[0]).toContain("status = 'processing'");
		expect(database.queries[0]).toContain("ROW_NUMBER() OVER");
		expect(database.queries[0]).toContain("PARTITION BY candidates.project_id");
	});

	it("records projection resync requests with durable boolean state", async () => {
		const database = new FakeDatabase([
			[{ id: "customer-id", billing_account_id: "user-1" }],
			[
				{
					id: "store-product-id",
					product_id: "product-id",
					product_key: "lifetime_unlock",
					product_type: "non_consumable",
					credit_amount: 0,
				},
			],
			[{ id: "store-event-id" }],
			[{ id: "purchase-id" }],
			[{ id: "customer-id" }],
			[],
			[{ id: "customer-id" }],
			[{ projection_sequence: 1, billing_account_id: "user-1" }],
			[],
			[{ project_id: "project-id" }],
			[{ id: "projection-job-id" }],
		]);
		const repository = new BillingRepository(database as never);

		await repository.recordPurchaseAndEnqueueProjection(
			projectInstanceContext("wiseley"),
			purchaseProjectionInput(),
		);

		const queries = database.queries.join("\n");
		expect(queries).toContain("reprojection_requested");
		expect(queries).toContain(
			"WHEN projection_sync_jobs.status = 'processing' THEN true ELSE false",
		);
		expect(queries).toMatch(
			/WHEN projection_sync_jobs\.status = 'processing' THEN 0\s+ELSE projection_sync_jobs\.attempts/,
		);
		expect(queries).not.toContain("projection_resync_requested");
	});

	it("marks projection resync successes pending without relying on last_error", async () => {
		const database = new FakeDatabase([[{ id: "job-id" }]]);
		const repository = new BillingRepository(database as never);

		await repository.markProjectionSyncJobSucceeded("project-id", "job-id", "worker-a");

		const query = database.queries[0];
		expect(query).toContain("jobs.reprojection_requested");
		expect(query).toContain("WHEN jobs.reprojection_requested THEN 'pending'");
		expect(query).toContain("reprojection_requested = false");
		expect(query).toContain("attempts = CASE");
		expect(query).not.toContain("projection_resync_requested");
	});

	it("claims store event replay jobs by id inside the authenticated project", async () => {
		const database = new FakeDatabase([
			[
				{
					id: "event-id",
					project_id: "project-id",
					project_key: "wiseley",
					provider: "google",
					channel: "android",
					external_event_id: "external-event-id",
					event_type: "purchase_verified",
					customer_id: null,
					store_product_id: null,
					transaction_id: "transaction-id",
					purchase_kind: "subscription",
					processing_status: "processing",
					processing_error: null,
					attempts: 0,
					next_attempt_at: new Date("2026-01-01T00:00:00.000Z"),
					raw_payload: {},
					processed_at: null,
					locked_at: new Date("2026-01-01T00:00:00.000Z"),
					locked_by: "worker-a",
					created_at: new Date("2026-01-01T00:00:00.000Z"),
					updated_at: new Date("2026-01-01T00:00:00.000Z"),
				},
			],
		]);
		const repository = new BillingRepository(database as never);

		const row = await repository.claimStoreEventReplayJobById(
			"worker-a",
			projectInstanceContext("wiseley"),
			"event-id",
		);

		expect(row.project_key).toBe("wiseley");
		const queries = database.queries.join("\n");
		expect(queries).not.toContain("SELECT p.id FROM projects p");
		expect(queries).toContain("events.project_id = $3");
		expect(database.boundParameter("events.project_id")).toBe(
			projectInstanceContext("wiseley").projectInstanceId,
		);
	});

	it("marks projection failures with retry or terminal state", async () => {
		const database = new FakeDatabase([[{ id: "job-id" }]]);
		const repository = new BillingRepository(database as never);
		const nextAttemptAt = "2026-01-01T00:05:00.000Z";

		await repository.markProjectionSyncJobFailed(
			"project-id",
			"job-id",
			"projection failed",
			new Date(nextAttemptAt),
			"worker-a",
		);

		expect(database.queries[0]).toContain("LEAST(jobs.attempts::bigint + 1, 2147483647)");
		expect(database.queries[0]).toContain("WHEN jobs.reprojection_requested THEN 0");
		expect(database.queries[0]).toContain("reprojection_requested = false");
		expect(database.queries[0]).toContain("locked_by =");
		expect(database.queries[0]).toContain("jobs.project_id =");
		expect(database.queries[0]).toContain('"project-id"');
		expect(database.params[0]).toContain(nextAttemptAt);
		expect(database.params[0].some((param) => param instanceof Date)).toBe(false);
	});

	it("requeues terminal projection failures for an authenticated project", async () => {
		const database = new FakeDatabase([[{ id: "job-id" }]]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.retryProjectionSyncJob(projectInstanceContext("wiseley"), "job-id"),
		).resolves.toEqual({ jobId: "job-id", status: "pending" });

		const queries = database.queries.join("\n");
		expect(queries).toContain("jobs.status = 'failed'");
		expect(queries).toContain("attempts = 0");
		expect(queries).toContain("last_error = NULL");
		expect(queries).toContain("next_attempt_at = now()");
		expect(database.boundParameter("jobs.project_id")).toBe(
			projectInstanceContext("wiseley").projectInstanceId,
		);
	});

	it("binds null for terminal projection failures", async () => {
		const database = new FakeDatabase([[{ id: "job-id" }]]);
		const repository = new BillingRepository(database as never);

		await repository.markProjectionSyncJobFailed(
			"project-id",
			"job-id",
			"projection failed",
			null,
			"worker-a",
		);

		expect(database.params[0]).toContain(null);
		expect(database.params[0].some((param) => param instanceof Date)).toBe(false);
	});

	it("binds store event replay retry timestamps as ISO strings", async () => {
		const database = new FakeDatabase([[{ id: "event-id" }]]);
		const repository = new BillingRepository(database as never);
		const nextAttemptAt = "2026-01-01T00:05:00.000Z";

		await repository.markStoreEventReplayJobFailed(
			"project-id",
			"event-id",
			"replay failed",
			new Date(nextAttemptAt),
			"worker-a",
		);

		expect(database.queries[0]).toContain("processing_status = CASE");
		expect(database.queries[0]).toContain("next_attempt_at = COALESCE");
		expect(database.params[0]).toContain(nextAttemptAt);
		expect(database.params[0].some((param) => param instanceof Date)).toBe(false);
	});

	it("binds null for terminal store event replay failures", async () => {
		const database = new FakeDatabase([[{ id: "event-id" }]]);
		const repository = new BillingRepository(database as never);

		await repository.markStoreEventReplayJobFailed(
			"project-id",
			"event-id",
			"replay failed",
			null,
			"worker-a",
		);

		expect(database.params[0]).toContain(null);
		expect(database.params[0].some((param) => param instanceof Date)).toBe(false);
	});

	it("binds provider reconciliation retry timestamps as ISO strings", async () => {
		const database = new FakeDatabase([[{ id: "subscription-id" }]]);
		const repository = new BillingRepository(database as never);
		const nextAttemptAt = "2026-01-01T00:05:00.000Z";

		await repository.markProviderSubscriptionReconciliationFailed(
			"project-id",
			"subscription-id",
			"reconciliation failed",
			new Date(nextAttemptAt),
			"worker-a",
		);

		expect(database.queries[0]).toContain("provider_reconciliation_attempts");
		expect(database.queries[0]).toContain("provider_reconciliation_next_attempt_at = COALESCE");
		expect(database.params[0]).toContain(nextAttemptAt);
		expect(database.params[0].some((param) => param instanceof Date)).toBe(false);
	});

	it("binds null for terminal provider reconciliation failures", async () => {
		const database = new FakeDatabase([[{ id: "subscription-id" }]]);
		const repository = new BillingRepository(database as never);

		await repository.markProviderSubscriptionReconciliationFailed(
			"project-id",
			"subscription-id",
			"reconciliation failed",
			null,
			"worker-a",
		);

		expect(database.params[0]).toContain(null);
		expect(database.params[0].some((param) => param instanceof Date)).toBe(false);
	});

	it("throws when marking a job that is not owned by the worker", async () => {
		const database = new FakeDatabase([[]]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.markProjectionSyncJobSucceeded("project-id", "job-id", "worker-a"),
		).rejects.toThrow("projection sync job job-id is not locked by worker worker-a");
	});

	it("fences every recurring-billing finalizer by captured project and worker lease", async () => {
		const database = new FakeDatabase([
			[{ id: "change-id" }],
			[],
			[{ status: "pending" }],
			[{ id: "period-id" }],
			[{ id: "adjustment-id" }],
		]);
		const repository = new BillingRepository(database as never);

		await repository.markSubscriptionChangeApplied(
			"project-id",
			"change-id",
			"provider-request-id",
			"worker-a",
		);
		await repository.markSubscriptionChangeFailed(
			"project-id",
			"change-id",
			"provider failed",
			"worker-a",
		);
		await repository.markUsageInvoiceSucceeded(
			"project-id",
			"period",
			"period-id",
			"invoice-id",
			"worker-a",
		);
		await repository.markUsageInvoiceFailed(
			"project-id",
			"adjustment",
			"adjustment-id",
			"invoice failed",
			"worker-a",
		);

		for (const query of [database.queries[0], database.queries[2], ...database.queries.slice(3)]) {
			expect(query).toContain("project_id =");
			expect(query).toContain("locked_by =");
		}
		for (const params of [database.params[0], database.params[2], ...database.params.slice(3)]) {
			expect(params).toContain("project-id");
			expect(params).toContain("worker-a");
		}
		// The catalog_migration_jobs row is keyed by subscription_change_id whose owner
		// row was lease-fenced by the preceding UPDATE in the same transaction.
		expect(database.queries[1]).toContain("UPDATE catalog_migration_jobs");
		expect(database.queries[1]).toContain("project_id =");
		expect(database.params[1]).toContain("project-id");
		expect(database.params[1]).toContain("change-id");
		expect(database.params[1]).not.toContain("worker-a");
	});
});
