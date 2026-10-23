import {
	type IntegerOverrides,
	loadIntegerSettings,
	resolveIntegerSettings,
} from "../shared/integer-settings";

// Bun accepts seconds and converts them to milliseconds; keep the result in the timer range.
const maxTimeoutSeconds = Math.floor(2_147_483_647 / 1000);

export const postgresIntegerSettings = {
	postgresMaxConnections: { variable: "BILLING_POSTGRES_MAX_CONNECTIONS", default: 20 },
	postgresIdleTimeoutSeconds: {
		variable: "BILLING_POSTGRES_IDLE_TIMEOUT_SECONDS",
		default: 60,
		min: 0,
		max: maxTimeoutSeconds,
	},
	postgresMaxLifetimeSeconds: {
		variable: "BILLING_POSTGRES_MAX_LIFETIME_SECONDS",
		default: 0,
		min: 0,
		max: maxTimeoutSeconds,
	},
	// Omitted unless explicitly configured, preserving the driver's connection-string behavior.
	postgresConnectionTimeoutSeconds: {
		variable: "BILLING_POSTGRES_CONNECTION_TIMEOUT_SECONDS",
		max: maxTimeoutSeconds,
	},
	postgresStatementTimeoutMs: {
		variable: "BILLING_POSTGRES_STATEMENT_TIMEOUT_MS",
		default: 30_000,
		min: 0,
	},
	postgresIdleInTransactionSessionTimeoutMs: {
		variable: "BILLING_POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS",
		default: 30_000,
		min: 0,
	},
	postgresTransactionTimeoutMs: {
		variable: "BILLING_POSTGRES_TRANSACTION_TIMEOUT_MS",
		default: 120_000,
		min: 0,
	},
} as const;

export type PostgresSettings = IntegerOverrides<typeof postgresIntegerSettings>;

export function loadPostgresSettings(source: Record<string, string | undefined> = process.env) {
	return loadIntegerSettings(postgresIntegerSettings, source);
}

export function resolvePostgresSettings(settings: PostgresSettings) {
	return resolveIntegerSettings(postgresIntegerSettings, settings);
}
