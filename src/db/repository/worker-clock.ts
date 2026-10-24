import { type SQL, sql } from "drizzle-orm";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

/** A relative retry is stamped only when its fenced persistence transition runs. */
export function workerRetryAtSql(delayMs: number | null): SQL {
	if (delayMs === null) return sql`NULL::timestamptz`;
	if (!Number.isSafeInteger(delayMs) || delayMs < 0)
		throw new Error("Worker retry delay must be a nonnegative integer");
	return sql`clock_timestamp() + ${delayMs} * interval '1 millisecond'`;
}

export function workerStaleBeforeSql(ageMs: number): SQL {
	if (!Number.isSafeInteger(ageMs) || ageMs <= 0)
		throw new Error("Worker stale age must be a positive integer");
	return sql`statement_timestamp() - ${ageMs} * interval '1 millisecond'`;
}

export async function readWorkerClock(executor: QueryExecutor): Promise<Date> {
	const row = await executeOne<{ worker_now: string | Date }>(
		executor,
		sql`SELECT clock_timestamp() AS worker_now`,
	);
	if (row === null) throw new Error("Database worker clock unavailable");
	return new Date(row.worker_now);
}
