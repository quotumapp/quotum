import { describe, expect, it } from "bun:test";
import type { AutoTopupJob } from "../../src/billing/auto-topup";
import { AutoTopupWorker } from "../../src/workers/auto-topup";

const job: AutoTopupJob = {
	jobId: "job-1",
	projectId: "project-1",
	projectKey: "voysee",
	policyId: "7",
	customerId: "customer-1",
	billingAccountId: "account-1",
	externalCustomerId: "cus_1",
	storeProductId: "store-1",
	externalPriceId: "price_topup",
	amountMinor: 500,
	maximumChargeMinor: 600,
	currency: "USD",
	attempts: 1,
	consecutiveFailures: 0,
	maxConsecutiveFailures: 3,
};

describe("AutoTopupWorker", () => {
	it("records a successful off-session top-up", async () => {
		const calls: unknown[] = [];
		const worker = new AutoTopupWorker({
			workerId: "worker-1",
			repository: {
				async claimAutoTopupJobs() {
					return [job];
				},
				async markAutoTopupSucceeded(projectId, jobId, workerId, charge) {
					calls.push({ projectId, jobId, workerId, charge });
					return { circuitOpened: false };
				},
				async markAutoTopupFailed() {
					throw new Error("unexpected failure");
				},
			},
			providerForProject() {
				return {
					async createAutoTopupCharge() {
						return {
							status: "succeeded" as const,
							externalInvoiceId: "in_1",
							externalPaymentId: "pi_1",
							amountPaidMinor: 550,
							currency: "USD",
						};
					},
				};
			},
			logger: { error() {} },
		});

		expect(await worker.runOnce()).toEqual({
			claimed: 1,
			succeeded: 1,
			retryScheduled: 0,
			actionRequired: 0,
			circuitOpened: 0,
			failed: 0,
		});
		expect(calls).toEqual([
			{
				projectId: "project-1",
				jobId: "job-1",
				workerId: "worker-1",
				charge: {
					status: "succeeded",
					externalInvoiceId: "in_1",
					externalPaymentId: "pi_1",
					amountPaidMinor: 550,
					currency: "USD",
				},
			},
		]);
	});

	it("opens the circuit when Stripe requires customer action", async () => {
		const failures: unknown[] = [];
		const worker = new AutoTopupWorker({
			workerId: "worker-1",
			repository: {
				async claimAutoTopupJobs() {
					return [job];
				},
				async markAutoTopupSucceeded() {
					throw new Error("unexpected success");
				},
				async markAutoTopupFailed(_projectId, _jobId, _workerId, input) {
					failures.push(input);
					return { retryScheduled: false, circuitOpened: true };
				},
			},
			providerForProject() {
				return {
					async createAutoTopupCharge() {
						return {
							status: "action_required" as const,
							externalInvoiceId: "in_1",
							externalPaymentId: "pi_1",
							reason: "authentication required",
						};
					},
				};
			},
			logger: { error() {} },
		});

		expect(await worker.runOnce()).toEqual({
			claimed: 1,
			succeeded: 0,
			retryScheduled: 0,
			actionRequired: 1,
			circuitOpened: 1,
			failed: 0,
		});
		expect(failures).toEqual([
			{
				kind: "action_required",
				error: "authentication required",
				nextAttemptAt: null,
				externalInvoiceId: "in_1",
				externalPaymentId: "pi_1",
			},
		]);
	});

	it("retries transient failures and lets the repository open the circuit at the limit", async () => {
		const attempts: Array<Date | null> = [];
		const worker = new AutoTopupWorker({
			workerId: "worker-1",
			repository: {
				async claimAutoTopupJobs() {
					return [job];
				},
				async markAutoTopupSucceeded() {
					throw new Error("unexpected success");
				},
				async markAutoTopupFailed(_projectId, _jobId, _workerId, input) {
					attempts.push(input.nextAttemptAt);
					return { retryScheduled: input.nextAttemptAt !== null, circuitOpened: false };
				},
			},
			providerForProject() {
				return {
					async createAutoTopupCharge() {
						throw new Error("network unavailable");
					},
				};
			},
			logger: { error() {} },
		});

		const result = await worker.runOnce();
		expect(result.failed).toBe(1);
		expect(result.retryScheduled).toBe(1);
		expect(attempts[0]).toBeInstanceOf(Date);

		const finalWorker = new AutoTopupWorker({
			workerId: "worker-1",
			repository: {
				async claimAutoTopupJobs() {
					return [{ ...job, consecutiveFailures: 2, attempts: 3 }];
				},
				async markAutoTopupSucceeded() {
					throw new Error("unexpected success");
				},
				async markAutoTopupFailed(_projectId, _jobId, _workerId, input) {
					expect(input.nextAttemptAt).toBeNull();
					return { retryScheduled: false, circuitOpened: true };
				},
			},
			providerForProject() {
				return {
					async createAutoTopupCharge() {
						throw new Error("network unavailable");
					},
				};
			},
			logger: { error() {} },
		});
		expect((await finalWorker.runOnce()).circuitOpened).toBe(1);
	});
});
