import { describe, expect, it } from "bun:test";
import {
	PLATFORM_RETENTION_JOB_NAME,
	PLATFORM_RETENTION_POLL_INTERVAL_MS,
	platformRetentionJobs,
} from "../../src/composition/platform-retention";
import type { BillingLogger } from "../../src/observability/logger";
import type {
	PlatformQuery,
	PlatformQueryExecutor,
} from "../../src/platform/persistence/query-executor";
import { PLATFORM_RETENTION_TABLES } from "../../src/platform/retention";

class RecordingLogger implements BillingLogger {
	readonly infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
	readonly errors: Array<{ message: string; error: unknown; context?: Record<string, unknown> }> =
		[];
	info(message: string, context?: Record<string, unknown>) {
		this.infos.push({ message, context });
	}
	warn() {}
	error(message: string, error: unknown, context?: Record<string, unknown>) {
		this.errors.push({ message, error, context });
	}
}

/** Reports `deleted` rows for the first statement of each sweep and none after it. */
class ScriptedExecutor implements PlatformQueryExecutor {
	readonly calls: PlatformQuery[] = [];
	constructor(
		private readonly answer: (table: string) => number | Error,
		private readonly batchSize = 1_000,
	) {}
	async query<Row>(query: PlatformQuery): Promise<readonly Row[]> {
		this.calls.push(query);
		const table = /DELETE FROM (platform_[a-z_]+)/.exec(query.text)?.[1] ?? "";
		const answer = this.answer(table);
		if (answer instanceof Error) throw answer;
		return [{ deleted: Math.min(answer, this.batchSize - 1) }] as unknown as readonly Row[];
	}
}

describe("platform retention job wiring", () => {
	it("schedules one sweep when the merchant platform is enabled", () => {
		const jobs = platformRetentionJobs({
			merchantEnabled: true,
			executor: new ScriptedExecutor(() => 0),
			logger: new RecordingLogger(),
		});

		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.name).toBe(PLATFORM_RETENTION_JOB_NAME);
		expect(PLATFORM_RETENTION_JOB_NAME).toBe("platform_retention");
		expect(jobs[0]?.pollIntervalMs).toBe(PLATFORM_RETENTION_POLL_INTERVAL_MS);
		expect(PLATFORM_RETENTION_POLL_INTERVAL_MS).toBe(15 * 60_000);
	});

	it("schedules nothing for a headless process and never touches the database", () => {
		const executor = new ScriptedExecutor(() => 0);

		const jobs = platformRetentionJobs({
			merchantEnabled: false,
			executor,
			logger: new RecordingLogger(),
		});

		expect(jobs).toEqual([]);
		expect(executor.calls).toEqual([]);
	});

	it("sweeps every listed table once per run and logs only what it deleted", async () => {
		const logger = new RecordingLogger();
		const executor = new ScriptedExecutor((table) => (table === "platform_rate_limits" ? 7 : 0));
		const [job] = platformRetentionJobs({ merchantEnabled: true, executor, logger });

		await job?.runOnce();

		expect(executor.calls).toHaveLength(PLATFORM_RETENTION_TABLES.length);
		expect(logger.errors).toEqual([]);
		expect(logger.infos).toHaveLength(1);
		expect(logger.infos[0]?.message).toBe("Platform retention sweep deleted expired rows");
		expect(logger.infos[0]?.context).toMatchObject({
			worker: "platform_retention",
			deleted: { platform_rate_limits: 7, platform_mcp_changes: 0 },
			capped: [],
		});
	});

	it("stays quiet when nothing expired", async () => {
		const logger = new RecordingLogger();
		const [job] = platformRetentionJobs({
			merchantEnabled: true,
			executor: new ScriptedExecutor(() => 0),
			logger,
		});

		await job?.runOnce();

		expect(logger.infos).toEqual([]);
		expect(logger.errors).toEqual([]);
	});

	it("logs each failed table with its name and rejects so a scheduler sees the failure", async () => {
		const logger = new RecordingLogger();
		const failure = new Error("permission denied");
		const executor = new ScriptedExecutor((table) =>
			table === "platform_mcp_authorizations" ? failure : 0,
		);
		const [job] = platformRetentionJobs({ merchantEnabled: true, executor, logger });

		const outcome = await job?.runOnce().then(
			() => null,
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(AggregateError);
		expect((outcome as AggregateError).errors).toEqual([failure]);
		expect(logger.errors).toHaveLength(1);
		expect(logger.errors[0]?.context).toEqual({
			worker: "platform_retention",
			table: "platform_mcp_authorizations",
		});
		expect(logger.errors[0]?.error).toBe(failure);
		expect(executor.calls).toHaveLength(PLATFORM_RETENTION_TABLES.length);
	});
});
