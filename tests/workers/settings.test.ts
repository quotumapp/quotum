import { describe, expect, it } from "bun:test";
import { loadEnv } from "../../src/env";
import {
	loadWorkerSettings,
	resolveWorkerSettings,
	workerIntegerSettings,
} from "../../src/workers/settings";

const legacy = {
	workerPollIntervalMs: 5000,
	storeEventReplayPollIntervalMs: 5000,
	meteringMaintenancePollIntervalMs: 60_000,
};

describe("worker environment settings", () => {
	it("preserves the current runtime's batches, concurrency, budgets and intervals", () => {
		expect(loadWorkerSettings({})).toEqual({});
		expect(resolveWorkerSettings(legacy)).toEqual({
			projectionSyncPollIntervalMs: 5000,
			projectionSyncBatchSize: 25,
			projectionSyncConcurrency: 5,
			eventDeliveryPollIntervalMs: 5000,
			eventDeliveryBatchSize: 25,
			eventDeliveryConcurrency: 5,
			eventDeliveryDispatchBatchSize: 100,
			eventDeliveryRetentionBatchSize: 1000,
			eventDeliveryRetentionSweepIntervalMs: 600_000,
			storeEventReplayBatchSize: 25,
			subscriptionReconciliationBatchSize: 25,
			subscriptionReconciliationDefaultPlanScanSize: 1000,
			subscriptionReconciliationDefaultPlanMaxBatches: 10,
			meteringMaintenanceBatchSize: 250,
			meteringMaintenanceRetentionBudgetMs: 20_000,
			recurringBillingPollIntervalMs: 60_000,
			recurringBillingBatchSize: 25,
			autoTopupPollIntervalMs: 60_000,
			autoTopupBatchSize: 25,
			promotionMaintenancePollIntervalMs: 60_000,
			promotionMaintenanceBatchSize: 25,
			customerErasurePollIntervalMs: 5000,
			customerErasureBatchSize: 500,
			customerErasureBudgetMs: 15_000,
			customerErasureMaxClaims: 5,
			customerErasureSweepIntervalMs: 60_000,
			providerOperationRecoveryPollIntervalMs: 10_000,
			providerOperationRecoveryBatchSize: 10,
			usagePartitionUpkeepPollIntervalMs: 900_000,
			stripeAppEventsPollIntervalMs: 5000,
			stripeAppEventsBatchSize: 100,
			platformRetentionPollIntervalMs: 900_000,
			platformRetentionBatchSize: 1000,
			platformRetentionMaxBatchesPerTable: 25,
		});
	});

	it("keeps legacy poll fallbacks and gives each explicit worker override precedence", () => {
		const base = {
			workerPollIntervalMs: 10,
			storeEventReplayPollIntervalMs: 20,
			meteringMaintenancePollIntervalMs: 30,
		};
		expect(resolveWorkerSettings(base)).toMatchObject({
			projectionSyncPollIntervalMs: 10,
			eventDeliveryPollIntervalMs: 10,
			customerErasurePollIntervalMs: 10,
			recurringBillingPollIntervalMs: 30,
			autoTopupPollIntervalMs: 30,
			promotionMaintenancePollIntervalMs: 30,
			stripeAppEventsPollIntervalMs: 20,
		});
		expect(
			resolveWorkerSettings({
				...base,
				projectionSyncPollIntervalMs: 123,
				autoTopupPollIntervalMs: 456,
				stripeAppEventsPollIntervalMs: 789,
			}),
		).toMatchObject({
			projectionSyncPollIntervalMs: 123,
			eventDeliveryPollIntervalMs: 10,
			autoTopupPollIntervalMs: 456,
			stripeAppEventsPollIntervalMs: 789,
		});
	});

	for (const [field, setting] of Object.entries(workerIntegerSettings)) {
		it(`loads and validates ${setting.variable}`, () => {
			const source = {
				POSTGRES_URI: "postgres://localhost/test",
				BILLING_ENV: "test",
				[setting.variable]: "9",
			};
			expect(loadEnv(source)).toHaveProperty(field, 9);
			for (const value of ["0", "-1", "", "1.5", "1e2", "9007199254740992"]) {
				expect(() => loadEnv({ ...source, [setting.variable]: value })).toThrow(setting.variable);
			}
			if ("max" in setting) {
				expect(() => loadWorkerSettings({ [setting.variable]: String(setting.max + 1) })).toThrow(
					setting.variable,
				);
			}
		});
	}

	it("validates programmatic overrides and the erasure budget against its lease", () => {
		expect(() => resolveWorkerSettings({ ...legacy, projectionSyncBatchSize: 101 })).toThrow(
			"BILLING_PROJECTION_SYNC_BATCH_SIZE",
		);
		expect(() => resolveWorkerSettings({ ...legacy, customerErasureBudgetMs: 300_000 })).toThrow(
			"BILLING_CUSTOMER_ERASURE_BUDGET_MS",
		);
		expect(
			resolveWorkerSettings({ ...legacy, customerErasureBudgetMs: 299_999 })
				.customerErasureBudgetMs,
		).toBe(299_999);
	});
});
