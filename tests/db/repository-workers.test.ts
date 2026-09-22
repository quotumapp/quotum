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

		expect(database.queries[1]).toContain("subscription_change_id =");
		for (const query of [database.queries[0], database.queries[3], ...database.queries.slice(4)]) {
			expect(query).toContain("project_id =");
			expect(query).toContain("locked_by =");
		}
		for (const params of [database.params[0], database.params[3], ...database.params.slice(4)]) {
			expect(params).toContain("project-id");
			expect(params).toContain("worker-a");
		}
		// The catalog_migration_jobs row is keyed by subscription_change_id whose owner
		// row was lease-fenced by the preceding UPDATE in the same transaction.
		expect(database.queries[2]).toContain("UPDATE catalog_migration_jobs");
		expect(database.queries[2]).toContain("project_id =");
		expect(database.params[2]).toContain("project-id");
		expect(database.params[2]).toContain("change-id");
		expect(database.params[2]).not.toContain("worker-a");
	});

	it("claims subscription changes as ids carrying their project", async () => {
		const database = new FakeDatabase([
			[],
			[{ id: "change-id", project_id: "project-id", project_key: "wiseley" }],
		]);
		const repository = new BillingRepository(database as never);

		await expect(repository.claimSubscriptionChanges("worker-a", 5)).resolves.toEqual([
			{ projectInstanceId: "project-id", projectKey: "wiseley", changeId: "change-id" },
		]);

		expect(database.queries[0]).toContain("UPDATE catalog_migration_jobs");
		expect(database.queries[1]).toContain("attempts = attempts + 1");
		expect(database.queries[1]).toContain("RETURNING changes.id, changes.project_id");
		expect(database.queries[1]).toContain("AS project_key");
	});

	it("claims subscription changes after staging fails and reports the failure", async () => {
		const inner = new FakeDatabase([
			[{ id: "change-id", project_id: "project-id", project_key: "wiseley" }],
		]);
		const database = new FailingStagingDatabase(inner);
		const repository = new BillingRepository(database as never);
		const stagingErrors: unknown[] = [];

		const claimed = await repository.claimSubscriptionChanges("worker-a", 5, {
			onStagingError: (error) => stagingErrors.push(error),
		});

		expect(claimed).toEqual([
			{ projectInstanceId: "project-id", projectKey: "wiseley", changeId: "change-id" },
		]);
		expect(stagingErrors).toEqual([new Error("staging failed")]);
	});

	it("skips a candidate that cannot be materialized and still claims usage invoice work", async () => {
		const database = new FakeDatabase([
			[usageInvoiceCandidate({ subscription_id: "poison" }), usageInvoiceCandidate()],
			[usageInvoicePricing({ billing_units: "0" })],
			[{ usage: "10" }],
			[usageInvoicePricing()],
			[{ usage: "10" }],
			[{ id: "materialized-period-id" }],
			[usageInvoicePeriod()],
			[{ id: "period-id", project_id: "project-id", project_key: "wiseley" }],
			[
				{
					id: 7,
					project_id: "project-id",
					project_key: "wiseley",
					closed_period_id: "closed-period-id",
				},
			],
		]);
		const repository = new BillingRepository(database as never);
		const skipped: Array<{ projectInstanceId: string; subscriptionId: string }> = [];

		const claim = await repository.materializeAndClaimUsageInvoicePeriods("worker-a", 5, {
			onMaterializationError: (_error, context) => skipped.push(context),
		});

		expect(claim).toEqual({
			materialized: 1,
			jobs: [
				{
					projectInstanceId: "project-id",
					projectKey: "wiseley",
					jobKind: "period",
					jobId: "period-id",
					periodId: "period-id",
				},
				{
					projectInstanceId: "project-id",
					projectKey: "wiseley",
					jobKind: "adjustment",
					jobId: "7",
					periodId: "closed-period-id",
				},
			],
		});
		expect(skipped).toEqual([{ projectInstanceId: "project-id", subscriptionId: "poison" }]);
		// The poison candidate fails while pricing, before its period insert.
		expect(database.queries[2]).toContain("FROM usage_windows");
		expect(database.queries[2]).toContain("FOR UPDATE");
		expect(database.queries[5]).toContain("INSERT INTO usage_invoice_periods");
		expect(database.queries[5]).toContain("DO NOTHING");
		expect(database.queries[7]).toContain("RETURNING periods.id, periods.project_id");
		expect(database.queries[8]).toContain("adjustment.closed_period_id");
	});

	it("materializes each candidate in its own transaction, apart from the claim", async () => {
		const inner = new FakeDatabase([
			[usageInvoiceCandidate({ subscription_id: "poison" }), usageInvoiceCandidate()],
			[usageInvoicePricing()],
			[{ usage: "10" }],
			[],
			[usageInvoicePricing()],
			[{ usage: "10" }],
			[{ id: "materialized-period-id" }],
			[usageInvoicePeriod()],
			[{ id: "period-id", project_id: "project-id", project_key: "wiseley" }],
			[],
		]);
		let inserts = 0;
		const database = new TransactionalDatabase(inner, (query) => {
			if (!query.includes("INSERT INTO usage_invoice_periods")) return undefined;
			inserts += 1;
			return inserts === 1 ? new Error("value out of range for type bigint") : undefined;
		});
		const repository = new BillingRepository(database as never);
		const skipped: Array<{ projectInstanceId: string; subscriptionId: string }> = [];

		const claim = await repository.materializeAndClaimUsageInvoicePeriods("worker-a", 5, {
			onMaterializationError: (_error, context) => skipped.push(context),
		});

		expect(claim.materialized).toBe(1);
		expect(claim.jobs.map(({ jobId }) => jobId)).toEqual(["period-id"]);
		expect(skipped).toEqual([{ projectInstanceId: "project-id", subscriptionId: "poison" }]);
		expect(database.transactions).toEqual(["rolled back", "committed", "committed"]);
		inner.assertConsumed();
	});

	it("rolls the claimed periods back when the adjustment claim fails", async () => {
		const inner = new FakeDatabase([
			[],
			[{ id: "period-id", project_id: "project-id", project_key: "wiseley" }],
		]);
		const database = new TransactionalDatabase(inner, (query) =>
			query.includes("UPDATE usage_invoice_adjustments adjustment")
				? new Error("canceling statement due to statement timeout")
				: undefined,
		);
		const repository = new BillingRepository(database as never);

		await expect(repository.materializeAndClaimUsageInvoicePeriods("worker-a", 5)).rejects.toThrow(
			"canceling statement due to statement timeout",
		);

		const periodClaim = inner.queries.findIndex((query) =>
			query.includes("UPDATE usage_invoice_periods periods"),
		);
		expect(periodClaim).toBeGreaterThanOrEqual(0);
		expect(database.outcomeOf(periodClaim)).toBe("rolled back");
	});

	it("returns null for recurring-billing jobs whose lease was lost", async () => {
		const database = new FakeDatabase([[], [], []]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.loadClaimedSubscriptionChange("project-id", "change-id", "worker-a"),
		).resolves.toBeNull();
		await expect(
			repository.loadClaimedUsageInvoiceJob("project-id", "period", "period-id", "worker-a"),
		).resolves.toBeNull();
		await expect(
			repository.loadClaimedUsageInvoiceJob("project-id", "adjustment", "7", "worker-a"),
		).resolves.toBeNull();

		expect(database.queries[0]).toContain("FROM subscription_changes");
		expect(database.queries[1]).toContain("FROM usage_invoice_periods");
		expect(database.queries[2]).toContain("FROM usage_invoice_adjustments");
		for (const [index, query] of database.queries.entries()) {
			expect(query).toContain("status = 'processing'");
			expect(database.boundParameter("project_id", index)).toBe("project-id");
			expect(database.boundParameter("locked_by", index)).toBe("worker-a");
		}
	});

	it("builds a recurring-billing job only once its lease check passes", async () => {
		const changes = new FakeDatabase([[{ id: "change-id" }], []]);

		await expect(
			new BillingRepository(changes as never).loadClaimedSubscriptionChange(
				"project-id",
				"change-id",
				"worker-a",
			),
		).rejects.toThrow("Subscription change change-id was not found");

		expect(changes.queries).toHaveLength(2);
		expect(changes.queries[1]).toContain("changes.status = 'processing'");

		const periods = new FakeDatabase([[{ id: "period-id" }], []]);

		await expect(
			new BillingRepository(periods as never).loadClaimedUsageInvoiceJob(
				"project-id",
				"period",
				"period-id",
				"worker-a",
			),
		).rejects.toThrow("Usage invoice period period-id cannot be invoiced");

		expect(periods.queries).toHaveLength(2);
	});
});

/** Fails the catalog-migration staging statement that runs before the subscription-change claim. */
class FailingStagingDatabase {
	private staged = false;

	constructor(private readonly inner: FakeDatabase) {}

	async execute(query: unknown): Promise<Record<string, unknown>[]> {
		if (!this.staged) {
			this.staged = true;
			throw new Error("staging failed");
		}
		return await this.inner.execute(query);
	}

	async transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
		return await callback(this);
	}
}

/**
 * Adds the transaction semantics FakeDatabase leaves out: every statement records the transaction
 * it ran in, a failing statement aborts the rest of that transaction, and the outcome is readable.
 */
class TransactionalDatabase {
	readonly transactions: Array<"committed" | "rolled back"> = [];
	private readonly statements: Array<number | null> = [];
	private open: number | null = null;

	constructor(
		private readonly inner: FakeDatabase,
		private readonly failOn: (query: string) => Error | undefined = () => undefined,
	) {}

	async execute(query: unknown): Promise<Record<string, unknown>[]> {
		if (this.open !== null && this.transactions[this.open] === "rolled back") {
			throw new Error("current transaction is aborted, commands ignored until end of transaction");
		}
		this.statements.push(this.open);
		const rows = await this.inner.execute(query);
		const failure = this.failOn(this.inner.queries.at(-1) ?? "");
		if (failure === undefined) return rows;
		if (this.open !== null) this.transactions[this.open] = "rolled back";
		throw failure;
	}

	async transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
		const index = this.transactions.length;
		this.transactions.push("committed");
		const enclosing = this.open;
		this.open = index;
		try {
			return await callback(this);
		} catch (error) {
			this.transactions[index] = "rolled back";
			throw error;
		} finally {
			this.open = enclosing;
		}
	}

	/** The outcome of the transaction the nth statement ran in; null when it ran outside one. */
	outcomeOf(statement: number): "committed" | "rolled back" | null {
		const index = this.statements[statement];
		return index === null || index === undefined ? null : this.transactions[index];
	}
}

function usageInvoicePricing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		customer_id: "customer-id",
		provider: "stripe",
		provider_account_id: null,
		price_component_id: 2,
		included_quantity: "0",
		billing_units: "1",
		unit_amount_minor: 500,
		currency: "usd",
		pricing_model: "flat",
		...overrides,
	};
}

function usageInvoicePeriod(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "materialized-period-id",
		customer_id: "customer-id",
		price_component_id: 2,
		usage_quantity: "10",
		included_quantity: "0",
		billing_units: "1",
		unit_amount_minor: 500,
		amount_minor: 5000,
		currency: "usd",
		status: "pending",
		...overrides,
	};
}

function usageInvoiceCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		project_id: "project-id",
		customer_id: "customer-id",
		subscription_id: "subscription-id",
		provider: "stripe",
		provider_account_id: null,
		plan_item_id: 1,
		price_component_id: 2,
		period_start_at: "2026-01-01T00:00:00.000Z",
		period_end_at: "2026-02-01T00:00:00.000Z",
		usage_quantity: "10",
		included_quantity: "0",
		billing_units: "1",
		unit_amount_minor: 500,
		currency: "usd",
		pricing_model: "flat",
		...overrides,
	};
}
