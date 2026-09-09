import { describe, expect, it } from "bun:test";
import { loadEnv } from "../src/env";

const postgresUri = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const operatorApiKey = "billing-operator-key-secret";
const developmentSource = {
	POSTGRES_URI: postgresUri,
	BILLING_ENV: "development",
} as const;

describe("loadEnv", () => {
	it("parses required billing service configuration", () => {
		const env = loadEnv({
			...developmentSource,
			BILLING_WORKER_ID: "worker-a",
			BILLING_WORKER_POLL_INTERVAL_MS: "2500",
			BILLING_PROJECTION_SYNC_MAX_ATTEMPTS: "7",
			BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS: "8",
			BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS: "3500",
			BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS: "4500",
			BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS: "9",
			BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS: "5500",
			BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS: "7500",
			BILLING_RATE_LIMIT_WINDOW_MS: "6500",
			BILLING_VERIFY_RATE_LIMIT_PER_WINDOW: "12",
			BILLING_WEBHOOK_RATE_LIMIT_PER_WINDOW: "34",
			BILLING_ADMIN_RATE_LIMIT_PER_WINDOW: "56",
			BILLING_METERING_RATE_LIMIT_PER_WINDOW: "78",
		});

		expect(env).toEqual({
			postgresUri,
			authMode: "api_key",
			operatorApiKey: null,
			runtimeEnvironment: "development",
			trustGatewayProjectHeader: false,
			workerId: "worker-a",
			workerPollIntervalMs: 2500,
			projectionSyncMaxAttempts: 7,
			storeEventReplayMaxAttempts: 8,
			storeEventReplayPollIntervalMs: 3500,
			subscriptionReconciliationPollIntervalMs: 4500,
			subscriptionReconciliationMaxAttempts: 9,
			providerReconciliationStaleAfterMs: 5500,
			meteringMaintenancePollIntervalMs: 7500,
			rateLimit: {
				windowMs: 6500,
				verifyLimit: 12,
				webhookLimit: 34,
				adminLimit: 56,
				meteringLimit: 78,
				trustProxyHeaders: false,
			},
			sentry: {
				dsn: null,
				enableLogs: true,
				tracesSampleRate: 0.01,
				logLevel: "warn",
				captureExpectedErrors: false,
			},
		});
	});

	it("uses safe worker defaults", () => {
		const env = loadEnv(developmentSource);

		expect(env.runtimeEnvironment).toBe("development");
		expect(env.workerId).toMatch(/^billing-worker-/);
		expect(env.workerPollIntervalMs).toBe(5000);
		expect(env.projectionSyncMaxAttempts).toBe(10);
		expect(env.storeEventReplayMaxAttempts).toBe(10);
		expect(env.storeEventReplayPollIntervalMs).toBe(5000);
		expect(env.subscriptionReconciliationPollIntervalMs).toBe(60000);
		expect(env.subscriptionReconciliationMaxAttempts).toBe(10);
		expect(env.providerReconciliationStaleAfterMs).toBe(21600000);
		expect(env.rateLimit).toEqual({
			windowMs: 60000,
			verifyLimit: 120,
			webhookLimit: 600,
			adminLimit: 60,
			meteringLimit: 6000,
			trustProxyHeaders: false,
		});
		expect(env.sentry).toEqual({
			dsn: null,
			enableLogs: true,
			tracesSampleRate: 0.01,
			logLevel: "warn",
			captureExpectedErrors: false,
		});
	});

	it("parses Sentry observability overrides", () => {
		const env = loadEnv({
			...developmentSource,
			SENTRY_DSN: " https://sentry.example/123 ",
			SENTRY_ENABLE_LOGS: "false",
			SENTRY_TRACES_SAMPLE_RATE: "0.25",
			SENTRY_LOG_LEVEL: "info",
			SENTRY_CAPTURE_EXPECTED_ERRORS: "true",
		});

		expect(env.sentry).toEqual({
			dsn: "https://sentry.example/123",
			enableLogs: false,
			tracesSampleRate: 0.25,
			logLevel: "info",
			captureExpectedErrors: true,
		});
	});

	it("allows Sentry to be disabled with a blank DSN", () => {
		const env = loadEnv({ ...developmentSource, SENTRY_DSN: "" });

		expect(env.sentry.dsn).toBeNull();
	});

	it("parses explicit trusted proxy header configuration", () => {
		const env = loadEnv({ ...developmentSource, BILLING_TRUST_PROXY_HEADERS: "true" });

		expect(env.rateLimit.trustProxyHeaders).toBe(true);
	});

	it("defaults to API-key auth mode", () => {
		expect(loadEnv(developmentSource).authMode).toBe("api_key");
	});

	it("parses a separate operator API key", () => {
		const env = loadEnv({
			...developmentSource,
			BILLING_OPERATOR_API_KEY: operatorApiKey,
		});

		expect(env.operatorApiKey).toBe(operatorApiKey);
	});

	it("allows gateway auth mode with project configuration", () => {
		const env = loadEnv({
			...developmentSource,
			BILLING_AUTH_MODE: "gateway",
			BILLING_TRUST_GATEWAY_PROJECT_HEADER: "true",
		});

		expect(env.authMode).toBe("gateway");
		expect(env.trustGatewayProjectHeader).toBe(true);
	});

	it("requires explicit gateway project-header trust in gateway auth mode", () => {
		expect(() =>
			loadEnv({
				...developmentSource,
				BILLING_AUTH_MODE: "gateway",
			}),
		).toThrow(
			"BILLING_TRUST_GATEWAY_PROJECT_HEADER must be true when BILLING_AUTH_MODE is gateway",
		);
	});

	it("boots without a customer list and rejects every supplied legacy list", () => {
		for (const environment of ["test", "development", "production"] as const) {
			const source = {
				...developmentSource,
				BILLING_ENV: environment,
				BILLING_OPERATOR_API_KEY: operatorApiKey,
			};
			expect(loadEnv(source).runtimeEnvironment).toBe(environment);
			for (const legacy of ["", "[]", '[{"projectInstanceKey":"demo"}]'])
				expect(() => loadEnv({ ...source, BILLING_PROJECT_RUNTIME_JSON: legacy })).toThrow(
					"has been removed",
				);
		}
		expect(() => loadEnv({ ...developmentSource, BILLING_PROJECTS_JSON: "[]" })).toThrow(
			"BILLING_PROJECTS_JSON",
		);
	});

	it("requires an operator API key in production", () => {
		expect(() =>
			loadEnv({
				POSTGRES_URI: postgresUri,
				BILLING_ENV: "production",
			}),
		).toThrow("BILLING_OPERATOR_API_KEY is required in production");
	});

	it("fails closed when required configuration is missing", () => {
		expect(() => loadEnv({})).toThrow("POSTGRES_URI is required");
	});

	it("rejects invalid numeric settings", () => {
		expect(() =>
			loadEnv({
				...developmentSource,
				BILLING_WORKER_POLL_INTERVAL_MS: "0",
			}),
		).toThrow("BILLING_WORKER_POLL_INTERVAL_MS must be a positive integer");
	});
});
