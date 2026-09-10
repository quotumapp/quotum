import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectNoLocks } from "./helpers/db-assertions";
import {
	expireAutoTopupJobLock,
	expireSubscriptionChangeLock,
	expireSubscriptionReconciliationLock,
	expireUsageInvoicePeriodLock,
} from "./helpers/job-time-travel";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	seedAutoTopupJobs,
	seedReconciliationSubscriptions,
	seedSubscriptionChanges,
	seedUsageInvoicePeriods,
} from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const staleBefore = () => new Date(Date.now() - 5 * 60_000);
let context: LocalPostgresContext;

localDescribe("Worker queue concurrency", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("claims each auto top-up job exactly once across competing workers", async () => {
		const ids = await seedAutoTopupJobs(context.sql, context.repository, 4);
		const [claimedA, claimedB] = await Promise.all([
			context.repository.claimAutoTopupJobs("worker-a", 4, staleBefore()),
			context.repository.claimAutoTopupJobs("worker-b", 4, staleBefore()),
		]);
		const claimed = [...claimedA, ...claimedB];
		expect(claimed).toHaveLength(4);
		expect(
			disjoint(
				claimedA.map((job) => job.jobId),
				claimedB.map((job) => job.jobId),
			),
		).toBe(true);
		expect(new Set(claimed.map((job) => job.jobId))).toEqual(new Set(ids));
		await expectLockedBy(context.sql, "auto_topup_jobs", "id", ids, ["worker-a", "worker-b"]);
		const states = await context.sql<{ purchases_in_interval: number }[]>`
			SELECT purchases_in_interval FROM auto_topup_states
		`;
		expect(states).toHaveLength(4);
		expect(states.every((row) => row.purchases_in_interval === 1)).toBe(true);

		for (const job of claimedA) {
			await context.repository.markAutoTopupSucceeded(job.projectId, job.jobId, "worker-a", {
				status: "succeeded",
				externalInvoiceId: `in_${job.jobId}`,
				externalPaymentId: `pi_${job.jobId}`,
				amountPaidMinor: job.amountMinor,
				currency: job.currency,
			});
		}
		for (const job of claimedB) {
			await context.repository.markAutoTopupSucceeded(job.projectId, job.jobId, "worker-b", {
				status: "succeeded",
				externalInvoiceId: `in_${job.jobId}`,
				externalPaymentId: `pi_${job.jobId}`,
				amountPaidMinor: job.amountMinor,
				currency: job.currency,
			});
		}
		await expectNoLocks(context.sql, "auto_topup_jobs");
	});

	it("reclaims a stale auto top-up lock without changing the reserved budget", async () => {
		const [jobId] = await seedAutoTopupJobs(context.sql, context.repository, 1);
		const [claimed] = await context.repository.claimAutoTopupJobs("worker-a", 1, staleBefore());
		expect(claimed.jobId).toBe(jobId);
		const [before] = await context.sql<
			{ budget_reserved_at: string; purchases_in_interval: number }[]
		>`
			SELECT job.budget_reserved_at::text, state.purchases_in_interval
			FROM auto_topup_jobs job
			JOIN auto_topup_states state
				ON state.project_id = job.project_id AND state.policy_id = job.policy_id
			WHERE job.id = ${jobId}
		`;
		await expireAutoTopupJobLock(context.sql, jobId);
		const [reclaimed] = await context.repository.claimAutoTopupJobs("worker-b", 1, staleBefore());
		expect(reclaimed.jobId).toBe(jobId);
		const [after] = await context.sql<
			{ budget_reserved_at: string; purchases_in_interval: number; locked_by: string }[]
		>`
			SELECT job.budget_reserved_at::text, state.purchases_in_interval, job.locked_by
			FROM auto_topup_jobs job
			JOIN auto_topup_states state
				ON state.project_id = job.project_id AND state.policy_id = job.policy_id
			WHERE job.id = ${jobId}
		`;
		expect(after.locked_by).toBe("worker-b");
		expect(after.budget_reserved_at).toBe(before.budget_reserved_at);
		expect(after.purchases_in_interval).toBe(1);
	});

	it("fences auto top-up finalizers after a reclaimed lease", async () => {
		const [jobId] = await seedAutoTopupJobs(context.sql, context.repository, 1);
		const [claimed] = await context.repository.claimAutoTopupJobs("worker-a", 1, staleBefore());
		await expireAutoTopupJobLock(context.sql, jobId);
		const [reclaimed] = await context.repository.claimAutoTopupJobs("worker-b", 1, staleBefore());
		expect(reclaimed.jobId).toBe(jobId);
		await expect(
			context.repository.markAutoTopupSucceeded(claimed.projectId, jobId, "worker-a", {
				status: "succeeded",
				externalInvoiceId: "in_stale",
				externalPaymentId: "pi_stale",
				amountPaidMinor: claimed.amountMinor,
				currency: claimed.currency,
			}),
		).rejects.toThrow(/is not locked by worker-a/);
		await expect(
			context.repository.markAutoTopupFailed(claimed.projectId, jobId, "worker-a", {
				kind: "retryable",
				error: "stale worker",
				nextAttemptAt: new Date(Date.now() + 60_000),
			}),
		).rejects.toThrow(/is not locked by worker-a/);
	});

	it("claims each subscription change exactly once across competing workers", async () => {
		const ids = await seedSubscriptionChanges(context.sql, 6);
		const [claimedA, claimedB] = await Promise.all([
			context.repository.claimSubscriptionChanges("worker-a", 6),
			context.repository.claimSubscriptionChanges("worker-b", 6),
		]);
		const claimed = [...claimedA, ...claimedB];
		expect(claimed).toHaveLength(6);
		expect(
			disjoint(
				claimedA.map((row) => row.changeId),
				claimedB.map((row) => row.changeId),
			),
		).toBe(true);
		expect(new Set(claimed.map((row) => row.changeId))).toEqual(new Set(ids));
		await expectLockedBy(context.sql, "subscription_changes", "id", ids, ["worker-a", "worker-b"]);
		for (const change of claimedA) {
			await context.repository.markSubscriptionChangeApplied(
				change.projectInstanceId,
				change.changeId,
				`req_${change.changeId}`,
				"worker-a",
			);
		}
		for (const change of claimedB) {
			await context.repository.markSubscriptionChangeApplied(
				change.projectInstanceId,
				change.changeId,
				`req_${change.changeId}`,
				"worker-b",
			);
		}
		await expectNoLocks(context.sql, "subscription_changes");
	});

	it("reclaims a stale subscription change and fences the previous worker", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		const [claimed] = await context.repository.claimSubscriptionChanges("worker-a", 1);
		expect(claimed.changeId).toBe(changeId);
		await expireSubscriptionChangeLock(context.sql, changeId);
		const [reclaimed] = await context.repository.claimSubscriptionChanges("worker-b", 1);
		expect(reclaimed.changeId).toBe(changeId);
		await expect(
			context.repository.markSubscriptionChangeApplied(
				claimed.projectInstanceId,
				changeId,
				"req_stale",
				"worker-a",
			),
		).rejects.toThrow(/was not owned by worker/);
		await context.repository.markSubscriptionChangeApplied(
			reclaimed.projectInstanceId,
			changeId,
			"req_live",
			"worker-b",
		);
		await expectNoLocks(context.sql, "subscription_changes");
	});

	it("claims each usage invoice period exactly once across competing workers", async () => {
		const ids = await seedUsageInvoicePeriods(context.sql, 6);
		const [claimedA, claimedB] = await Promise.all([
			context.repository.materializeAndClaimUsageInvoicePeriods("worker-a", 6),
			context.repository.materializeAndClaimUsageInvoicePeriods("worker-b", 6),
		]);
		const claimed = [...claimedA.jobs, ...claimedB.jobs];
		expect(claimed).toHaveLength(6);
		expect(
			disjoint(
				claimedA.jobs.map((job) => job.jobId),
				claimedB.jobs.map((job) => job.jobId),
			),
		).toBe(true);
		expect(new Set(claimed.map((job) => job.jobId))).toEqual(new Set(ids));
		await expectLockedBy(context.sql, "usage_invoice_periods", "id", ids, ["worker-a", "worker-b"]);
		for (const job of claimedA.jobs) {
			await context.repository.markUsageInvoiceSucceeded(
				job.projectInstanceId,
				job.jobKind,
				job.jobId,
				`in_${job.jobId}`,
				"worker-a",
			);
		}
		for (const job of claimedB.jobs) {
			await context.repository.markUsageInvoiceSucceeded(
				job.projectInstanceId,
				job.jobKind,
				job.jobId,
				`in_${job.jobId}`,
				"worker-b",
			);
		}
		await expectNoLocks(context.sql, "usage_invoice_periods");
	});

	it("reclaims a stale usage invoice period and fences the previous worker", async () => {
		const [periodId] = await seedUsageInvoicePeriods(context.sql, 1);
		const claimed = await context.repository.materializeAndClaimUsageInvoicePeriods("worker-a", 1);
		expect(claimed.jobs[0]?.jobId).toBe(periodId);
		await expireUsageInvoicePeriodLock(context.sql, periodId);
		const reclaimed = await context.repository.materializeAndClaimUsageInvoicePeriods(
			"worker-b",
			1,
		);
		expect(reclaimed.jobs[0]?.jobId).toBe(periodId);
		await expect(
			context.repository.markUsageInvoiceSucceeded(
				claimed.jobs[0].projectInstanceId,
				claimed.jobs[0].jobKind,
				periodId,
				"in_stale",
				"worker-a",
			),
		).rejects.toThrow(/was not owned by worker/);
		await expect(
			context.repository.markUsageInvoiceFailed(
				claimed.jobs[0].projectInstanceId,
				claimed.jobs[0].jobKind,
				periodId,
				"stale worker",
				"worker-a",
			),
		).rejects.toThrow(/was not owned by worker/);
		await context.repository.markUsageInvoiceSucceeded(
			reclaimed.jobs[0].projectInstanceId,
			reclaimed.jobs[0].jobKind,
			periodId,
			"in_live",
			"worker-b",
		);
		await expectNoLocks(context.sql, "usage_invoice_periods");
	});

	it("claims each provider reconciliation exactly once across competing workers", async () => {
		const ids = await seedReconciliationSubscriptions(context.sql, 6);
		const [claimedA, claimedB] = await Promise.all([
			context.repository.claimProviderSubscriptionReconciliations("worker-a", 6, staleBefore()),
			context.repository.claimProviderSubscriptionReconciliations("worker-b", 6, staleBefore()),
		]);
		const claimed = [...claimedA, ...claimedB];
		expect(claimed).toHaveLength(6);
		expect(
			disjoint(
				claimedA.map((row) => row.id),
				claimedB.map((row) => row.id),
			),
		).toBe(true);
		expect(new Set(claimed.map((row) => row.id))).toEqual(new Set(ids));
		await expectLockedBy(
			context.sql,
			"subscriptions",
			"id",
			ids,
			["worker-a", "worker-b"],
			"provider_reconciliation_locked_by",
		);
		for (const row of claimedA) {
			await context.repository.markProviderSubscriptionReconciliationSucceeded(
				row.project_id,
				row.id,
				"worker-a",
			);
		}
		for (const row of claimedB) {
			await context.repository.markProviderSubscriptionReconciliationSucceeded(
				row.project_id,
				row.id,
				"worker-b",
			);
		}
		await expectNoLocks(context.sql, "subscriptions", [
			"provider_reconciliation_locked_at",
			"provider_reconciliation_locked_by",
		]);
	});

	it("reclaims a stale provider reconciliation and fences the previous worker", async () => {
		const [subscriptionId] = await seedReconciliationSubscriptions(context.sql, 1);
		const [claimed] = await context.repository.claimProviderSubscriptionReconciliations(
			"worker-a",
			1,
			staleBefore(),
		);
		expect(claimed.id).toBe(subscriptionId);
		await expireSubscriptionReconciliationLock(context.sql, subscriptionId);
		const [reclaimed] = await context.repository.claimProviderSubscriptionReconciliations(
			"worker-b",
			1,
			staleBefore(),
		);
		expect(reclaimed.id).toBe(subscriptionId);
		await expect(
			context.repository.markProviderSubscriptionReconciliationSucceeded(
				claimed.project_id,
				subscriptionId,
				"worker-a",
			),
		).rejects.toThrow(/is not locked by worker worker-a/);
		await expect(
			context.repository.markProviderSubscriptionReconciliationFailed(
				claimed.project_id,
				subscriptionId,
				"stale worker",
				new Date(Date.now() + 60_000),
				"worker-a",
			),
		).rejects.toThrow(/is not locked by worker worker-a/);
		const [beforeRenew] = await context.sql<
			{ provider_reconciliation_locked_at: string; provider_reconciliation_locked_by: string }[]
		>`
			SELECT provider_reconciliation_locked_at::text, provider_reconciliation_locked_by
			FROM subscriptions WHERE id = ${subscriptionId}
		`;
		await context.repository.renewProviderSubscriptionReconciliationLease(
			claimed.project_id,
			subscriptionId,
			"worker-a",
		);
		const [afterRenew] = await context.sql<
			{ provider_reconciliation_locked_at: string; provider_reconciliation_locked_by: string }[]
		>`
			SELECT provider_reconciliation_locked_at::text, provider_reconciliation_locked_by
			FROM subscriptions WHERE id = ${subscriptionId}
		`;
		expect(afterRenew.provider_reconciliation_locked_by).toBe("worker-b");
		expect(afterRenew.provider_reconciliation_locked_at).toBe(
			beforeRenew.provider_reconciliation_locked_at,
		);
		await context.repository.markProviderSubscriptionReconciliationSucceeded(
			reclaimed.project_id,
			subscriptionId,
			"worker-b",
		);
		await expectNoLocks(context.sql, "subscriptions", [
			"provider_reconciliation_locked_at",
			"provider_reconciliation_locked_by",
		]);
	});
});

function disjoint(left: string[], right: string[]): boolean {
	const rightSet = new Set(right);
	return left.every((value) => !rightSet.has(value));
}

async function expectLockedBy(
	sql: LocalPostgresContext["sql"],
	table: string,
	idColumn: string,
	ids: string[],
	workers: string[],
	lockedByColumn = "locked_by",
): Promise<void> {
	if (
		!/^[a-z_][a-z0-9_]*$/.test(table) ||
		!/^[a-z_][a-z0-9_]*$/.test(idColumn) ||
		!/^[a-z_][a-z0-9_]*$/.test(lockedByColumn)
	) {
		throw new Error("invalid identifier");
	}
	const statusSelect = table === "subscriptions" ? "" : ", status";
	const rows = await sql.unsafe<{ id: string; locked_by: string; status?: string }[]>(
		`SELECT ${idColumn} AS id, ${lockedByColumn} AS locked_by${statusSelect} FROM ${table}`,
	);
	const matched = rows.filter((row) => ids.includes(row.id));
	expect(matched).toHaveLength(ids.length);
	expect(matched.every((row) => workers.includes(row.locked_by))).toBe(true);
	if (table !== "subscriptions") {
		expect(matched.every((row) => row.status === "processing")).toBe(true);
	}
}
