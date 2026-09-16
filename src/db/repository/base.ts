import { sqlstateOf } from "../postgres-errors";
import type { QueryExecutor, TransactionalQueryExecutor } from "./types";

export abstract class RepositoryModule {
	constructor(protected readonly database: TransactionalQueryExecutor) {}

	protected async transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
		return await withDeadlockRetry(() => this.database.transaction((tx) => callback(tx)));
	}
}

/**
 * Runs a whole transaction again when PostgreSQL aborts it as a deadlock loser (40P01). `run`
 * must open its own transaction and keep every side effect inside it, so a re-run starts clean.
 */
export async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await run();
		} catch (error) {
			if (sqlstateOf(error) !== "40P01" || attempt >= 3) {
				throw error;
			}
			await delay(attempt * 10);
		}
	}
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
