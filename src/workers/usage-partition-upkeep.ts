import type {
	UsagePartitionUpkeepOptions,
	UsagePartitionUpkeepResult,
} from "../db/repository/usage-partitions";
import {
	type BillingLogger,
	createNoopBillingLogger,
	safelyLogError,
	safelyLogInfo,
	safelyLogWarn,
} from "../observability/logger";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";

export interface UsagePartitionUpkeepRepository {
	ensureUsageEventPartitions(
		options?: UsagePartitionUpkeepOptions,
	): Promise<UsagePartitionUpkeepResult>;
}

/** Keeps monthly `usage_events` partitions a year ahead so usage never lands in the default one. */
export class UsagePartitionUpkeepWorker {
	private readonly repository: UsagePartitionUpkeepRepository;
	private readonly logger: BillingLogger;
	private readonly metrics: BillingMetrics;

	constructor({
		repository,
		logger = createNoopBillingLogger(),
		metrics = createNoopBillingMetrics(),
	}: {
		repository: UsagePartitionUpkeepRepository;
		logger?: BillingLogger;
		metrics?: BillingMetrics;
	}) {
		this.repository = repository;
		this.logger = logger;
		this.metrics = metrics;
	}

	async runOnce(): Promise<UsagePartitionUpkeepResult> {
		let result: UsagePartitionUpkeepResult;
		try {
			result = await this.repository.ensureUsageEventPartitions();
		} catch (error) {
			safelyIncrementBillingMetric(this.metrics, "billing_usage_partition_upkeep_runs_total", {
				result: "failed",
			});
			safelyLogError(this.logger, "Usage partition upkeep failed", error, {
				worker: "usage_partition_upkeep",
			});
			throw error;
		}
		safelyIncrementBillingMetric(this.metrics, "billing_usage_partition_upkeep_runs_total", {
			result: result.status,
		});
		const context = { created: result.created, coveredUntil: result.coveredUntil };
		if (result.created.length > 0) safelyLogInfo(this.logger, "Usage partitions created", context);
		if (result.status === "blocked")
			safelyLogWarn(
				this.logger,
				"Usage partition upkeep is blocked: usage_events_default holds rows; see docs/operations.md#usage-partitions",
				context,
			);
		else if (result.status === "forbidden")
			safelyLogWarn(
				this.logger,
				"Usage partition upkeep needs a role that owns usage_events; see docs/operations.md#usage-partitions",
				context,
			);
		else if (result.status === "lock_timeout")
			safelyLogWarn(this.logger, "Usage partition upkeep timed out waiting for a lock", context);
		return result;
	}
}
