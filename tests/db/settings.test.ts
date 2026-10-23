import { describe, expect, it } from "bun:test";
import {
	loadPostgresSettings,
	postgresIntegerSettings,
	resolvePostgresSettings,
} from "../../src/db/settings";
import { loadEnv } from "../../src/env";

describe("Postgres environment settings", () => {
	it("keeps every current default and leaves connection establishment to the driver", () => {
		expect(loadPostgresSettings({})).toEqual({});
		expect(resolvePostgresSettings({})).toEqual({
			postgresMaxConnections: 20,
			postgresIdleTimeoutSeconds: 60,
			postgresMaxLifetimeSeconds: 0,
			postgresStatementTimeoutMs: 30_000,
			postgresIdleInTransactionSessionTimeoutMs: 30_000,
			postgresTransactionTimeoutMs: 120_000,
		});
	});

	it("loads all overrides through the service environment and the narrow loader", () => {
		const source = {
			BILLING_POSTGRES_MAX_CONNECTIONS: "4",
			BILLING_POSTGRES_IDLE_TIMEOUT_SECONDS: "10",
			BILLING_POSTGRES_MAX_LIFETIME_SECONDS: "900",
			BILLING_POSTGRES_CONNECTION_TIMEOUT_SECONDS: "7",
			BILLING_POSTGRES_STATEMENT_TIMEOUT_MS: "1200",
			BILLING_POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "3400",
			BILLING_POSTGRES_TRANSACTION_TIMEOUT_MS: "5600",
		};
		const expected = {
			postgresMaxConnections: 4,
			postgresIdleTimeoutSeconds: 10,
			postgresMaxLifetimeSeconds: 900,
			postgresConnectionTimeoutSeconds: 7,
			postgresStatementTimeoutMs: 1200,
			postgresIdleInTransactionSessionTimeoutMs: 3400,
			postgresTransactionTimeoutMs: 5600,
		};
		expect(loadPostgresSettings(source)).toEqual(expected);
		expect(
			loadEnv({ ...source, POSTGRES_URI: "postgres://localhost/test", BILLING_ENV: "test" }),
		).toMatchObject(expected);
	});

	it("preserves zero without replacing it with a default", () => {
		const settings = loadPostgresSettings({
			BILLING_POSTGRES_IDLE_TIMEOUT_SECONDS: "0",
			BILLING_POSTGRES_MAX_LIFETIME_SECONDS: "0",
			BILLING_POSTGRES_STATEMENT_TIMEOUT_MS: "0",
			BILLING_POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "0",
			BILLING_POSTGRES_TRANSACTION_TIMEOUT_MS: "0",
		});
		expect(resolvePostgresSettings(settings)).toMatchObject({
			postgresIdleTimeoutSeconds: 0,
			postgresMaxLifetimeSeconds: 0,
			postgresStatementTimeoutMs: 0,
			postgresIdleInTransactionSessionTimeoutMs: 0,
			postgresTransactionTimeoutMs: 0,
		});
	});

	for (const setting of Object.values(postgresIntegerSettings)) {
		it(`rejects malformed and overflowing ${setting.variable}`, () => {
			for (const value of [
				"",
				" ",
				"-1",
				"1.5",
				"1e3",
				"00",
				"NaN",
				"Infinity",
				"9007199254740992",
			]) {
				expect(() => loadPostgresSettings({ [setting.variable]: value })).toThrow(setting.variable);
			}
		});
	}

	it("enforces positive pool/connect limits and PostgreSQL/timer ranges", () => {
		for (const variable of [
			"BILLING_POSTGRES_MAX_CONNECTIONS",
			"BILLING_POSTGRES_CONNECTION_TIMEOUT_SECONDS",
		]) {
			expect(() => loadPostgresSettings({ [variable]: "0" })).toThrow(variable);
		}
		expect(() =>
			loadPostgresSettings({ BILLING_POSTGRES_STATEMENT_TIMEOUT_MS: "2147483648" }),
		).toThrow("BILLING_POSTGRES_STATEMENT_TIMEOUT_MS");
		expect(() =>
			loadPostgresSettings({ BILLING_POSTGRES_IDLE_TIMEOUT_SECONDS: "2147484" }),
		).toThrow("BILLING_POSTGRES_IDLE_TIMEOUT_SECONDS");
		expect(() => resolvePostgresSettings({ postgresMaxConnections: 0 })).toThrow(
			"BILLING_POSTGRES_MAX_CONNECTIONS",
		);
		expect(
			loadPostgresSettings({ BILLING_POSTGRES_MAX_CONNECTIONS: " 8 " }).postgresMaxConnections,
		).toBe(8);
	});
});
