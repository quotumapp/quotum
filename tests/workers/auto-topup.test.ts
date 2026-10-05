import { describe, expect, it } from "bun:test";
import type { AutoTopupJob } from "../../src/billing/auto-topup";
import type { OperationTiming } from "../../src/providers/contract";
import { AutoTopupWorker, type AutoTopupWorkerAdapter } from "../../src/workers/auto-topup";
import { heartbeatTimers } from "../helpers/heartbeat-timers";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const job: AutoTopupJob = {
	jobId: "job-1",
	projectId: "project-1",
	projectKey: "acme",
	provider: "stripe",
	providerAccountId: null,
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
const timing: OperationTiming = {
	payment: { kind: "collected" },
	entitlement: { kind: "unchanged" },
};
const workerProjectResolver = projectContextResolver({
	contexts: [projectInstanceContext("acme", { projectInstanceId: job.projectId })],
});

it.each(["before", "during", "unavailable"])(
	"does not charge or finalize an auto top-up after ownership is %s",
	async (stage) => {
		const clock = heartbeatTimers();
		let charged = 0;
		let markers = 0;
		let owned = stage !== "before";
		const worker = new AutoTopupWorker({
			workerId: "worker-1",
			projectContextResolver: workerProjectResolver,
			leaseHeartbeatTimers: clock.timers,
			repository: {
				async claimAutoTopupJobs() {
					return [job];
				},
				async renewAutoTopupJobLease() {
					if (stage === "unavailable") throw new Error("database unavailable");
					return owned;
				},
				async markAutoTopupSucceeded() {
					markers++;
					return { circuitOpened: false };
				},
				async markAutoTopupFailed() {
					markers++;
					return { circuitOpened: false, retryScheduled: false };
				},
			},
			adapterForJob: () => ({
				topups: {
					async chargeAutomatic() {
						charged++;
						owned = false;
						return {
							status: "succeeded",
							externalInvoiceId: "in_1",
							externalPaymentId: "pi_1",
							amountPaidMinor: 500,
							currency: "USD",
							timing,
						};
					},
				},
			}),
			logger: { error() {} },
		});
		const result = await worker.runOnce();
		expect(charged).toBe(stage === "during" ? 1 : 0);
		expect(markers).toBe(0);
		expect(result.succeeded).toBe(0);
		expect(result.failed).toBe(stage === "unavailable" ? 1 : 0);
		expect(clock.active).toBe(0);
	},
);

describe("AutoTopupWorker", () => {
	// capability: topup.automatic
	it("records a successful off-session top-up", async () => {
		const calls: unknown[] = [];
		const worker = new AutoTopupWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-1",
			repository: {
				async renewAutoTopupJobLease() {
					return true;
				},
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
			adapterForJob() {
				return {
					topups: {
						async chargeAutomatic() {
							return {
								status: "succeeded" as const,
								externalInvoiceId: "in_1",
								externalPaymentId: "pi_1",
								amountPaidMinor: 550,
								currency: "USD",
								timing,
							};
						},
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

	// capability: topup.automatic
	it("opens the circuit when Stripe requires customer action", async () => {
		const failures: unknown[] = [];
		const worker = new AutoTopupWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-1",
			repository: {
				async renewAutoTopupJobLease() {
					return true;
				},
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
			adapterForJob() {
				return {
					topups: {
						async chargeAutomatic() {
							return {
								status: "action_required" as const,
								externalInvoiceId: "in_1",
								externalPaymentId: "pi_1",
								reason: "authentication required",
								timing: {
									payment: { kind: "pending_customer" as const },
									entitlement: { kind: "unchanged" as const },
								},
							};
						},
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
			projectContextResolver: workerProjectResolver,
			workerId: "worker-1",
			repository: {
				async renewAutoTopupJobLease() {
					return true;
				},
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
			adapterForJob() {
				return {
					topups: {
						async chargeAutomatic() {
							throw new Error("network unavailable");
						},
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
			projectContextResolver: workerProjectResolver,
			workerId: "worker-1",
			repository: {
				async renewAutoTopupJobLease() {
					return true;
				},
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
			adapterForJob() {
				return {
					topups: {
						async chargeAutomatic() {
							throw new Error("network unavailable");
						},
					},
				};
			},
			logger: { error() {} },
		});
		expect((await finalWorker.runOnce()).circuitOpened).toBe(1);
	});

	it("selects the adapter by the job's provider and retries when it cannot charge", async () => {
		const selected: string[] = [];
		const failures: unknown[] = [];
		const worker = new AutoTopupWorker({
			projectContextResolver: workerProjectResolver,
			workerId: "worker-1",
			repository: {
				async renewAutoTopupJobLease() {
					return true;
				},
				async claimAutoTopupJobs() {
					return [{ ...job, provider: "google", providerAccountId: "play-account" }];
				},
				async markAutoTopupSucceeded() {
					throw new Error("unexpected success");
				},
				async markAutoTopupFailed(_projectId, _jobId, _workerId, input) {
					failures.push({ kind: input.kind, error: input.error });
					return { retryScheduled: true, circuitOpened: false };
				},
			},
			adapterForJob(project, provider): AutoTopupWorkerAdapter {
				selected.push(`${project.projectInstanceKey}:${provider}`);
				return {};
			},
			logger: { error() {} },
		});

		expect(await worker.runOnce()).toMatchObject({ claimed: 1, failed: 1, retryScheduled: 1 });
		expect(selected).toEqual(["acme:google"]);
		expect(failures).toEqual([
			{ kind: "retryable", error: "google provider does not serve topup.automatic" },
		]);
	});
});
