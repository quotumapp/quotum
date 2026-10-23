import { describe, expect, it } from "bun:test";
import type {
	PlatformQuery,
	PlatformQueryExecutor,
} from "../../src/platform/persistence/query-executor";
import {
	PLATFORM_RETENTION,
	PLATFORM_RETENTION_TABLES,
	PlatformRetentionSweep,
} from "../../src/platform/retention";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-10-01T12:00:00.000Z");

/** Answers each delete with the count `reply` returns, or fails it with the error it returns. */
class RecordingExecutor implements PlatformQueryExecutor {
	readonly calls: PlatformQuery[] = [];

	constructor(private readonly reply: (table: string, call: number) => number | Error = () => 0) {}

	async query<Row>(query: PlatformQuery): Promise<readonly Row[]> {
		this.calls.push(query);
		const table = tableOf(query);
		const call = this.calls.filter((candidate) => tableOf(candidate) === table).length;
		const answer = this.reply(table, call);
		if (answer instanceof Error) throw answer;
		return [{ deleted: answer }] as unknown as readonly Row[];
	}
}

function tableOf(query: PlatformQuery): string {
	const match = /(?:retention: |DELETE FROM )(platform_[a-z_]+)/.exec(query.text);
	if (!match?.[1]) throw new Error(`Not a platform delete: ${query.text}`);
	return match[1];
}

function sweep(executor: PlatformQueryExecutor, options = {}) {
	return new PlatformRetentionSweep(executor, { now: () => NOW, ...options });
}

describe("platform retention windows", () => {
	it("pins the documented windows and batch bounds", () => {
		expect(PLATFORM_RETENTION).toEqual({
			rateLimitsMs: 1 * DAY,
			connectionDraftsMs: 7 * DAY,
			connectionOauthMs: 7 * DAY,
			connectionOperationsMs: 30 * DAY,
			stripeAppEventsMs: 30 * DAY,
			authLinksMs: 7 * DAY,
			idempotencyMs: 30 * DAY,
			stepUpGrantsMs: 7 * DAY,
			mcpChangesMs: 30 * DAY,
			mcpAuthorizationsMs: 30 * DAY,
			batchSize: 1_000,
			maxBatchesPerTable: 25,
		});
	});

	it("measures each table from the sweep clock", async () => {
		const executor = new RecordingExecutor();

		await sweep(executor).runOnce();

		const cutoffs = Object.fromEntries(
			executor.calls.map((call) => [tableOf(call), (call.values[0] as Date).getTime()]),
		);
		const expected = (windowMs: number) => NOW.getTime() - windowMs;
		expect(cutoffs).toEqual({
			platform_rate_limits: expected(1 * DAY),
			platform_connection_versions: expected(7 * DAY),
			platform_connection_operations: expected(30 * DAY),
			platform_connection_oauth_states: expected(7 * DAY),
			platform_stripe_app_events: expected(30 * DAY),

			platform_mcp_proposal_admissions: NOW.getTime(),
			platform_mcp_proposal_days: expected(30 * DAY),
			platform_auth_links: expected(7 * DAY),
			platform_idempotency: expected(30 * DAY),
			platform_step_up_grants: expected(7 * DAY),
			platform_mcp_changes: expected(30 * DAY),
			platform_mcp_authorizations: expected(30 * DAY),
		});
		for (const call of executor.calls) expect(call.values[1]).toBe(PLATFORM_RETENTION.batchSize);
	});
});

describe("platform retention statements", () => {
	it("touch only the six listed tables, each bounded and non-blocking", async () => {
		const executor = new RecordingExecutor();

		await sweep(executor).runOnce();

		expect(executor.calls.map(tableOf)).toEqual(
			PLATFORM_RETENTION_TABLES.filter((table) => table !== "platform_connection_secrets"),
		);
		for (const call of executor.calls) {
			const references = [...call.text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map(
				(match) => match[1],
			);
			for (const reference of references)
				expect([
					...PLATFORM_RETENTION_TABLES,
					"platform_connections",
					"candidates",
					"removed_secrets",
					"removed",
				]).toContain(reference ?? "");
			expect(call.text).toContain("LIMIT $2");
			expect(call.text).toContain("FOR UPDATE");
			expect(call.text).toContain("SKIP LOCKED");
			expect(call.text).not.toMatch(/\b(?:UPDATE\s+platform_|TRUNCATE|DROP)\b/i);
		}
	});

	it("sweep proposals before the grants they belong to", async () => {
		const executor = new RecordingExecutor();

		await sweep(executor).runOnce();

		const order = executor.calls.map(tableOf);
		expect(order.indexOf("platform_mcp_changes")).toBeLessThan(
			order.indexOf("platform_mcp_authorizations"),
		);
		const authorizations = executor.calls.find(
			(call) => tableOf(call) === "platform_mcp_authorizations",
		);
		expect(authorizations?.text).toContain("NOT EXISTS");
		expect(authorizations?.text).toContain("platform_mcp_changes");
	});

	it("keep pending idempotency claims and unresolved proposals", async () => {
		const executor = new RecordingExecutor();

		await sweep(executor).runOnce();

		const idempotency = executor.calls.find((call) => tableOf(call) === "platform_idempotency");
		expect(idempotency?.text).toContain("i.result IS NOT NULL");
		expect(idempotency?.text).toContain("COALESCE(i.result->>'state', '') <> 'pending'");
		const changes = executor.calls.find((call) => tableOf(call) === "platform_mcp_changes");
		expect(changes?.text).toContain(
			"c.status IN ('completed','rejected','cancelled','expired','stale','failed')",
		);
		expect(changes?.text).toContain("c.status = 'pending' AND c.expires_at < $1");
		expect(changes?.text).not.toContain("applying");
		expect(changes?.text).not.toContain("needs_review");
	});
});

describe("platform retention batching", () => {
	it("continues until a batch comes back short", async () => {
		const executor = new RecordingExecutor((table, call) =>
			table === "platform_rate_limits" ? (call < 3 ? 10 : 4) : 0,
		);

		const result = await sweep(executor, { batchSize: 10 }).runOnce();

		expect(result.deleted.platform_rate_limits).toBe(24);
		expect(result.capped).toEqual([]);
		expect(executor.calls.filter((call) => tableOf(call) === "platform_rate_limits")).toHaveLength(
			3,
		);
		expect(executor.calls.filter((call) => tableOf(call) === "platform_auth_links")).toHaveLength(
			1,
		);
	});

	it("stops at the batch cap and reports the table as capped", async () => {
		const executor = new RecordingExecutor((table) => (table === "platform_auth_links" ? 5 : 0));

		const result = await sweep(executor, { batchSize: 5, maxBatchesPerTable: 3 }).runOnce();

		expect(result.deleted.platform_auth_links).toBe(15);
		expect(result.capped).toEqual(["platform_auth_links"]);
		expect(executor.calls.filter((call) => tableOf(call) === "platform_auth_links")).toHaveLength(
			3,
		);
	});

	it("keeps sweeping the other tables when one fails and reports the failure", async () => {
		const failure = new Error("permission denied");
		const executor = new RecordingExecutor((table) =>
			table === "platform_rate_limits" ? failure : table === "platform_mcp_changes" ? 2 : 0,
		);

		const result = await sweep(executor).runOnce();

		expect(result.failures).toEqual([{ table: "platform_rate_limits", error: failure }]);
		expect(result.deleted.platform_rate_limits).toBe(0);
		expect(result.deleted.platform_mcp_changes).toBe(2);
		expect(executor.calls.map(tableOf)).toEqual(
			PLATFORM_RETENTION_TABLES.filter((table) => table !== "platform_connection_secrets"),
		);
	});

	it("rejects batch bounds that could not make progress", () => {
		const executor = new RecordingExecutor();
		expect(() => sweep(executor, { batchSize: 0 })).toThrow("batchSize");
		expect(() => sweep(executor, { maxBatchesPerTable: 1.5 })).toThrow("maxBatchesPerTable");
	});
});
