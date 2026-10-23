import {
	type IntegerOverrides,
	loadIntegerSettings,
	resolveIntegerSettings,
} from "../shared/integer-settings";

export const workerIntegerSettings = {
	projectionSyncPollIntervalMs: { variable: "BILLING_PROJECTION_SYNC_POLL_INTERVAL_MS" },
	projectionSyncBatchSize: {
		variable: "BILLING_PROJECTION_SYNC_BATCH_SIZE",
		default: 25,
		max: 100,
	},
	projectionSyncConcurrency: { variable: "BILLING_PROJECTION_SYNC_CONCURRENCY", default: 5 },
	eventDeliveryPollIntervalMs: { variable: "BILLING_EVENT_DELIVERY_POLL_INTERVAL_MS" },
	eventDeliveryBatchSize: { variable: "BILLING_EVENT_DELIVERY_BATCH_SIZE", default: 25, max: 100 },
	eventDeliveryConcurrency: { variable: "BILLING_EVENT_DELIVERY_CONCURRENCY", default: 5 },
	eventDeliveryDispatchBatchSize: {
		variable: "BILLING_EVENT_DELIVERY_DISPATCH_BATCH_SIZE",
		default: 100,
		max: 100,
	},
	eventDeliveryRetentionBatchSize: {
		variable: "BILLING_EVENT_DELIVERY_RETENTION_BATCH_SIZE",
		default: 1000,
		max: 1000,
	},
	eventDeliveryRetentionSweepIntervalMs: {
		variable: "BILLING_EVENT_DELIVERY_RETENTION_SWEEP_INTERVAL_MS",
		default: 600_000,
	},
	storeEventReplayBatchSize: {
		variable: "BILLING_STORE_EVENT_REPLAY_BATCH_SIZE",
		default: 25,
		max: 100,
	},
	subscriptionReconciliationBatchSize: {
		variable: "BILLING_SUBSCRIPTION_RECONCILIATION_BATCH_SIZE",
		default: 25,
		max: 100,
	},
	subscriptionReconciliationDefaultPlanScanSize: {
		variable: "BILLING_SUBSCRIPTION_RECONCILIATION_DEFAULT_PLAN_SCAN_SIZE",
		default: 1000,
	},
	subscriptionReconciliationDefaultPlanMaxBatches: {
		variable: "BILLING_SUBSCRIPTION_RECONCILIATION_DEFAULT_PLAN_MAX_BATCHES",
		default: 10,
	},
	meteringMaintenanceBatchSize: {
		variable: "BILLING_METERING_MAINTENANCE_BATCH_SIZE",
		default: 250,
		max: 1000,
	},
	meteringMaintenanceRetentionBudgetMs: {
		variable: "BILLING_METERING_MAINTENANCE_RETENTION_BUDGET_MS",
		default: 20_000,
	},
	recurringBillingPollIntervalMs: { variable: "BILLING_RECURRING_BILLING_POLL_INTERVAL_MS" },
	recurringBillingBatchSize: { variable: "BILLING_RECURRING_BILLING_BATCH_SIZE", default: 25 },
	autoTopupPollIntervalMs: { variable: "BILLING_AUTO_TOPUP_POLL_INTERVAL_MS" },
	autoTopupBatchSize: { variable: "BILLING_AUTO_TOPUP_BATCH_SIZE", default: 25, max: 100 },
	promotionMaintenancePollIntervalMs: {
		variable: "BILLING_PROMOTION_MAINTENANCE_POLL_INTERVAL_MS",
	},
	promotionMaintenanceBatchSize: {
		variable: "BILLING_PROMOTION_MAINTENANCE_BATCH_SIZE",
		default: 25,
		max: Math.floor(2_147_483_647 / 10),
	},
	customerErasurePollIntervalMs: { variable: "BILLING_CUSTOMER_ERASURE_POLL_INTERVAL_MS" },
	customerErasureBatchSize: {
		variable: "BILLING_CUSTOMER_ERASURE_BATCH_SIZE",
		default: 500,
		max: 5000,
	},
	customerErasureBudgetMs: {
		variable: "BILLING_CUSTOMER_ERASURE_BUDGET_MS",
		default: 15_000,
		// The unchanged lease lasts 300 seconds and must outlive each claim's budget.
		max: 299_999,
	},
	customerErasureMaxClaims: { variable: "BILLING_CUSTOMER_ERASURE_MAX_CLAIMS", default: 5 },
	customerErasureSweepIntervalMs: {
		variable: "BILLING_CUSTOMER_ERASURE_SWEEP_INTERVAL_MS",
		default: 60_000,
	},
	providerOperationRecoveryPollIntervalMs: {
		variable: "BILLING_PROVIDER_OPERATION_RECOVERY_POLL_INTERVAL_MS",
		default: 10_000,
	},
	providerOperationRecoveryBatchSize: {
		variable: "BILLING_PROVIDER_OPERATION_RECOVERY_BATCH_SIZE",
		default: 10,
		max: 100,
	},
	usagePartitionUpkeepPollIntervalMs: {
		variable: "BILLING_USAGE_PARTITION_UPKEEP_POLL_INTERVAL_MS",
		default: 900_000,
	},
	stripeAppEventsPollIntervalMs: { variable: "BILLING_STRIPE_APP_EVENTS_POLL_INTERVAL_MS" },
	stripeAppEventsBatchSize: {
		variable: "BILLING_STRIPE_APP_EVENTS_BATCH_SIZE",
		default: 100,
		max: 100,
	},
	platformRetentionPollIntervalMs: {
		variable: "QUOTUM_PLATFORM_RETENTION_POLL_INTERVAL_MS",
		default: 900_000,
	},
	platformRetentionBatchSize: { variable: "QUOTUM_PLATFORM_RETENTION_BATCH_SIZE", default: 1000 },
	platformRetentionMaxBatchesPerTable: {
		variable: "QUOTUM_PLATFORM_RETENTION_MAX_BATCHES_PER_TABLE",
		default: 25,
	},
} as const;

export type WorkerSettings = IntegerOverrides<typeof workerIntegerSettings>;

export function loadWorkerSettings(source: Record<string, string | undefined> = process.env) {
	return loadIntegerSettings(workerIntegerSettings, source);
}

export function resolveWorkerSettings(
	settings: WorkerSettings & {
		workerPollIntervalMs: number;
		storeEventReplayPollIntervalMs: number;
		meteringMaintenancePollIntervalMs: number;
	},
) {
	const resolved = resolveIntegerSettings(workerIntegerSettings, settings);
	return {
		...resolved,
		projectionSyncPollIntervalMs:
			resolved.projectionSyncPollIntervalMs ?? settings.workerPollIntervalMs,
		eventDeliveryPollIntervalMs:
			resolved.eventDeliveryPollIntervalMs ?? settings.workerPollIntervalMs,
		customerErasurePollIntervalMs:
			resolved.customerErasurePollIntervalMs ?? settings.workerPollIntervalMs,
		recurringBillingPollIntervalMs:
			resolved.recurringBillingPollIntervalMs ?? settings.meteringMaintenancePollIntervalMs,
		autoTopupPollIntervalMs:
			resolved.autoTopupPollIntervalMs ?? settings.meteringMaintenancePollIntervalMs,
		promotionMaintenancePollIntervalMs:
			resolved.promotionMaintenancePollIntervalMs ?? settings.meteringMaintenancePollIntervalMs,
		stripeAppEventsPollIntervalMs:
			resolved.stripeAppEventsPollIntervalMs ?? settings.storeEventReplayPollIntervalMs,
	};
}
