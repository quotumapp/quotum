import { expect, it } from "bun:test";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../../src/billing/recurring";
import { RecurringBillingWorker } from "../../src/workers/recurring-billing";

it("applies due changes and invoices closed overage periods", async () => {
	const applied: string[] = [];
	const invoiced: string[] = [];
	const change = {
		changeId: "change-1",
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
		workerId: "worker-1",
		repository: {
			async claimSubscriptionChanges() {
				return [change];
			},
			async markSubscriptionChangeApplied(_project, id) {
				applied.push(id);
			},
			async markSubscriptionChangeFailed() {},
			async materializeAndClaimUsageInvoicePeriods() {
				return { materialized: 1, jobs: [usage] };
			},
			async markUsageInvoiceSucceeded(_kind, id) {
				invoiced.push(id);
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
