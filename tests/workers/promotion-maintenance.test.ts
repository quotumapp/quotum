import { describe, expect, it } from "bun:test";
import type {
	PromotionStripeSyncJob,
	PromotionStripeSyncOutcome,
} from "../../src/billing/promotions";
import {
	type PromotionMaintenanceRepository,
	PromotionMaintenanceWorker,
} from "../../src/workers/promotion-maintenance";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const job = (objectId: string, attempts = 1): PromotionStripeSyncJob => ({
	projectId: "project-1",
	projectKey: "voysee",
	provider: "stripe",
	objectId,
	promotionKey: "spring-sale",
	promotionName: "Spring sale",
	status: "pending",
	externalId: null,
	desiredActive: true,
	desiredGeneration: 0,
	providerActive: null,
	retireRequested: false,
	attempts,
	objectKind: "coupon",
	discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
	appliesToProducts: null,
});

const resolver = projectContextResolver({
	contexts: [projectInstanceContext("voysee", { projectInstanceId: "project-1" })],
});

function repository(jobs: PromotionStripeSyncJob[]) {
	const outcomes: Array<{ objectId: string; outcome: Record<string, unknown> }> = [];
	const calls: string[] = [];
	const repo: PromotionMaintenanceRepository = {
		async releaseExpiredPromotionReservations(limit) {
			calls.push(`release:${limit}`);
			return 2;
		},
		async reconcilePromotionCoupons(limit) {
			calls.push(`reconcile:${limit}`);
			return { couponsCreated: 1 };
		},
		async ensureHostedPromotionCodeObjects(limit) {
			calls.push(`ensure:${limit}`);
			return 3;
		},
		async claimStripeObjects(workerId, limit) {
			calls.push(`claim:${workerId}:${limit}`);
			return jobs;
		},
		async markStripeObjectOutcome(_projectId, objectId, workerId, outcome) {
			expect(workerId).toBe("worker-1");
			outcomes.push({ objectId, outcome });
		},
	};
	return { repo, outcomes, calls };
}

describe("PromotionMaintenanceWorker", () => {
	it("releases reservations, reconciles objects and records each Stripe outcome", async () => {
		const results: Record<string, PromotionStripeSyncOutcome> = {
			ready: { kind: "ready", externalId: "quotum_ready", providerActive: true },
			retired: { kind: "retired", externalId: "promo_old" },
			retry: { kind: "failed", error: "Stripe timed out", terminal: false },
			terminal: { kind: "failed", error: "No such coupon", terminal: true },
		};
		const { repo, outcomes, calls } = repository(Object.keys(results).map((id) => job(id)));
		const worker = new PromotionMaintenanceWorker({
			workerId: "worker-1",
			batchSize: 10,
			repository: repo,
			projectContextResolver: resolver,
			adapterForJob: () => ({
				promotions: {
					async syncObject(claimed) {
						return results[claimed.objectId] as PromotionStripeSyncOutcome;
					},
				},
			}),
			logger: { error() {} },
		});

		const result = await worker.runOnce();

		expect(calls).toEqual(["release:100", "reconcile:10", "ensure:10", "claim:worker-1:10"]);
		expect(result).toEqual({
			reservationsReleased: 2,
			couponsCreated: 1,
			promotionCodesCreated: 3,
			claimed: 4,
			ready: 1,
			retired: 1,
			retryScheduled: 1,
			failed: 1,
			deferred: 0,
		});
		expect(outcomes.map((entry) => [entry.objectId, entry.outcome.kind])).toEqual([
			["ready", "ready"],
			["retired", "retired"],
			["retry", "failed"],
			["terminal", "failed"],
		]);
		expect(outcomes[2]?.outcome.nextAttemptAt).toBeInstanceOf(Date);
		expect(outcomes[3]?.outcome.nextAttemptAt).toBeNull();
	});

	it("defers projects without Stripe and gives up after the attempt budget", async () => {
		const { repo, outcomes } = repository([job("unconfigured"), job("exhausted", 8)]);
		const worker = new PromotionMaintenanceWorker({
			workerId: "worker-1",
			repository: repo,
			projectContextResolver: resolver,
			adapterForJob: (() => {
				let first = true;
				return () => {
					if (first) {
						first = false;
						return null;
					}
					return {
						promotions: {
							async syncObject() {
								throw new Error("socket hang up");
							},
						},
					};
				};
			})(),
			logger: { error() {} },
		});

		const result = await worker.runOnce();

		expect(result).toMatchObject({ claimed: 2, deferred: 1, failed: 1 });
		expect(outcomes[0]?.outcome).toMatchObject({ kind: "deferred" });
		expect(outcomes[1]?.outcome).toEqual({
			kind: "failed",
			error: "socket hang up",
			nextAttemptAt: null,
		});
	});

	it("selects the adapter by the job's provider and retries when it cannot sync promotions", async () => {
		const selected: string[] = [];
		const { repo, outcomes } = repository([{ ...job("google-object"), provider: "google" }]);
		const worker = new PromotionMaintenanceWorker({
			workerId: "worker-1",
			repository: repo,
			projectContextResolver: resolver,
			adapterForJob(project, provider) {
				selected.push(`${project.projectInstanceKey}:${provider}`);
				return {};
			},
			logger: { error() {} },
		});

		expect(await worker.runOnce()).toMatchObject({ claimed: 1, retryScheduled: 1 });
		expect(selected).toEqual(["voysee:google"]);
		expect(outcomes).toEqual([
			{
				objectId: "google-object",
				outcome: {
					kind: "failed",
					error: "google provider does not serve promotion.hosted_code",
					nextAttemptAt: expect.any(Date),
				},
			},
		]);
	});
});
