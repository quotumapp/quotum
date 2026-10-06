import { describe, expect, it } from "bun:test";
import { BillingError } from "../../src/billing/errors";
import { BillingAdminOperations } from "../../src/operations/admin";
import type { ProjectInstanceContext } from "../../src/projects/context";
import { projectInstanceContext } from "../helpers/project-context";

const validStoreEventId = "123e4567-e89b-12d3-a456-426614174000";
const validProjectionJobId = "123e4567-e89b-12d3-a456-426614174001";
const project = projectInstanceContext();

describe("BillingAdminOperations", () => {
	it("replays a store event by id", async () => {
		const calls: Array<{ project: ProjectInstanceContext; eventId: string }> = [];
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne(inputProject, eventId) {
					calls.push({ project: inputProject, eventId });
					return Promise.resolve({ eventId, status: "processed" as const });
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
		});

		const result = await operations.replayStoreEvent(project, validStoreEventId);

		expect(calls).toEqual([{ project, eventId: validStoreEventId }]);
		expect(result).toEqual({ eventId: validStoreEventId, status: "processed" });
	});

	it("trims store event ids before replaying", async () => {
		const calls: Array<{ project: ProjectInstanceContext; eventId: string }> = [];
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne(inputProject, eventId) {
					calls.push({ project: inputProject, eventId });
					return Promise.resolve({ eventId, status: "ignored" as const });
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
		});

		const result = await operations.replayStoreEvent(project, `  ${validStoreEventId}  `);

		expect(calls).toEqual([{ project, eventId: validStoreEventId }]);
		expect(result).toEqual({ eventId: validStoreEventId, status: "ignored" });
	});

	it("rejects blank store event ids without calling the replay worker", async () => {
		let calls = 0;
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne() {
					calls += 1;
					return Promise.resolve({ eventId: validStoreEventId, status: "processed" as const });
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
		});

		await expect(operations.replayStoreEvent(project, "   ")).rejects.toBeInstanceOf(BillingError);
		await expect(operations.replayStoreEvent(project, "   ")).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			message: "Invalid store event id",
			status: 400,
		});
		expect(calls).toBe(0);
	});

	it("rejects malformed store event ids without calling the replay worker", async () => {
		let calls = 0;
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne() {
					calls += 1;
					return Promise.resolve({ eventId: validStoreEventId, status: "processed" as const });
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
		});

		await expect(operations.replayStoreEvent(project, "not-a-uuid")).rejects.toBeInstanceOf(
			BillingError,
		);
		await expect(operations.replayStoreEvent(project, "not-a-uuid")).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			message: "Invalid store event id",
			status: 400,
		});
		expect(calls).toBe(0);
	});

	it("runs subscription reconciliation", async () => {
		let calls = 0;
		const reconciliationResult = {
			outcome: "succeeded" as const,
			expiredSubscriptions: 2,
			affectedCustomers: 1,
			expiredPlanGrants: 0,
			defaultPlanGrants: 0,
			defaultPlanSkipped: 0,
			defaultPlanFailedSlices: 0,
			trialEndingNotices: 0,
			providerClaimed: 3,
			providerProcessed: 2,
			providerSkipped: 1,
			providerFailed: 0,
		};
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne() {
					throw new Error("Unexpected replay run");
				},
			},
			reconciliationWorker: {
				runOnce() {
					calls += 1;
					return Promise.resolve(reconciliationResult);
				},
			},
		});

		const result = await operations.runSubscriptionReconciliation();

		expect(calls).toBe(1);
		expect(result).toEqual(reconciliationResult);
	});

	it("requeues failed projection jobs through the project-scoped repository", async () => {
		const calls: Array<{ project: ProjectInstanceContext; jobId: string }> = [];
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne() {
					throw new Error("Unexpected replay run");
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
			projectionRepository: {
				retryProjectionSyncJob(inputProject, jobId) {
					calls.push({ project: inputProject, jobId });
					return Promise.resolve({ jobId, status: "pending" as const });
				},
			},
		});

		await expect(operations.retryProjectionSyncJob(project, validProjectionJobId)).resolves.toEqual(
			{
				jobId: validProjectionJobId,
				status: "pending",
			},
		);
		expect(calls).toEqual([{ project, jobId: validProjectionJobId }]);
	});

	it("requeues recurring jobs through the project-scoped repository and validates ids", async () => {
		const calls: Array<{ kind: string; jobId: string }> = [];
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne() {
					throw new Error("Unexpected replay run");
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
			recurringJobRepository: {
				retryRecurringJob(_project, jobKind, jobId) {
					calls.push({ kind: jobKind, jobId });
					return Promise.resolve({ jobKind, jobId, status: "pending" as const });
				},
			},
		});

		await expect(
			operations.retryRecurringJob(project, "usage-invoice-period", ` ${validProjectionJobId} `),
		).resolves.toEqual({
			jobKind: "usage-invoice-period",
			jobId: validProjectionJobId,
			status: "pending",
		});
		await expect(
			operations.retryRecurringJob(project, "usage-invoice-adjustment", "42"),
		).resolves.toMatchObject({ jobId: "42" });
		expect(calls).toEqual([
			{ kind: "usage-invoice-period", jobId: validProjectionJobId },
			{ kind: "usage-invoice-adjustment", jobId: "42" },
		]);

		// Adjustments are numbered and stay inside bigint; the other jobs are UUIDs.
		for (const [kind, id] of [
			["usage-invoice-adjustment", validProjectionJobId],
			["usage-invoice-adjustment", "0"],
			["usage-invoice-adjustment", "9999999999999999999"],
			["usage-invoice-adjustment", "1e3"],
			["subscription-change", "42"],
			["usage-invoice-period", "not-a-uuid"],
		] as const) {
			expect(() => operations.retryRecurringJob(project, kind, id)).toThrow(
				"Invalid recurring billing job id",
			);
		}
		expect(calls).toHaveLength(2);
	});

	it("reports recurring job recovery as not configured without a repository", () => {
		const operations = new BillingAdminOperations({
			replayWorker: {
				runOne() {
					throw new Error("Unexpected replay run");
				},
			},
			reconciliationWorker: {
				runOnce() {
					throw new Error("Unexpected reconciliation run");
				},
			},
		});

		expect(() =>
			operations.retryRecurringJob(project, "subscription-change", validProjectionJobId),
		).toThrow("Recurring billing recovery is not configured");
	});
});
