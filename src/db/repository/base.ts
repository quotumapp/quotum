import type { QueryExecutor, TransactionalQueryExecutor } from "./types";

export abstract class RepositoryModule {
	constructor(protected readonly database: TransactionalQueryExecutor) {}

	protected async transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await this.database.transaction((tx) => callback(tx));
			} catch (error) {
				if (!isPostgresDeadlock(error) || attempt >= 3) {
					throw error;
				}
				await delay(attempt * 10);
			}
		}
	}
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Reads the PostgreSQL SQLSTATE off a thrown error. Drizzle wraps driver errors in
 * `DrizzleQueryError` with the original error on `cause`, and Bun's SQL driver reports the
 * SQLSTATE on `errno` while its own `code` is a driver name like `ERR_POSTGRES_SERVER_ERROR`,
 * so the cause chain has to be walked and both fields checked.
 */
export function sqlstateOf(error: unknown): string | null {
	const visited = new Set<object>();
	let current: unknown = error;
	for (let depth = 0; depth < 8; depth += 1) {
		if (typeof current !== "object" || current === null || visited.has(current)) {
			return null;
		}
		visited.add(current);
		const link = current as { errno?: unknown; code?: unknown; cause?: unknown };
		if (typeof link.errno === "string" && SQLSTATE_PATTERN.test(link.errno)) {
			return link.errno;
		}
		if (typeof link.code === "string" && SQLSTATE_PATTERN.test(link.code)) {
			return link.code;
		}
		current = link.cause;
	}
	return null;
}

function isPostgresDeadlock(error: unknown): boolean {
	return sqlstateOf(error) === "40P01";
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
