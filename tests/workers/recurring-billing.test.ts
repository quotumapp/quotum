import { expect, it } from "bun:test";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../../src/billing/recurring";
import type { ClaimedSubscriptionChange, ClaimedUsageInvoiceJob } from "../../src/db/repository";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import type { OperationTiming } from "../../src/providers/contract";
import {
	RecurringBillingWorker,
	type RecurringBillingWorkerAdapter,
	type RecurringBillingWorkerRepository,
} from "../../src/workers/recurring-billing";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const workerProjectResolver = projectContextResolver();
const timing: OperationTiming = {
	payment: { kind: "uncertain" },
	entitlement: { kind: "awaiting_provider_event" },
};

function changeFixture(overrides: Partial<SubscriptionChangeOperation> = {}) {
	return {
		changeId: "change-1",
		projectInstanceId: projectInstanceContext().projectInstanceId,
		projectKey: "voysee",
		provider: "stripe",
		providerAccountId: null,
		status: "processing",
		subscriptionStatus: "active",
		changeKind: "upgrade",
		effectiveMode: "immediate",
		effectiveAt: new Date().toISOString(),
		prorationBehavior: "always_invoice",
		externalSubscriptionId: "sub_1",
		targetPlanVersionId: "2",
		discountCouponId: null,
		promotionRedemption: null,
		items: [],
		...overrides,
	} satisfies SubscriptionChangeOperation;
}

function usageFixture(overrides: Partial<UsageInvoiceJob> = {}) {
	return {
		jobKind: "period",
		jobId: "period-1",
		periodId: "period-1",
		adjustmentId: null,
		projectInstanceId: projectInstanceContext().projectInstanceId,
		projectKey: "voysee",
		provider: "stripe",
		providerAccountId: null,
		billingAccountId: "account-1",
		externalCustomerId: "cus_1",
		externalSubscriptionId: "sub_1",
		subscriptionStatus: "active",
		externalProductId: "prod_usage",
		featureKey: "api_calls",
		periodStartAt: "2026-01-01T00:00:00.000Z",
		periodEndAt: "2026-02-01T00:00:00.000Z",
		usageQuantity: "1250",
		adjustmentQuantity: null,
		includedQuantity: "1000",
		billableQuantity: "250",
		amountMinor: 250,
		currency: "usd",
		...overrides,
	} satisfies UsageInvoiceJob;
}

function claimedChange(change: SubscriptionChangeOperation): ClaimedSubscriptionChange {
	return {
		projectInstanceId: change.projectInstanceId,
		projectKey: change.projectKey,
		changeId: change.changeId,
	};
}

function claimedUsageJob(job: UsageInvoiceJob): ClaimedUsageInvoiceJob {
	return {
		projectInstanceId: job.projectInstanceId,
		projectKey: job.projectKey,
		jobKind: job.jobKind,
		jobId: job.jobId,
		periodId: job.periodId,
	};
}

function recordingRepository({
	changes = [],
	usage = [],
}: {
	changes?: SubscriptionChangeOperation[];
	usage?: UsageInvoiceJob[];
}) {
	const calls: Array<Record<string, unknown>> = [];
	const repository: RecurringBillingWorkerRepository = {
		async claimSubscriptionChanges() {
			return changes.map(claimedChange);
		},
		async loadClaimedSubscriptionChange(_projectInstanceId, changeId) {
			return changes.find((change) => change.changeId === changeId) ?? null;
		},
		async markSubscriptionChangeApplied(projectInstanceId, changeId, providerRequestId, workerId) {
			calls.push({
				kind: "change_applied",
				projectInstanceId,
				changeId,
				providerRequestId,
				workerId,
			});
		},
		async markSubscriptionChangeFailed(projectInstanceId, changeId, error, workerId) {
			calls.push({ kind: "change_failed", projectInstanceId, changeId, error, workerId });
		},
		async markSubscriptionChangeCancelled(projectInstanceId, changeId, reason, workerId) {
			calls.push({ kind: "change_cancelled", projectInstanceId, changeId, reason, workerId });
		},
		async materializeAndClaimUsageInvoicePeriods() {
			return { materialized: usage.length, jobs: usage.map(claimedUsageJob) };
		},
		async loadClaimedUsageInvoiceJob(_projectInstanceId, jobKind, jobId) {
			return usage.find((job) => job.jobKind === jobKind && job.jobId === jobId) ?? null;
		},
		async markUsageInvoiceSucceeded(
			projectInstanceId,
			jobKind,
			jobId,
			externalInvoiceId,
			workerId,
		) {
			calls.push({
				kind: "usage_succeeded",
				projectInstanceId,
				jobKind,
				jobId,
				externalInvoiceId,
				workerId,
			});
		},
		async markUsageInvoiceFailed(projectInstanceId, jobKind, jobId, error, workerId) {
			calls.push({ kind: "usage_failed", projectInstanceId, jobKind, jobId, error, workerId });
		},
	};
	return { repository, calls };
}

function committedAdapter(): RecurringBillingWorkerAdapter {
	return {
		changes: {
			async apply() {
				return { outcome: "committed", providerRequestId: "sub_1", timing };
			},
		},
		settlement: {
			async collectFinalizedCharge() {
				return { outcome: "committed", externalChargeId: "in_1", timing };
			},
		},
	};
}

// capability: subscription.change.apply
// capability: settlement.collect_finalized_charge
it("applies due changes and invoices closed overage periods", async () => {
	const applied: string[] = [];
	const invoiced: string[] = [];
	const change = changeFixture();
	const usage = usageFixture();
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			async claimSubscriptionChanges() {
				return [claimedChange(change)];
			},
			async loadClaimedSubscriptionChange(projectInstanceId, changeId, workerId) {
				expect(projectInstanceId).toBe(change.projectInstanceId);
				expect(changeId).toBe(change.changeId);
				expect(workerId).toBe("worker-1");
				return change;
			},
			async markSubscriptionChangeApplied(projectInstanceId, id, _providerRequestId, workerId) {
				expect(projectInstanceId).toBe(change.projectInstanceId);
				applied.push(id);
				expect(workerId).toBe("worker-1");
			},
			async markSubscriptionChangeFailed() {},
			async markSubscriptionChangeCancelled() {},
			async materializeAndClaimUsageInvoicePeriods() {
				return { materialized: 1, jobs: [claimedUsageJob(usage)] };
			},
			async loadClaimedUsageInvoiceJob(projectInstanceId, jobKind, jobId, workerId) {
				expect(projectInstanceId).toBe(usage.projectInstanceId);
				expect(jobKind).toBe("period");
				expect(jobId).toBe(usage.jobId);
				expect(workerId).toBe("worker-1");
				return usage;
			},
			async markUsageInvoiceSucceeded(projectInstanceId, _kind, id, _externalInvoiceId, workerId) {
				expect(projectInstanceId).toBe(usage.projectInstanceId);
				invoiced.push(id);
				expect(workerId).toBe("worker-1");
			},
			async markUsageInvoiceFailed() {},
		},
		adapterForJob: committedAdapter,
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 1,
		subscriptionChangesApplied: 1,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 1,
		usageAdjustmentsCreated: 0,
		failed: 0,
	});
	expect(applied).toEqual(["change-1"]);
	expect(invoiced).toEqual(["period-1"]);
});

it("fails claimed recurring-billing work when its project id and key disagree", async () => {
	let providerCalled = false;
	const failures: string[] = [];
	const change = changeFixture({
		changeId: "mismatched-change",
		projectKey: "wiseley",
		externalSubscriptionId: "sub_mismatch",
	});
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			async claimSubscriptionChanges() {
				return [claimedChange(change)];
			},
			async loadClaimedSubscriptionChange() {
				return change;
			},
			async markSubscriptionChangeApplied() {},
			async markSubscriptionChangeFailed(projectInstanceId, _id, error, workerId) {
				expect(projectInstanceId).toBe(change.projectInstanceId);
				expect(workerId).toBe("worker-1");
				failures.push(error);
			},
			async markSubscriptionChangeCancelled() {},
			async materializeAndClaimUsageInvoicePeriods() {
				return { materialized: 0, jobs: [] };
			},
			async loadClaimedUsageInvoiceJob() {
				return null;
			},
			async markUsageInvoiceSucceeded() {},
			async markUsageInvoiceFailed() {},
		},
		adapterForJob() {
			providerCalled = true;
			throw new Error("provider must not be selected");
		},
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 0,
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 0,
		usageAdjustmentsCreated: 0,
		failed: 1,
	});
	expect(providerCalled).toBe(false);
	expect(failures).toEqual([
		"Claimed work project identity does not match the platform project instance",
	]);
});

it("selects each job's adapter by the provider the job stores", async () => {
	const selected: Array<{ project: string; provider: string }> = [];
	const { repository, calls } = recordingRepository({
		changes: [changeFixture({ provider: "google", providerAccountId: "play-account" })],
		usage: [usageFixture({ provider: "apple" })],
	});
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository,
		adapterForJob(project, provider) {
			selected.push({ project: project.projectInstanceKey, provider });
			return {
				changes: {
					async apply(operation) {
						return {
							outcome: "committed",
							providerRequestId: `${operation.provider}-request`,
							timing,
						};
					},
				},
				settlement: {
					async collectFinalizedCharge(job) {
						return { outcome: "committed", externalChargeId: `${job.provider}-charge`, timing };
					},
				},
			};
		},
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toMatchObject({
		subscriptionChangesApplied: 1,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 1,
		failed: 0,
	});
	expect(selected).toEqual([
		{ project: "voysee", provider: "google" },
		{ project: "voysee", provider: "apple" },
	]);
	expect(
		calls.map(({ kind, providerRequestId, externalInvoiceId }) => ({
			kind,
			providerRequestId,
			externalInvoiceId,
		})),
	).toEqual([
		{ kind: "change_applied", providerRequestId: "google-request", externalInvoiceId: undefined },
		{ kind: "usage_succeeded", providerRequestId: undefined, externalInvoiceId: "apple-charge" },
	]);
});

it("never finalizes an uncertain provider write and fails it for reconciliation", async () => {
	const logged: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const change = changeFixture();
	const usage = usageFixture({ jobKind: "adjustment", jobId: "adjustment-1", adjustmentId: "1" });
	const { repository, calls } = recordingRepository({ changes: [change], usage: [usage] });
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository,
		adapterForJob() {
			return {
				changes: {
					async apply() {
						return { outcome: "uncertain", correlation: { requestKey: "change-1" }, timing };
					},
				},
				settlement: {
					async collectFinalizedCharge() {
						return { outcome: "uncertain", correlation: { requestKey: "adjustment-1" }, timing };
					},
				},
			};
		},
		logger: {
			error(message, _error, context) {
				logged.push({ message, context });
			},
		},
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 1,
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 0,
		usageAdjustmentsCreated: 0,
		failed: 2,
	});
	const uncertain = "Provider write outcome is uncertain; reconciliation is required";
	expect(calls).toEqual([
		{
			kind: "change_failed",
			projectInstanceId: change.projectInstanceId,
			changeId: "change-1",
			error: uncertain,
			workerId: "worker-1",
		},
		{
			kind: "usage_failed",
			projectInstanceId: usage.projectInstanceId,
			jobKind: "adjustment",
			jobId: "adjustment-1",
			error: uncertain,
			workerId: "worker-1",
		},
	]);
	expect(logged).toEqual([
		{
			message: "Subscription change failed",
			context: {
				projectKey: "voysee",
				changeId: "change-1",
				correlation: { requestKey: "change-1" },
			},
		},
		{
			message: "Usage invoice failed",
			context: {
				projectKey: "voysee",
				provider: "stripe",
				periodId: "period-1",
				correlation: { requestKey: "adjustment-1" },
			},
		},
	]);
});

it("logs a failing failure marker and still finishes the batch", async () => {
	const logged: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const poisonChange = changeFixture({ changeId: "poison-change" });
	const poisonUsage = usageFixture({ jobId: "poison-period", periodId: "poison-period" });
	const healthyChange = changeFixture({ changeId: "healthy-change" });
	const healthyUsage = usageFixture({ jobId: "healthy-period", periodId: "healthy-period" });
	const { repository, calls } = recordingRepository({
		changes: [poisonChange, healthyChange],
		usage: [poisonUsage, healthyUsage],
	});
	const changeLost = "Subscription change poison-change was not owned by worker";
	const usageLost = "Usage invoice period poison-period was not owned by worker";
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			...repository,
			async markSubscriptionChangeFailed(projectInstanceId, changeId, error, workerId) {
				if (changeId === "poison-change") throw new Error(changeLost);
				await repository.markSubscriptionChangeFailed(projectInstanceId, changeId, error, workerId);
			},
			async markUsageInvoiceFailed(projectInstanceId, jobKind, jobId, error, workerId) {
				if (jobId === "poison-period") throw new Error(usageLost);
				await repository.markUsageInvoiceFailed(projectInstanceId, jobKind, jobId, error, workerId);
			},
		},
		adapterForJob: () => ({
			changes: {
				async apply(operation) {
					if (operation.changeId === "poison-change") {
						return { outcome: "uncertain", correlation: { requestKey: "poison-change" }, timing };
					}
					return { outcome: "committed", providerRequestId: "sub_1", timing };
				},
			},
			settlement: {
				async collectFinalizedCharge(job) {
					if (job.jobId === "poison-period") {
						return { outcome: "uncertain", correlation: { requestKey: "poison-period" }, timing };
					}
					return { outcome: "committed", externalChargeId: "in_1", timing };
				},
			},
		}),
		logger: {
			error(message, _error, context) {
				logged.push({ message, context });
			},
		},
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 2,
		subscriptionChangesApplied: 1,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 1,
		usageAdjustmentsCreated: 0,
		failed: 2,
	});
	// The healthy jobs of both batches still finalize after the markers throw.
	expect(calls.map(({ kind, changeId, jobId }) => ({ kind, changeId, jobId }))).toEqual([
		{ kind: "change_applied", changeId: "healthy-change", jobId: undefined },
		{ kind: "usage_succeeded", changeId: undefined, jobId: "healthy-period" },
	]);
	// The correlation is logged before the marker, and the marker failure is logged in its place.
	expect(logged).toEqual([
		{
			message: "Subscription change failed",
			context: {
				projectKey: "voysee",
				changeId: "poison-change",
				correlation: { requestKey: "poison-change" },
			},
		},
		{
			message: "Subscription change failure marker failed",
			context: { projectKey: "voysee", changeId: "poison-change", workerId: "worker-1" },
		},
		{
			message: "Usage invoice failed",
			context: {
				projectKey: "voysee",
				provider: "stripe",
				periodId: "poison-period",
				correlation: { requestKey: "poison-period" },
			},
		},
		{
			message: "Usage invoice failure marker failed",
			context: {
				projectKey: "voysee",
				jobKind: "period",
				jobId: "poison-period",
				workerId: "worker-1",
			},
		},
	]);
});

it("fails only the claimed job that cannot be loaded", async () => {
	const healthyChange = changeFixture({ changeId: "healthy-change" });
	const healthyUsage = usageFixture({ jobId: "healthy-period", periodId: "healthy-period" });
	const { repository, calls } = recordingRepository({
		changes: [healthyChange],
		usage: [healthyUsage],
	});
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			...repository,
			async claimSubscriptionChanges() {
				return [
					claimedChange(changeFixture({ changeId: "poison-change" })),
					claimedChange(healthyChange),
				];
			},
			async loadClaimedSubscriptionChange(projectInstanceId, changeId, workerId) {
				if (changeId === "poison-change") {
					throw new Error("Target plan has no Stripe recurring prices");
				}
				return await repository.loadClaimedSubscriptionChange(
					projectInstanceId,
					changeId,
					workerId,
				);
			},
			async materializeAndClaimUsageInvoicePeriods() {
				return {
					materialized: 2,
					jobs: [
						claimedUsageJob(usageFixture({ jobId: "poison-period", periodId: "poison-period" })),
						claimedUsageJob(healthyUsage),
					],
				};
			},
			async loadClaimedUsageInvoiceJob(projectInstanceId, jobKind, jobId, workerId) {
				if (jobId === "poison-period") {
					throw new Error("Usage invoice period poison-period cannot be invoiced");
				}
				return await repository.loadClaimedUsageInvoiceJob(
					projectInstanceId,
					jobKind,
					jobId,
					workerId,
				);
			},
		},
		adapterForJob: committedAdapter,
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 2,
		subscriptionChangesApplied: 1,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 1,
		usageAdjustmentsCreated: 0,
		failed: 2,
	});
	expect(
		calls.map(({ kind, changeId, jobId, error }) => ({ kind, changeId, jobId, error })),
	).toEqual([
		{
			kind: "change_failed",
			changeId: "poison-change",
			jobId: undefined,
			error: "Target plan has no Stripe recurring prices",
		},
		{
			kind: "change_applied",
			changeId: "healthy-change",
			jobId: undefined,
			error: undefined,
		},
		{
			kind: "usage_failed",
			changeId: undefined,
			jobId: "poison-period",
			error: "Usage invoice period poison-period cannot be invoiced",
		},
		{
			kind: "usage_succeeded",
			changeId: undefined,
			jobId: "healthy-period",
			error: undefined,
		},
	]);
});

it("skips a claimed job whose lease was lost without marking it", async () => {
	const warned: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const { repository, calls } = recordingRepository({});
	let adapterCalls = 0;
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			...repository,
			async claimSubscriptionChanges() {
				return [claimedChange(changeFixture({ changeId: "reclaimed-change" }))];
			},
			async materializeAndClaimUsageInvoicePeriods() {
				return {
					materialized: 0,
					jobs: [
						claimedUsageJob(
							usageFixture({ jobId: "reclaimed-period", periodId: "reclaimed-period" }),
						),
					],
				};
			},
		},
		adapterForJob() {
			adapterCalls += 1;
			return committedAdapter();
		},
		logger: {
			error() {},
			warn(message, context) {
				warned.push({ message, context });
			},
		},
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 0,
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 0,
		usageAdjustmentsCreated: 0,
		failed: 0,
	});
	expect(calls).toEqual([]);
	expect(adapterCalls).toBe(0);
	expect(warned).toEqual([
		{
			message: "Subscription change lease lost",
			context: {
				projectKey: "voysee",
				changeId: "reclaimed-change",
				workerId: "worker-1",
			},
		},
		{
			message: "Usage invoice lease lost",
			context: {
				projectKey: "voysee",
				jobKind: "period",
				jobId: "reclaimed-period",
				workerId: "worker-1",
			},
		},
	]);
});

it("still invoices usage when the subscription change claim throws", async () => {
	const logged: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const usage = usageFixture();
	const { repository, calls } = recordingRepository({ usage: [usage] });
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			...repository,
			async claimSubscriptionChanges() {
				throw new Error("deadlock detected");
			},
		},
		adapterForJob: committedAdapter,
		logger: {
			error(message, _error, context) {
				logged.push({ message, context });
			},
		},
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 1,
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 1,
		usageAdjustmentsCreated: 0,
		failed: 1,
	});
	expect(calls.map(({ kind, jobId }) => ({ kind, jobId }))).toEqual([
		{ kind: "usage_succeeded", jobId: "period-1" },
	]);
	expect(logged).toEqual([
		{ message: "Subscription change claim failed", context: { workerId: "worker-1" } },
	]);
});

it("still applies changes when the usage invoice claim throws", async () => {
	const logged: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const change = changeFixture();
	const { repository, calls } = recordingRepository({ changes: [change] });
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			...repository,
			async materializeAndClaimUsageInvoicePeriods() {
				throw new Error("deadlock detected");
			},
		},
		adapterForJob: committedAdapter,
		logger: {
			error(message, _error, context) {
				logged.push({ message, context });
			},
		},
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 0,
		subscriptionChangesApplied: 1,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 0,
		usageAdjustmentsCreated: 0,
		failed: 1,
	});
	expect(calls.map(({ kind }) => kind)).toEqual(["change_applied"]);
	expect(logged).toEqual([
		{ message: "Usage invoice claim failed", context: { workerId: "worker-1" } },
	]);
});

it("reports staging and materialization failures without abandoning the poll", async () => {
	const logged: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const { repository } = recordingRepository({});
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			...repository,
			async claimSubscriptionChanges(_workerId, _limit, options) {
				options?.onStagingError?.(new Error("staging deadlock"));
				return [];
			},
			async materializeAndClaimUsageInvoicePeriods(_workerId, _limit, options) {
				options?.onMaterializationError?.(new Error("Tiered pricing requires at least one tier"), {
					projectInstanceId: projectInstanceContext().projectInstanceId,
					subscriptionId: "sub_broken",
				});
				return { materialized: 1, jobs: [] };
			},
		},
		adapterForJob: committedAdapter,
		logger: {
			error(message, _error, context) {
				logged.push({ message, context });
			},
		},
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 1,
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 0,
		usageInvoicesCreated: 0,
		usageAdjustmentsCreated: 0,
		failed: 0,
	});
	expect(logged).toEqual([
		{ message: "Catalog migration staging failed", context: { workerId: "worker-1" } },
		{
			message: "Usage invoice materialization failed",
			context: {
				projectInstanceId: projectInstanceContext().projectInstanceId,
				subscriptionId: "sub_broken",
				workerId: "worker-1",
			},
		},
	]);
});

it("fails jobs whose provider adapter does not serve the operation", async () => {
	const { repository, calls } = recordingRepository({
		changes: [
			changeFixture({ changeId: "immediate" }),
			changeFixture({ changeId: "period-end", effectiveMode: "period_end" }),
		],
		usage: [
			usageFixture({ provider: "apple" }),
			usageFixture({ jobKind: "adjustment", jobId: "adjustment-1", adjustmentId: "1" }),
		],
	});
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository,
		adapterForJob: (): RecurringBillingWorkerAdapter => ({}),
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toMatchObject({ failed: 4 });
	expect(calls.map(({ kind, error }) => ({ kind, error }))).toEqual([
		{ kind: "change_failed", error: "stripe provider does not serve subscription.change.apply" },
		{
			kind: "change_failed",
			error: "stripe provider does not serve subscription.change.period_end",
		},
		{
			kind: "usage_failed",
			error: "apple provider does not serve settlement.collect_finalized_charge",
		},
		{ kind: "usage_failed", error: "stripe provider does not serve adjustment.issue" },
	]);
});

it("marks every failing job even when the logger throws", async () => {
	const { repository, calls } = recordingRepository({
		changes: [
			changeFixture({ changeId: "immediate" }),
			changeFixture({ changeId: "period-end", effectiveMode: "period_end" }),
		],
		usage: [usageFixture()],
	});
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository,
		adapterForJob: (): RecurringBillingWorkerAdapter => ({}),
		logger: {
			error() {
				throw new Error("logger is unavailable");
			},
			warn() {
				throw new Error("logger is unavailable");
			},
		},
	});

	expect(await worker.runOnce()).toMatchObject({ failed: 3 });
	expect(calls.map(({ kind }) => kind)).toEqual(["change_failed", "change_failed", "usage_failed"]);
});

// capability: subscription.change.apply
it("ends a due change whose subscription has already expired without calling the provider", async () => {
	let applyCalls = 0;
	const { repository, calls } = recordingRepository({
		changes: [changeFixture({ subscriptionStatus: "expired" })],
	});
	const metrics = createInMemoryBillingMetrics();
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository,
		metrics,
		adapterForJob: (): RecurringBillingWorkerAdapter => ({
			changes: {
				async apply() {
					applyCalls += 1;
					return { outcome: "committed", providerRequestId: "sub_1", timing };
				},
			},
		}),
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toMatchObject({
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 1,
		failed: 0,
	});
	expect(applyCalls).toBe(0);
	expect(calls).toEqual([
		{
			kind: "change_cancelled",
			projectInstanceId: projectInstanceContext().projectInstanceId,
			changeId: "change-1",
			reason: "The subscription is expired and can no longer be changed",
			workerId: "worker-1",
		},
	]);
	expect(metrics.renderPrometheus()).toContain(
		'billing_worker_jobs_total{operation="subscription_change",result="cancelled",worker="recurring_billing"} 1',
	);
});

// capability: subscription.change.apply
it("ends a change the provider refuses because the subscription is gone, and retries other errors", async () => {
	const { repository, calls } = recordingRepository({
		changes: [
			changeFixture({ changeId: "gone" }),
			changeFixture({ changeId: "already-cancelled" }),
			changeFixture({ changeId: "transient" }),
		],
	});
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository,
		adapterForJob: (): RecurringBillingWorkerAdapter => ({
			changes: {
				async apply(operation) {
					if (operation.changeId === "gone") {
						throw new Error("No such subscription: 'sub_1'");
					}
					if (operation.changeId === "already-cancelled") {
						throw new Error("You cannot update a canceled subscription");
					}
					throw new Error("Stripe is temporarily unavailable");
				},
			},
		}),
		logger: { error() {}, warn() {} },
	});

	expect(await worker.runOnce()).toMatchObject({
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 2,
		failed: 1,
	});
	expect(calls.map(({ kind, changeId }) => ({ kind, changeId }))).toEqual([
		{ kind: "change_cancelled", changeId: "gone" },
		{ kind: "change_cancelled", changeId: "already-cancelled" },
		{ kind: "change_failed", changeId: "transient" },
	]);
});

// capability: subscription.change.apply
it("counts a failure, not a cancellation, when the terminal mark cannot be written", async () => {
	const { repository } = recordingRepository({
		changes: [changeFixture({ subscriptionStatus: "expired" })],
	});
	const metrics = createInMemoryBillingMetrics();
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository: {
			...repository,
			async markSubscriptionChangeCancelled() {
				throw new Error("Subscription change change-1 was not owned by worker");
			},
		},
		metrics,
		adapterForJob: (): RecurringBillingWorkerAdapter => ({
			changes: {
				async apply() {
					return { outcome: "committed", providerRequestId: "sub_1", timing };
				},
			},
		}),
		logger: { error() {} },
	});

	// The row stays `processing` for its lease to expire, so the next claim decides its fate.
	expect(await worker.runOnce()).toMatchObject({
		subscriptionChangesApplied: 0,
		subscriptionChangesCancelled: 0,
		failed: 1,
	});
	expect(metrics.renderPrometheus()).toContain(
		'billing_worker_jobs_total{operation="subscription_change",result="failed",worker="recurring_billing"} 1',
	);
	expect(metrics.renderPrometheus()).not.toContain('result="cancelled"');
});

it("keeps an uncertain provider write retryable even when it mentions a cancelled subscription", async () => {
	const { repository, calls } = recordingRepository({ changes: [changeFixture()] });
	const worker = new RecurringBillingWorker({
		projectContextResolver: workerProjectResolver,
		workerId: "worker-1",
		repository,
		adapterForJob: (): RecurringBillingWorkerAdapter => ({
			changes: {
				async apply() {
					return {
						outcome: "uncertain",
						correlation: { requestKey: "no such subscription" },
						timing,
					};
				},
			},
		}),
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toMatchObject({ subscriptionChangesCancelled: 0, failed: 1 });
	expect(calls.map(({ kind }) => kind)).toEqual(["change_failed"]);
});
