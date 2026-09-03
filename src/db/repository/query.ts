import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import type { QueryExecutor } from "./types";

export async function executeRows<T = Record<string, unknown>>(
	executor: QueryExecutor,
	query: DrizzleSQL,
): Promise<T[]> {
	return (await executor.execute<T>(query)) as T[];
}

export async function executeOne<T = Record<string, unknown>>(
	executor: QueryExecutor,
	query: DrizzleSQL,
): Promise<T | null> {
	const rows = await executeRows<T>(executor, query);
	return rows[0] ?? null;
}

export async function assertUpdated(
	executor: QueryExecutor,
	query: DrizzleSQL,
	errorMessage: string,
): Promise<void> {
	const row = await executeOne(executor, query);
	if (row === null) {
		throw new Error(errorMessage);
	}
}

export function jsonb(value: unknown): DrizzleSQL {
	return drizzleSql`${JSON.stringify(value)}::jsonb`;
}
