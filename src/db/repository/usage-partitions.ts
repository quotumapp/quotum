import { sql as drizzleSql } from "drizzle-orm";
import { sqlstateOf } from "../postgres-errors";
import { executeRows } from "./query";
import type { QueryExecutor, TransactionalQueryExecutor } from "./types";

/**
 * `current` and `created` need nothing. `locked` means another process holds the upkeep (or
 * the migration runner) lock. `lock_timeout` retries on the next run. `blocked` (rows in the
 * default partition) and `forbidden` (a role that does not own `usage_events`) need an operator.
 */
export type UsagePartitionUpkeepStatus =
	| "current"
	| "created"
	| "locked"
	| "lock_timeout"
	| "blocked"
	| "forbidden";

export interface UsagePartitionUpkeepResult {
	status: UsagePartitionUpkeepStatus;
	/** Partitions created by this run, oldest first. */
	created: string[];
	/** Exclusive upper bound of the last monthly partition after this run, or null if none. */
	coveredUntil: string | null;
}

export interface UsagePartitionUpkeepOptions {
	/** Keep partitions until at least this many months after the database's current time. */
	horizonMonths?: number;
	/** At most this many partitions per run; each is its own short transaction. */
	maxCreates?: number;
}

export interface UsagePartition {
	name: string;
	from: Date;
	to: Date;
}

/**
 * The partition after `coveredUntil`: the rest of that UTC month, or the whole next month when
 * `coveredUntil` is a UTC month boundary. Migration 003 created its partitions in the session
 * time zone of the migration run, so the first one after them may be a short bridge.
 */
export function nextUsagePartition(coveredUntil: Date): UsagePartition {
	const year = coveredUntil.getUTCFullYear();
	const month = coveredUntil.getUTCMonth();
	const aligned = coveredUntil.getTime() === Date.UTC(year, month, 1);
	const to = new Date(Date.UTC(year, month + 1, 1));
	const pad = (value: number) => String(value).padStart(2, "0");
	const base = `usage_events_${year}_${pad(month + 1)}`;
	const name = aligned
		? base
		: `${base}_${pad(coveredUntil.getUTCDate())}t${pad(coveredUntil.getUTCHours())}${pad(coveredUntil.getUTCMinutes())}`;
	return { name, from: coveredUntil, to };
}

// src/migrate.ts holds this session lock while it applies migrations; upkeep waits for it.
const migrationAdvisoryLockNamespace = 760_911;
const migrationAdvisoryLockKey = 520_384_001;

/** Creates missing monthly `usage_events` partitions ahead of time; see docs/operations.md. */
export async function ensureUsageEventPartitions(
	database: TransactionalQueryExecutor,
	{ horizonMonths = 12, maxCreates = 3 }: UsagePartitionUpkeepOptions = {},
): Promise<UsagePartitionUpkeepResult> {
	if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 120)
		throw new Error("Usage partition horizon must be between 1 and 120 months");
	if (!Number.isInteger(maxCreates) || maxCreates < 1 || maxCreates > 120)
		throw new Error("Usage partition creations per run must be between 1 and 120");
	const created: string[] = [];
	let coveredUntil: string | null = null;
	for (let attempt = 0; attempt < maxCreates; attempt += 1) {
		let step: StepResult;
		try {
			step = await database.transaction((tx) => createNextPartition(tx, horizonMonths));
		} catch (error) {
			const status = failureStatus(error);
			if (status === null) throw error;
			return { status, created, coveredUntil };
		}
		// A locked step reads no bound; after a creation it only means another process took over.
		if (step.coveredUntil !== null) coveredUntil = step.coveredUntil;
		if ((step.status === "current" || step.status === "locked") && created.length > 0)
			return { status: "created", created, coveredUntil };
		if (step.status !== "created") return { status: step.status, created, coveredUntil };
		created.push(step.name);
	}
	return { status: "created", created, coveredUntil };
}

type StepResult =
	| { status: "created"; name: string; coveredUntil: string }
	| { status: "current" | "locked" | "blocked"; coveredUntil: string | null };

async function createNextPartition(tx: QueryExecutor, horizonMonths: number): Promise<StepResult> {
	// Bounds are read and written as UTC ISO text; lock_timeout keeps a waiting DDL from stalling
	// the metering writes queued behind it.
	await tx.execute(drizzleSql`
		SELECT
			set_config('lock_timeout', '1s', true),
			set_config('statement_timeout', '15s', true),
			set_config('TimeZone', 'UTC', true),
			set_config('DateStyle', 'ISO, YMD', true)
	`);
	const [lock] = await executeRows<{ acquired: boolean }>(
		tx,
		drizzleSql`
			SELECT
				pg_try_advisory_xact_lock(hashtextextended('quotum:usage_events:partition-upkeep', 0))
				AND pg_try_advisory_xact_lock_shared(
					${migrationAdvisoryLockNamespace}::integer,
					${migrationAdvisoryLockKey}::integer
				) AS acquired
		`,
	);
	if (lock?.acquired !== true) return { status: "locked", coveredUntil: null };
	const [coverage] = await executeRows<{ covered_until: string | Date | null; ready: boolean }>(
		tx,
		drizzleSql`
			SELECT
				max(bounds.upper_bound) AS covered_until,
				coalesce(
					max(bounds.upper_bound) > now() + make_interval(months => ${horizonMonths}::integer),
					false
				) AS ready
			FROM pg_inherits inherits
			JOIN pg_class child ON child.oid = inherits.inhrelid
			CROSS JOIN LATERAL (
				SELECT (
					regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO [(]''([^'']+)''[)]')
				)[1]::timestamptz AS upper_bound
			) bounds
			WHERE inherits.inhparent = 'usage_events'::regclass
		`,
	);
	const coveredUntil =
		coverage?.covered_until === null || coverage?.covered_until === undefined
			? null
			: new Date(coverage.covered_until).toISOString();
	if (coverage?.ready === true) return { status: "current", coveredUntil };
	if (coveredUntil === null)
		throw new Error("usage_events has no monthly partitions; apply migrations first");
	// Creating a partition scans the default partition under a table lock and fails when it holds
	// rows in the new range, so only an empty default partition is safe to extend automatically.
	const [defaultRows] = await executeRows<{ occupied: boolean }>(
		tx,
		drizzleSql`SELECT EXISTS (SELECT 1 FROM usage_events_default) AS occupied`,
	);
	if (defaultRows?.occupied !== false) return { status: "blocked", coveredUntil };
	const partition = nextUsagePartition(new Date(coveredUntil));
	await tx.execute(drizzleSql.raw(createPartitionStatement(partition)));
	return { status: "created", name: partition.name, coveredUntil: partition.to.toISOString() };
}

const partitionNamePattern = /^usage_events_\d{4}_\d{2}(?:_\d{2}t\d{4})?$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function createPartitionStatement(partition: UsagePartition): string {
	const from = partition.from.toISOString();
	const to = partition.to.toISOString();
	if (
		!partitionNamePattern.test(partition.name) ||
		!isoInstantPattern.test(from) ||
		!isoInstantPattern.test(to) ||
		partition.to <= partition.from
	)
		throw new Error("Refusing to create an invalid usage partition");
	return `CREATE TABLE ${partition.name} PARTITION OF usage_events FOR VALUES FROM ('${from}') TO ('${to}')`;
}

function failureStatus(error: unknown): "lock_timeout" | "blocked" | "forbidden" | null {
	switch (sqlstateOf(error)) {
		case "55P03":
			return "lock_timeout";
		case "23514":
			return "blocked";
		case "42501":
			return "forbidden";
		default:
			return null;
	}
}
