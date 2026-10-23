import { describe, expect, it } from "bun:test";
import {
	PLATFORM_RETENTION_JOB_NAME,
	PLATFORM_RETENTION_POLL_INTERVAL_MS,
	platformRetentionJobs,
} from "../../src/composition/platform-retention";
import { type BillingLogger, createPinoBillingLogger } from "../../src/observability/logger";
import type {
	PlatformQuery,
	PlatformQueryExecutor,
} from "../../src/platform/persistence/query-executor";
import { PLATFORM_RETENTION_TABLES } from "../../src/platform/retention";
import { startPollingRuntime } from "../../src/workers/runtime";

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
		if (query.text === "SELECT clock_timestamp() AS now")
			return [{ now: new Date() }] as unknown as readonly Row[];
		this.calls.push(query);
		const table = /(?:retention: |DELETE FROM )(platform_[a-z_]+)/.exec(query.text)?.[1] ?? "";
		const answer = this.answer(table);
		if (answer instanceof Error) throw answer;
		return [{ deleted: Math.min(answer, this.batchSize - 1) }] as unknown as readonly Row[];
	}
}

describe("platform retention job wiring", () => {
	it("forwards the poll interval and bounded sweep sizes", async () => {
		const executor = new ScriptedExecutor(() => 100);
		const [job] = platformRetentionJobs({
			merchantEnabled: true,
			executor,
			logger: new RecordingLogger(),
			pollIntervalMs: 1234,
			options: { batchSize: 3, maxBatchesPerTable: 2 },
		});
		expect(job?.pollIntervalMs).toBe(1234);
		await job?.runOnce();
		expect(executor.calls).toHaveLength((PLATFORM_RETENTION_TABLES.length - 1) * 2);
		for (const call of executor.calls) expect(call.values[1]).toBe(3);
	});

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

	it("constructs a headless connection sweep without touching the database", () => {
		const executor = new ScriptedExecutor(() => 0);

		const jobs = platformRetentionJobs({
			merchantEnabled: false,
			executor,
			logger: new RecordingLogger(),
		});

		expect(jobs).toHaveLength(1);
		expect(executor.calls).toEqual([]);
	});

	it("sweeps every listed table once per run and logs only what it deleted", async () => {
		const logger = new RecordingLogger();
		const executor = new ScriptedExecutor((table) => (table === "platform_rate_limits" ? 7 : 0));
		const [job] = platformRetentionJobs({ merchantEnabled: true, executor, logger });

		await job?.runOnce();

		expect(executor.calls).toHaveLength(PLATFORM_RETENTION_TABLES.length - 1);
		expect(logger.errors).toEqual([]);
		expect(logger.infos).toHaveLength(1);
		expect(logger.infos[0]?.message).toBe("Platform retention sweep deleted expired rows");
		expect(logger.infos[0]?.context).toEqual({
			worker: "platform_retention",
			deleted: 7,
			tables: [
				{ table: "platform_rate_limits", deleted: 7 },
				{ table: "platform_auth_links", deleted: 0 },
				{ table: "platform_idempotency", deleted: 0 },
				{ table: "platform_step_up_grants", deleted: 0 },
				{ table: "platform_mcp_changes", deleted: 0 },
				{ table: "platform_mcp_proposal_admissions", deleted: 0 },
				{ table: "platform_mcp_proposal_days", deleted: 0 },
				{ table: "platform_mcp_authorizations", deleted: 0 },
				{ table: "platform_connection_versions", deleted: 0 },
				{ table: "platform_connection_secrets", deleted: 0 },
				{ table: "platform_connection_operations", deleted: 0 },
				{ table: "platform_connection_oauth_states", deleted: 0 },
				{ table: "platform_stripe_app_events", deleted: 0 },
			],
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
		expect(executor.calls).toHaveLength(PLATFORM_RETENTION_TABLES.length - 1);
	});
});

/**
 * The service's logger drops any context key that looks sensitive (`authorization` is one), so a
 * recording fake cannot show what an operator actually reads. These run through the real logger.
 */
describe("platform retention log lines", () => {
	function capture() {
		const lines: string[] = [];
		const logger = createPinoBillingLogger({
			level: "info",
			destination: { write: (line) => lines.push(line) },
		});
		return { logger, events: () => lines.map((line) => JSON.parse(line)) };
	}

	it("reports the rows deleted from every table, including MCP authorizations", async () => {
		const { logger, events } = capture();
		const counts: Record<string, number> = {
			platform_rate_limits: 11,
			platform_auth_links: 12,
			platform_idempotency: 13,
			platform_step_up_grants: 14,
			platform_mcp_changes: 15,
			platform_mcp_authorizations: 16,
		};
		const executor = new ScriptedExecutor((table) => counts[table] ?? 0);
		const [job] = platformRetentionJobs({ merchantEnabled: true, executor, logger });

		await job?.runOnce();

		const [line] = events();
		expect(line?.msg).toBe("Platform retention sweep deleted expired rows");
		expect(line?.context.worker).toBe("platform_retention");
		expect(line?.context.deleted).toBe(11 + 12 + 13 + 14 + 15 + 16);
		expect(line?.context.tables).toEqual(
			PLATFORM_RETENTION_TABLES.map((table) => ({ table, deleted: counts[table] ?? 0 })),
		);
		expect(line?.context.capped).toEqual([]);
	});

	it("names a capped table and a failed table in the emitted lines", async () => {
		const { logger, events } = capture();
		const executor = new ScriptedExecutor(
			(table) => (table === "platform_mcp_changes" ? new Error("permission denied") : 1_000),
			1_001,
		);
		const [job] = platformRetentionJobs({
			merchantEnabled: true,
			executor,
			logger,
			options: { batchSize: 1_000, maxBatchesPerTable: 1 },
		});

		await job?.runOnce().catch(() => undefined);

		const [info, failure] = events();
		expect(info?.context.capped).toEqual(
			PLATFORM_RETENTION_TABLES.filter(
				(table) => table !== "platform_mcp_changes" && table !== "platform_connection_secrets",
			),
		);
		expect(failure?.msg).toBe("Platform retention sweep failed");
		expect(failure?.context).toEqual({
			worker: "platform_retention",
			table: "platform_mcp_changes",
		});
	});

	it("names the failed table in its own line because the scheduler's line cannot", async () => {
		const { logger, events } = capture();
		const denied = Object.assign(new Error("permission denied for table platform_mcp_changes"), {
			code: "42501",
		});
		const executor = new ScriptedExecutor((table) =>
			table === "platform_mcp_changes" ? denied : 0,
		);
		const [job] = platformRetentionJobs({ merchantEnabled: true, executor, logger });
		if (job === undefined) throw new Error("job missing");
		const timer: { fire?: () => void } = {};
		const runtime = startPollingRuntime({
			name: job.name,
			worker: job,
			pollIntervalMs: job.pollIntervalMs,
			logger,
			timers: {
				setTimeout(callback) {
					timer.fire = callback;
					return 1;
				},
				clearTimeout() {},
			},
		});

		timer.fire?.();
		await runtime.stop();

		const [tableLine, pollLine] = events();
		expect(tableLine?.msg).toBe("Platform retention sweep failed");
		expect(tableLine?.context.table).toBe("platform_mcp_changes");
		expect(pollLine?.msg).toBe("platform_retention worker poll failed");
		expect(pollLine?.context).toEqual({ worker: "platform_retention" });
		expect(pollLine?.err).toEqual({
			type: "DatabaseError",
			message: "Database operation failed",
			sqlState: "42501",
		});
		expect(JSON.stringify(pollLine)).not.toContain("platform_mcp_changes");
	});
});
