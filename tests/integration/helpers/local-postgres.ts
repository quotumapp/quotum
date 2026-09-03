import type { SQL } from "bun";
import { type BillingDatabase, createBillingDatabaseConnection } from "../../../src/db/client";
import { BillingRepository } from "../../../src/db/repository";
import type { BillingEnv } from "../../../src/env";
import { integrationProjects } from "./catalog-fixtures";

export interface LocalPostgresContext {
	env: BillingEnv;
	sql: SQL;
	db: BillingDatabase;
	repository: BillingRepository;
}

export function isPostgresIntegrationEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.RUN_POSTGRES_INTEGRATION_TESTS === "1";
}

export function describeLocalPostgres<T extends (name: string, fn: () => void) => void>(
	describeFn: T,
	describeSkipFn: T,
): T {
	return (isPostgresIntegrationEnabled() ? describeFn : describeSkipFn) as T;
}

export async function createLocalPostgresContext(): Promise<LocalPostgresContext> {
	if (!isPostgresIntegrationEnabled()) {
		throw new Error("Postgres integration tests are disabled");
	}

	const postgresUri = process.env.POSTGRES_URI;
	if (postgresUri === undefined || postgresUri.trim() === "") {
		throw new Error("POSTGRES_URI is required for Postgres integration tests");
	}

	const env = createIntegrationBillingEnv(postgresUri);
	const connection = createBillingDatabaseConnection(env);

	return {
		env,
		sql: connection.sql,
		db: connection.db,
		repository: new BillingRepository(connection.db as never),
	};
}

export function createIntegrationBillingEnv(
	postgresUri: string,
	overrides: Partial<BillingEnv> = {},
): BillingEnv {
	return {
		postgresUri,
		authMode: "api_key",
		operatorApiKey: "billing-integration-operator-key",
		trustGatewayProjectHeader: false,
		projects: integrationProjects.map(({ name: _name, ...project }) => project),
		runtimeEnvironment: "test",
		workerId: "integration-worker",
		workerPollIntervalMs: 5000,
		projectionSyncMaxAttempts: 10,
		storeEventReplayMaxAttempts: 10,
		storeEventReplayPollIntervalMs: 5000,
		subscriptionReconciliationPollIntervalMs: 60000,
		subscriptionReconciliationMaxAttempts: 10,
		providerReconciliationStaleAfterMs: 21600000,
		meteringMaintenancePollIntervalMs: 60000,
		rateLimit: {
			windowMs: 60000,
			verifyLimit: 120,
			webhookLimit: 600,
			adminLimit: 60,
			meteringLimit: 6000,
			trustProxyHeaders: false,
		},
		sentry: {
			dsn: null,
			enableLogs: true,
			tracesSampleRate: 0.01,
			logLevel: "warn",
			captureExpectedErrors: false,
		},
		...overrides,
	};
}
