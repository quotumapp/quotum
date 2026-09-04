import { expect, it } from "bun:test";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../../src/billing/recurring";
import { RecurringBillingWorker } from "../../src/workers/recurring-billing";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const workerProjectResolver = projectContextResolver();

it("applies due changes and invoices closed overage periods", async () => {
	const applied: string[] = [];
	const invoiced: string[] = [];
	const change = {
		changeId: "change-1",
		projectInstanceId: projectInstanceContext().projectInstanceId,
		projectKey: "voysee",
		status: "processing",
		changeKind: "upgrade",
		effectiveMode: "immediate",
		effectiveAt: new Date().toISOString(),
		prorationBehavior: "always_invoice",
		externalSubscriptionId: "sub_1",
		targetPlanVersionId: "2",
		items: [],
	} satisfies SubscriptionChangeOperation;
	const usage = {
		jobKind: "period",
		jobId: "period-1",
		periodId: "period-1",
		adjustmentId: null,
		projectInstanceId: projectInstanceContext().projectInstanceId,
		projectKey: "voysee",
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
	} satisfies UsageInvoiceJob;
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
		providerForProject() {
			return {
				async applySubscriptionChange() {
					return "sub_1";
				},
				async createUsageInvoice() {
					return "in_1";
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
	const change = {
		changeId: "mismatched-change",
		projectInstanceId: projectInstanceContext().projectInstanceId,
		projectKey: "wiseley",
		status: "processing",
		changeKind: "upgrade",
		effectiveMode: "immediate",
		effectiveAt: new Date().toISOString(),
		prorationBehavior: "always_invoice",
		externalSubscriptionId: "sub_mismatch",
		targetPlanVersionId: "2",
		items: [],
	} satisfies SubscriptionChangeOperation;
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
		providerForProject() {
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
