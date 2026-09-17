import { expect, it } from "bun:test";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../../src/billing/recurring";
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
			return changes;
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
		async materializeAndClaimUsageInvoicePeriods() {
			return { materialized: usage.length, jobs: usage };
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
				return [change];
			},
			async markSubscriptionChangeApplied(projectInstanceId, id, _providerRequestId, workerId) {
				expect(projectInstanceId).toBe(change.projectInstanceId);
				applied.push(id);
				expect(workerId).toBe("worker-1");
			},
			async markSubscriptionChangeFailed() {},
			async materializeAndClaimUsageInvoicePeriods() {
				return { materialized: 1, jobs: [usage] };
			},
			async markUsageInvoiceSucceeded(projectInstanceId, _kind, id, _externalInvoiceId, workerId) {
				expect(projectInstanceId).toBe(usage.projectInstanceId);
				invoiced.push(id);
				expect(workerId).toBe("worker-1");
			},
			async markUsageInvoiceFailed() {},
		},
		adapterForJob() {
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
		},
		logger: { error() {} },
	});

	expect(await worker.runOnce()).toEqual({
		materializedUsagePeriods: 1,
		subscriptionChangesApplied: 1,
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
				return [change];
			},
			async markSubscriptionChangeApplied() {},
			async markSubscriptionChangeFailed(projectInstanceId, _id, error, workerId) {
				expect(projectInstanceId).toBe(change.projectInstanceId);
				expect(workerId).toBe("worker-1");
				failures.push(error);
			},
			async materializeAndClaimUsageInvoicePeriods() {
				return { materialized: 0, jobs: [] };
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

it("logs an uncertain write's correlation even when marking the job failed throws", async () => {
	const logged: Array<Record<string, unknown> | undefined> = [];
	const workerFor = (repository: RecurringBillingWorkerRepository) =>
		new RecurringBillingWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-1",
			repository,
			adapterForJob: () => ({
				changes: {
					async apply() {
						return { outcome: "uncertain", correlation: { requestKey: "change-1" }, timing };
					},
				},
				settlement: {
					async collectFinalizedCharge() {
						return { outcome: "uncertain", correlation: { requestKey: "period-1" }, timing };
					},
				},
			}),
			logger: {
				error(_message, _error, context) {
					logged.push(context);
				},
			},
		});
	const changeLost = "Subscription change change-1 was not owned by worker";
	const usageLost = "Usage invoice period period-1 was not owned by worker";

	await expect(
		workerFor({
			...recordingRepository({ changes: [changeFixture()] }).repository,
			async markSubscriptionChangeFailed() {
				throw new Error(changeLost);
			},
		}).runOnce(),
	).rejects.toThrow(changeLost);
	await expect(
		workerFor({
			...recordingRepository({ usage: [usageFixture()] }).repository,
			async markUsageInvoiceFailed() {
				throw new Error(usageLost);
			},
		}).runOnce(),
	).rejects.toThrow(usageLost);
	expect(logged).toEqual([
		{ projectKey: "voysee", changeId: "change-1", correlation: { requestKey: "change-1" } },
		{
			projectKey: "voysee",
			provider: "stripe",
			periodId: "period-1",
			correlation: { requestKey: "period-1" },
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
