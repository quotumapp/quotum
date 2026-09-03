import { describe, expect, it } from "bun:test";
import type { MeteringMaintenanceResult } from "../../src/billing/metering";
import type { BillingLogger } from "../../src/observability/logger";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { MeteringMaintenanceWorker } from "../../src/workers/metering-maintenance";

const maintenanceResult: MeteringMaintenanceResult = {
	expiredReservations: 2,
	rolledOverAllocations: 1,
	closedPeriods: 3,
	deletedClientClaims: 4,
	deletedWorkerClaims: 5,
	expiredCatalogDrafts: 1,
	deletedRawUsageEvents: 6,
};

function recordingLogger() {
	const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const errors: Array<{ message: string; error: unknown; context?: Record<string, unknown> }> = [];
	const logger: BillingLogger = {
		info(message, context) {
			infos.push({ message, context });
		},
		warn() {},
		error(message, error, context) {
			errors.push({ message, error, context });
		},
	};
	return { logger, infos, errors };
}

describe("MeteringMaintenanceWorker", () => {
	it("runs bounded maintenance and records success observability", async () => {
		const calls: number[] = [];
		const metrics = createInMemoryBillingMetrics();
		const { logger, infos } = recordingLogger();
		const worker = new MeteringMaintenanceWorker({
			batchSize: 75,
			metrics,
			logger,
			repository: {
				runMeteringMaintenance(limit) {
					calls.push(limit);
					return Promise.resolve(maintenanceResult);
				},
			},
		});

		await expect(worker.runOnce()).resolves.toEqual(maintenanceResult);
		expect(calls).toEqual([75]);
		expect(infos).toEqual([
			{ message: "Metering maintenance run completed", context: { ...maintenanceResult } },
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_metering_maintenance_runs_total{result="succeeded"} 1',
		);
	});

	it("records failures without swallowing the repository error", async () => {
		const failure = new Error("database unavailable");
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = recordingLogger();
		const worker = new MeteringMaintenanceWorker({
			metrics,
			logger,
			repository: {
				runMeteringMaintenance() {
					return Promise.reject(failure);
				},
			},
		});

		await expect(worker.runOnce()).rejects.toBe(failure);
		expect(errors).toEqual([
			{
				message: "Metering maintenance run failed",
				error: failure,
				context: { worker: "metering_maintenance" },
			},
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_metering_maintenance_runs_total{result="failed"} 1',
		);
	});
});
