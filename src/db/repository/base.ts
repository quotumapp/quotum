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

function isPostgresDeadlock(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "40P01"
	);
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
