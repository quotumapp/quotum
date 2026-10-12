import type { PlatformQueryExecutor } from "./persistence/query-executor";

const DAY_MS = 24 * 60 * 60_000;

/**
 * How long the merchant platform keeps an operational row after it stops mattering, and how much
 * one sweep may delete. `docs/operations.md#merchant-platform-retention` lists the same windows.
 * Every window counts from the instant named in its comment, so a row is removed only once that
 * instant lies more than the window in the past.
 */
export const PLATFORM_RETENTION = {
	/** `platform_rate_limits`: after `reset_at`. An elapsed window restarts its count anyway. */
	rateLimitsMs: 1 * DAY_MS,
	/** `platform_auth_links`: after `expires_at` or `consumed_at`, whichever passed. */
	authLinksMs: 7 * DAY_MS,
	/** `platform_idempotency`: after `created_at`, completed results only. */
	idempotencyMs: 30 * DAY_MS,
	/** `platform_step_up_grants`: after `expires_at` or `consumed_at`, whichever passed. */
	stepUpGrantsMs: 7 * DAY_MS,
	/** `platform_mcp_changes`: after `created_at`, terminal and abandoned proposals only. */
	mcpChangesMs: 30 * DAY_MS,
	/** `platform_mcp_authorizations`: after `revoked_at` or `expires_at`, once no change refers to it. */
	mcpAuthorizationsMs: 30 * DAY_MS,
	/** Rows removed by one statement; each statement is its own short transaction. */
	batchSize: 1_000,
	/** Statements per table in one sweep; a larger backlog continues on the next sweep. */
	maxBatchesPerTable: 25,
} as const;

/** The only tables a sweep touches. Audit events, memberships and credentials are never listed. */
export const PLATFORM_RETENTION_TABLES = [
	"platform_rate_limits",
	"platform_auth_links",
	"platform_idempotency",
	"platform_step_up_grants",
	"platform_mcp_changes",
	"platform_mcp_authorizations",
] as const;

export type PlatformRetentionTable = (typeof PLATFORM_RETENTION_TABLES)[number];

export interface PlatformRetentionResult {
	/** Rows deleted from each table by this sweep. */
	deleted: Record<PlatformRetentionTable, number>;
	/** Tables that used every batch of the sweep, so expired rows may remain for the next one. */
	capped: PlatformRetentionTable[];
	/** Tables whose delete failed. The remaining tables were still swept. */
	failures: Array<{ table: PlatformRetentionTable; error: unknown }>;
}

export interface PlatformRetentionOptions {
	now?: () => Date;
	batchSize?: number;
	maxBatchesPerTable?: number;
}

interface DeletedCount {
	deleted: number;
}

type DeleteBatch = (before: Date, limit: number) => Promise<readonly DeletedCount[]>;

/**
 * Deletes expired operational rows from the platform tables that nothing else prunes. Each batch
 * locks the rows it deletes with `FOR UPDATE SKIP LOCKED` and takes no other lock, so concurrent
 * replicas split the work and a sweep never waits on, or deadlocks with, a request. Proposals are
 * removed before the grants they belong to, because a grant that a proposal still names is kept.
 */
export class PlatformRetentionSweep {
	private readonly now: () => Date;
	private readonly batchSize: number;
	private readonly maxBatches: number;

	constructor(
		private readonly executor: PlatformQueryExecutor,
		options: PlatformRetentionOptions = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.batchSize = positive(options.batchSize ?? PLATFORM_RETENTION.batchSize, "batchSize");
		this.maxBatches = positive(
			options.maxBatchesPerTable ?? PLATFORM_RETENTION.maxBatchesPerTable,
			"maxBatchesPerTable",
		);
	}

	async runOnce(): Promise<PlatformRetentionResult> {
		const now = this.now();
		const result: PlatformRetentionResult = {
			deleted: Object.fromEntries(PLATFORM_RETENTION_TABLES.map((table) => [table, 0])) as Record<
				PlatformRetentionTable,
				number
			>,
			capped: [],
			failures: [],
		};
		for (const step of this.steps()) {
			try {
				const outcome = await this.drain(step.deleteBatch, new Date(now.getTime() - step.windowMs));
				result.deleted[step.table] = outcome.deleted;
				if (outcome.capped) result.capped.push(step.table);
			} catch (error) {
				result.failures.push({ table: step.table, error });
			}
		}
		return result;
	}

	private async drain(
		deleteBatch: DeleteBatch,
		before: Date,
	): Promise<{ deleted: number; capped: boolean }> {
		let deleted = 0;
		for (let batch = 0; batch < this.maxBatches; batch += 1) {
			const [row] = await deleteBatch(before, this.batchSize);
			const count = Number(row?.deleted ?? 0);
			deleted += count;
			if (count < this.batchSize) return { deleted, capped: false };
		}
		return { deleted, capped: true };
	}

	private steps(): Array<{
		table: PlatformRetentionTable;
		windowMs: number;
		deleteBatch: DeleteBatch;
	}> {
		return [
			{
				table: "platform_rate_limits",
				windowMs: PLATFORM_RETENTION.rateLimitsMs,
				deleteBatch: (before, limit) =>
					this.executor.query<DeletedCount>({
						text: `
							WITH removed AS (
								DELETE FROM platform_rate_limits
								WHERE ctid = ANY(ARRAY(
									SELECT r.ctid FROM platform_rate_limits r
									WHERE r.reset_at < $1
									LIMIT $2
									FOR UPDATE OF r SKIP LOCKED
								))
								RETURNING 1
							)
							SELECT count(*)::int AS deleted FROM removed
						`,
						values: [before, limit],
					}),
			},
			{
				table: "platform_auth_links",
				windowMs: PLATFORM_RETENTION.authLinksMs,
				deleteBatch: (before, limit) =>
					this.executor.query<DeletedCount>({
						text: `
							WITH removed AS (
								DELETE FROM platform_auth_links
								WHERE ctid = ANY(ARRAY(
									SELECT l.ctid FROM platform_auth_links l
									WHERE l.expires_at < $1 OR l.consumed_at < $1
									LIMIT $2
									FOR UPDATE OF l SKIP LOCKED
								))
								RETURNING 1
							)
							SELECT count(*)::int AS deleted FROM removed
						`,
						values: [before, limit],
					}),
			},
			{
				table: "platform_idempotency",
				windowMs: PLATFORM_RETENTION.idempotencyMs,
				// A pending claim is a request still in flight, or one a stopped process left behind,
				// and its key must keep answering "in progress"; only a stored response is retired.
				deleteBatch: (before, limit) =>
					this.executor.query<DeletedCount>({
						text: `
							WITH removed AS (
								DELETE FROM platform_idempotency
								WHERE ctid = ANY(ARRAY(
									SELECT i.ctid FROM platform_idempotency i
									WHERE i.created_at < $1
										AND i.result IS NOT NULL
										AND COALESCE(i.result->>'state', '') <> 'pending'
									LIMIT $2
									FOR UPDATE OF i SKIP LOCKED
								))
								RETURNING 1
							)
							SELECT count(*)::int AS deleted FROM removed
						`,
						values: [before, limit],
					}),
			},
			{
				table: "platform_step_up_grants",
				windowMs: PLATFORM_RETENTION.stepUpGrantsMs,
				deleteBatch: (before, limit) =>
					this.executor.query<DeletedCount>({
						text: `
							WITH removed AS (
								DELETE FROM platform_step_up_grants
								WHERE ctid = ANY(ARRAY(
									SELECT g.ctid FROM platform_step_up_grants g
									WHERE g.expires_at < $1 OR g.consumed_at < $1
									LIMIT $2
									FOR UPDATE OF g SKIP LOCKED
								))
								RETURNING 1
							)
							SELECT count(*)::int AS deleted FROM removed
						`,
						values: [before, limit],
					}),
			},
			{
				table: "platform_mcp_changes",
				windowMs: PLATFORM_RETENTION.mcpChangesMs,
				// 'pending' counts once its expiry is past the window: nobody can approve it, but the row
				// only becomes 'expired' when somebody opens it. 'applying' and 'needs_review' are not
				// terminal and stay until an operator or a read resolves them.
				deleteBatch: (before, limit) =>
					this.executor.query<DeletedCount>({
						text: `
							WITH removed AS (
								DELETE FROM platform_mcp_changes
								WHERE ctid = ANY(ARRAY(
									SELECT c.ctid FROM platform_mcp_changes c
									WHERE c.created_at < $1
										AND (
											c.status IN ('completed','rejected','cancelled','expired','stale','failed')
											OR (c.status = 'pending' AND c.expires_at < $1)
										)
									LIMIT $2
									FOR UPDATE OF c SKIP LOCKED
								))
								RETURNING 1
							)
							SELECT count(*)::int AS deleted FROM removed
						`,
						values: [before, limit],
					}),
			},
			{
				table: "platform_mcp_authorizations",
				windowMs: PLATFORM_RETENTION.mcpAuthorizationsMs,
				// A proposal references its grant without a cascade, so a grant that still has one stays.
				deleteBatch: (before, limit) =>
					this.executor.query<DeletedCount>({
						text: `
							WITH removed AS (
								DELETE FROM platform_mcp_authorizations
								WHERE ctid = ANY(ARRAY(
									SELECT a.ctid FROM platform_mcp_authorizations a
									WHERE (a.expires_at < $1 OR a.revoked_at < $1)
										AND NOT EXISTS (
											SELECT 1 FROM platform_mcp_changes c WHERE c.authorization_id = a.id
										)
									LIMIT $2
									FOR UPDATE OF a SKIP LOCKED
								))
								RETURNING 1
							)
							SELECT count(*)::int AS deleted FROM removed
						`,
						values: [before, limit],
					}),
			},
		];
	}
}

function positive(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`Platform retention ${name} must be a positive integer`);
	return value;
}
