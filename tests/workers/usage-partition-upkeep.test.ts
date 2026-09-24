import { describe, expect, it } from "bun:test";
import type { UsagePartitionUpkeepResult } from "../../src/db/repository/usage-partitions";
import type { BillingLogger } from "../../src/observability/logger";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { UsagePartitionUpkeepWorker } from "../../src/workers/usage-partition-upkeep";

function recordingLogger() {
	const lines: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
	const logger: BillingLogger = {
		info: (message, context) => lines.push({ level: "info", message, context }),
		warn: (message, context) => lines.push({ level: "warn", message, context }),
		error: (message, _error, context) => lines.push({ level: "error", message, context }),
	};
	return { logger, lines };
}

function workerFor(result: UsagePartitionUpkeepResult | Error) {
	const metrics = createInMemoryBillingMetrics();
	const { logger, lines } = recordingLogger();
	const worker = new UsagePartitionUpkeepWorker({
		metrics,
		logger,
		repository: {
			ensureUsageEventPartitions: () =>
				result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
		},
	});
	return { worker, metrics, lines };
}

describe("UsagePartitionUpkeepWorker", () => {
	it("logs created partitions and counts the outcome", async () => {
		const result: UsagePartitionUpkeepResult = {
			status: "created",
			created: ["usage_events_2027_09"],
			coveredUntil: "2027-10-01T00:00:00.000Z",
		};
		const { worker, metrics, lines } = workerFor(result);
		await expect(worker.runOnce()).resolves.toEqual(result);
		expect(lines).toEqual([
			{
				level: "info",
				message: "Usage partitions created",
				context: { created: ["usage_events_2027_09"], coveredUntil: "2027-10-01T00:00:00.000Z" },
			},
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_usage_partition_upkeep_runs_total{result="created"} 1',
		);
	});

	it("stays quiet when coverage is current or another replica holds the lock", async () => {
		for (const status of ["current", "locked"] as const) {
			const { worker, lines, metrics } = workerFor({ status, created: [], coveredUntil: null });
			await worker.runOnce();
			expect(lines).toEqual([]);
			expect(metrics.renderPrometheus()).toContain(
				`billing_usage_partition_upkeep_runs_total{result="${status}"} 1`,
			);
		}
	});

	it("warns with the operator runbook when upkeep cannot proceed", async () => {
		for (const status of ["blocked", "forbidden", "lock_timeout"] as const) {
			const { worker, lines } = workerFor({ status, created: [], coveredUntil: null });
			await worker.runOnce();
			expect(lines).toHaveLength(1);
			expect(lines[0]?.level).toBe("warn");
		}
		const blocked = workerFor({ status: "blocked", created: [], coveredUntil: null });
		await blocked.worker.runOnce();
		expect(blocked.lines[0]?.message).toContain("docs/operations.md#usage-partitions");
	});

	it("records failures without swallowing them", async () => {
		const failure = new Error("database unavailable");
		const { worker, metrics, lines } = workerFor(failure);
		await expect(worker.runOnce()).rejects.toBe(failure);
		expect(lines).toEqual([
			{
				level: "error",
				message: "Usage partition upkeep failed",
				context: { worker: "usage_partition_upkeep" },
			},
		]);
		expect(metrics.renderPrometheus()).toContain(
			'billing_usage_partition_upkeep_runs_total{result="failed"} 1',
		);
	});
});
