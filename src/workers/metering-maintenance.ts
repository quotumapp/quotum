import type { MeteringMaintenanceResult } from "../billing/metering";
import {
	type BillingLogger,
	createNoopBillingLogger,
	safelyLogError,
	safelyLogInfo,
} from "../observability/logger";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";

export interface MeteringMaintenanceRepository {
	runMeteringMaintenance(limit: number): Promise<MeteringMaintenanceResult>;
}

export class MeteringMaintenanceWorker {
	private readonly repository: MeteringMaintenanceRepository;
	private readonly batchSize: number;
	private readonly logger: BillingLogger;
	private readonly metrics: BillingMetrics;

	constructor({
		repository,
		batchSize = 250,
		logger = createNoopBillingLogger(),
		metrics = createNoopBillingMetrics(),
	}: {
		repository: MeteringMaintenanceRepository;
		batchSize?: number;
		logger?: BillingLogger;
		metrics?: BillingMetrics;
	}) {
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
			throw new Error("Metering maintenance batch size must be between 1 and 1000");
		}
		this.repository = repository;
		this.batchSize = batchSize;
		this.logger = logger;
		this.metrics = metrics;
	}

	async runOnce(): Promise<MeteringMaintenanceResult> {
		try {
			const result = await this.repository.runMeteringMaintenance(this.batchSize);
			safelyIncrementBillingMetric(this.metrics, "billing_metering_maintenance_runs_total", {
				result: "succeeded",
			});
			safelyLogInfo(this.logger, "Metering maintenance run completed", { ...result });
			return result;
		} catch (error) {
			safelyIncrementBillingMetric(this.metrics, "billing_metering_maintenance_runs_total", {
				result: "failed",
			});
			safelyLogError(this.logger, "Metering maintenance run failed", error, {
				worker: "metering_maintenance",
			});
			throw error;
		}
	}
}
