import { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import type { BillingEnv } from "../env";
import { loadEnv } from "../env";
import { sqlstateOf } from "./postgres-errors";
import * as schema from "./schema";
import { type PostgresSettings, resolvePostgresSettings } from "./settings";

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

type DatabaseConfig = Pick<BillingEnv, "postgresUri"> &
	Partial<Pick<BillingEnv, "postgresPreparedStatements">> &
	PostgresSettings;

export function createBillingDatabaseConnection(env: DatabaseConfig) {
	const settings = resolvePostgresSettings(env);
	const sql = new SQL(env.postgresUri, {
		max: settings.postgresMaxConnections,
		idleTimeout: settings.postgresIdleTimeoutSeconds,
		maxLifetime: settings.postgresMaxLifetimeSeconds,
		...(settings.postgresConnectionTimeoutSeconds === undefined
			? {}
			: { connectionTimeout: settings.postgresConnectionTimeoutSeconds }),
		// Named prepared statements let the driver pipeline the independent statements the
		// metering path issues together. Disable only behind a transaction-mode pooler that
		// cannot hold them.
		prepare: env.postgresPreparedStatements ?? true,
		connection: {
			statement_timeout: settings.postgresStatementTimeoutMs,
			idle_in_transaction_session_timeout: settings.postgresIdleInTransactionSessionTimeoutMs,
			transaction_timeout: settings.postgresTransactionTimeoutMs,
		},
	});

	return {
		sql,
		db: drizzle({ client: sql, schema }),
	};
}

let defaultConnection: BillingDatabaseConnection | null = null;
let defaultConnectionConfig:
	| (ReturnType<typeof resolvePostgresSettings> & {
			postgresUri: string;
			postgresPreparedStatements: boolean;
	  })
	| null = null;

/** Composition selects the one process-owned database before constructing repositories. */
export function configureDefaultConnection(env: DatabaseConfig): void {
	const config = {
		...resolvePostgresSettings(env),
		postgresUri: env.postgresUri,
		postgresPreparedStatements: env.postgresPreparedStatements ?? true,
	};
	const previous = defaultConnectionConfig;
	if (
		previous &&
		Object.keys({ ...previous, ...config }).some(
			(key) => Reflect.get(previous, key) !== Reflect.get(config, key),
		)
	) {
		throw new Error("The process database is already configured differently");
	}
	defaultConnection ??= createBillingDatabaseConnection(env);
	defaultConnectionConfig = config;
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
