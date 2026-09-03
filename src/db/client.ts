import { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import type { BillingEnv } from "../env";
import { loadEnv } from "../env";
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

export function createBillingDatabaseConnection(env: Pick<BillingEnv, "postgresUri">) {
	const sql = new SQL(env.postgresUri, {
		max: 20,
		idleTimeout: 60,
		maxLifetime: 0,
		prepare: false,
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

function getDefaultConnection(): BillingDatabaseConnection {
	defaultConnection ??= createBillingDatabaseConnection(loadEnv());
	return defaultConnection;
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

const transientConnectionErrors = new Set(["ERR_POSTGRES_LIFETIME_TIMEOUT", "08P01"]);

let postgresStartupHealth: PostgresHealthSnapshot = {
	healthy: false,
	error: "Postgres not initialized",
};

function isTransientConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	if (error instanceof SQL.PostgresError && transientConnectionErrors.has(error.code)) {
		return true;
	}

	return (
		error.message.includes("Max lifetime timeout") || error.message.includes("server_login_retry")
	);
}

export async function checkPostgresHealth(queryClient: SQL = sql): Promise<boolean> {
	try {
		await queryClient`SELECT 1`;
		return true;
	} catch (error) {
		if (!isTransientConnectionError(error)) {
			return false;
		}

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
}
