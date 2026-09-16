import { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import type { BillingEnv } from "../env";
import { loadEnv } from "../env";
import { sqlstateOf } from "./postgres-errors";
import * as schema from "./schema";

export type BillingSchema = typeof schema;
export type BillingDatabase = BunSQLDatabase<BillingSchema>;

export interface BillingDatabaseConnection {
	sql: SQL;
	db: BillingDatabase;
}

export interface PostgresHealthSnapshot {
	healthy: boolean;
	checkedAt?: string;
	error?: string;
}

const postgresStatementTimeoutMs = 30_000;
const postgresIdleInTransactionSessionTimeoutMs = 30_000;

export function createBillingDatabaseConnection(
	env: Pick<BillingEnv, "postgresUri"> & Partial<Pick<BillingEnv, "postgresPreparedStatements">>,
) {
	const sql = new SQL(env.postgresUri, {
		max: 20,
		idleTimeout: 60,
		maxLifetime: 0,
		// Named prepared statements let the driver pipeline the independent statements the
		// metering path issues together. Disable only behind a transaction-mode pooler that
		// cannot hold them.
		prepare: env.postgresPreparedStatements ?? true,
		connection: {
			statement_timeout: postgresStatementTimeoutMs,
			idle_in_transaction_session_timeout: postgresIdleInTransactionSessionTimeoutMs,
		},
	});

	return {
		sql,
		db: drizzle({ client: sql, schema }),
	};
}

let defaultConnection: BillingDatabaseConnection | null = null;
let defaultConnectionConfig: { postgresUri: string; postgresPreparedStatements: boolean } | null =
	null;

/** Composition selects the one process-owned database before constructing repositories. */
export function configureDefaultConnection(
	env: Pick<BillingEnv, "postgresUri" | "postgresPreparedStatements">,
): void {
	if (
		defaultConnectionConfig &&
		(defaultConnectionConfig.postgresUri !== env.postgresUri ||
			defaultConnectionConfig.postgresPreparedStatements !== env.postgresPreparedStatements)
	) {
		throw new Error("The process database is already configured differently");
	}
	defaultConnectionConfig = {
		postgresUri: env.postgresUri,
		postgresPreparedStatements: env.postgresPreparedStatements,
	};
	defaultConnection ??= createBillingDatabaseConnection(env);
}

function getDefaultConnection(): BillingDatabaseConnection {
	if (defaultConnection === null) configureDefaultConnection(loadEnv());
	return defaultConnection as BillingDatabaseConnection;
}

export const sql = new Proxy(function sqlProxy() {}, {
	apply(_, thisArg, argArray) {
		return Reflect.apply(
			getDefaultConnection().sql as unknown as (...args: unknown[]) => unknown,
			thisArg,
			argArray,
		);
	},
	get(_, prop, receiver) {
		return Reflect.get(getDefaultConnection().sql, prop, receiver);
	},
}) as unknown as SQL;

export const db = new Proxy(
	{},
	{
		get(_, prop, receiver) {
			return Reflect.get(getDefaultConnection().db, prop, receiver);
		},
	},
) as BillingDatabase;

let postgresStartupHealth: PostgresHealthSnapshot = {
	healthy: false,
	error: "Postgres not initialized",
};

// A protocol violation can clear shortly, so the check waits before its one retry instead of
// repeating the query immediately. PgBouncer reports its own failures, including
// `server_login_retry`, with this SQLSTATE, and Bun surfaces it on `errno` even during login, so
// the code identifies them without matching message text.
const transientConnectionRetryDelayMs = 250;

function isTransientConnectionError(error: unknown): boolean {
	return sqlstateOf(error) === "08P01";
}

export async function checkPostgresHealth(
	queryClient: SQL = sql,
	retryDelayMs = transientConnectionRetryDelayMs,
): Promise<boolean> {
	try {
		await queryClient`SELECT 1`;
		return true;
	} catch (error) {
		if (!isTransientConnectionError(error)) {
			return false;
		}

		await Bun.sleep(retryDelayMs);
		try {
			await queryClient`SELECT 1`;
			return true;
		} catch {
			return false;
		}
	}
}

export async function initializePostgresHealth(
	queryClient: SQL = sql,
): Promise<PostgresHealthSnapshot> {
	const checkedAt = new Date().toISOString();
	const healthy = await checkPostgresHealth(queryClient);

	postgresStartupHealth = healthy
		? { healthy, checkedAt }
		: { healthy, checkedAt, error: "Postgres connection failed" };

	return postgresStartupHealth;
}

export function getPostgresStartupHealth(): PostgresHealthSnapshot {
	return postgresStartupHealth;
}

export async function closePool(): Promise<void> {
	if (defaultConnection === null) {
		return;
	}

	await defaultConnection.sql.close();
	defaultConnection = null;
	defaultConnectionConfig = null;
}
