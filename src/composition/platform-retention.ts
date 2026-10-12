import { type BillingLogger, safelyLogError, safelyLogInfo } from "../observability/logger";
import type { PlatformQueryExecutor } from "../platform/persistence/query-executor";
import { type PlatformRetentionOptions, PlatformRetentionSweep } from "../platform/retention";
import type { QuotumScheduledJob } from "./runtime-lifecycle";

export const PLATFORM_RETENTION_JOB_NAME = "platform_retention";

/**
 * The windows are days long, so the sweep only has to keep up with how fast rows are created. It
 * shares the usage partition upkeep's cadence so a process that restarts often still reaches it.
 */
export const PLATFORM_RETENTION_POLL_INTERVAL_MS = 15 * 60_000;

/**
 * The merchant platform's retention sweep as one more scheduled job. Only a runtime that serves the
 * merchant platform schedules it: a headless process writes none of these tables.
 */
export function platformRetentionJobs(input: {
	merchantEnabled: boolean;
	executor: PlatformQueryExecutor;
	logger: BillingLogger;
	options?: PlatformRetentionOptions;
}): QuotumScheduledJob[] {
	return input.merchantEnabled ? [createPlatformRetentionJob(input)] : [];
}

export function createPlatformRetentionJob(input: {
	executor: PlatformQueryExecutor;
	logger: BillingLogger;
	options?: PlatformRetentionOptions;
}): QuotumScheduledJob {
	const sweep = new PlatformRetentionSweep(input.executor, input.options);
	return {
		name: PLATFORM_RETENTION_JOB_NAME,
		pollIntervalMs: PLATFORM_RETENTION_POLL_INTERVAL_MS,
		async runOnce() {
			const result = await sweep.runOnce();
			const total = Object.values(result.deleted).reduce((sum, count) => sum + count, 0);
			if (total > 0)
				safelyLogInfo(input.logger, "Platform retention sweep deleted expired rows", {
					worker: PLATFORM_RETENTION_JOB_NAME,
					deleted: result.deleted,
					capped: result.capped,
				});
			for (const failure of result.failures)
				safelyLogError(input.logger, "Platform retention sweep failed", failure.error, {
					worker: PLATFORM_RETENTION_JOB_NAME,
					table: failure.table,
				});
			if (result.failures.length > 0)
				throw new AggregateError(
					result.failures.map((failure) => failure.error),
					"Platform retention sweep failed",
				);
			return result;
		},
	};
}
