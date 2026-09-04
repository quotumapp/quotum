import { describe, expect, it } from "bun:test";
import { loadEnv } from "../src/env";

const postgresUri = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const operatorApiKey = "billing-operator-key-secret";
const project = {
	projectInstanceKey: "voysee",
	projectionUrl: "https://voysee.example.com",
	projectionSecret: "voysee-projection-secret",
};
const runtimeJson = JSON.stringify([project]);
const parsedProject = {
	...project,
	projectionContract: "billing_state_v1" as const,
};
const developmentSource = {
	POSTGRES_URI: postgresUri,
	BILLING_ENV: "development",
	BILLING_PROJECT_RUNTIME_JSON: runtimeJson,
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
			projectRuntime: [parsedProject],
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

	it("parses more than one project runtime entry", () => {
		const env = loadEnv({
			...developmentSource,
			BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([
				project,
				{
					projectInstanceKey: "wiseley",
					projectionUrl: "https://wiseley.example.com",
					projectionSecret: "wiseley-projection-secret",
				},
			]),
		});

		expect(env.projectRuntime).toEqual([
			parsedProject,
			{
				projectInstanceKey: "wiseley",
				projectionUrl: "https://wiseley.example.com",
				projectionSecret: "wiseley-projection-secret",
				projectionContract: "billing_state_v1",
			},
		]);
	});

	it("rejects duplicate project instance keys", () => {
		const secondProject = {
			...project,
			projectInstanceKey: "wiseley",
			projectionUrl: "https://wiseley.example.com",
		};

		expect(() =>
			loadEnv({
				...developmentSource,
				BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([
					project,
					{ ...secondProject, projectInstanceKey: project.projectInstanceKey },
				]),
			}),
		).toThrow("BILLING_PROJECT_RUNTIME_JSON contains duplicate project instance keys");
	});

	it("parses per-project provider configuration", () => {
		const googleServiceAccount = {
			type: "service_account",
			client_email: "wiseley-play@example.iam.gserviceaccount.com",
			private_key: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
		};
		const env = loadEnv({
			...developmentSource,
			BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([
				{
					...project,
					apple: {
						bundleId: "com.voysee.app",
						appAppleId: 1234567890,
						issuerId: "99b16628-15e4-4668-972b-eeff55eeff55",
						keyId: "ABCDEFGHIJ",
						privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
						environment: "production",
						enableOnlineChecks: true,
						rootCertificatesDir: "/tmp/apple-certs",
					},
					googlePlay: {
						packageName: "com.voysee.app",
						serviceAccountJson: JSON.stringify(googleServiceAccount),
						serviceAccountKeyFile: null,
						obfuscatedAccountIdSecret: "account-link-secret",
						previousObfuscatedAccountIdSecrets: ["previous-secret"],
						rtdnAudience: "https://billing.example.com/v1/projects/voysee/webhooks/google",
						rtdnServiceAccountEmail: "pubsub-push@example.iam.gserviceaccount.com",
						rtdnAuthorizedParty: "pubsub-push-client-id",
						enablePublisherMutations: false,
					},
					stripe: {
						secretKey: "sk_test_voysee",
						webhookSecret: "whsec_voysee",
						checkoutSuccessUrl:
							"https://voysee.example.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
						checkoutCancelUrl: "https://voysee.example.com/billing",
						portalReturnUrl: "https://voysee.example.com/account/billing",
					},
				},
			]),
		});

		expect(env.projectRuntime[0]).toMatchObject({
			apple: { bundleId: "com.voysee.app", environment: "production" },
			googlePlay: {
				packageName: "com.voysee.app",
				previousObfuscatedAccountIdSecrets: ["previous-secret"],
				rtdnAuthorizedParty: "pubsub-push-client-id",
			},
			stripe: { secretKey: "sk_test_voysee", webhookSecret: "whsec_voysee" },
		});
	});

	it("validates each project's provider configuration", () => {
		const invalidProviders = [
			{
				apple: {
					bundleId: "com.voysee.app",
					appAppleId: 1234567890,
					issuerId: "issuer",
					keyId: "key",
					privateKey: "private-key",
					environment: "production",
					enableOnlineChecks: false,
					rootCertificatesDir: null,
				},
			},
			{
				googlePlay: {
					packageName: "com.voysee.app",
					serviceAccountJson: null,
					serviceAccountKeyFile: null,
					obfuscatedAccountIdSecret: "account-secret",
					previousObfuscatedAccountIdSecrets: [],
					rtdnAudience: null,
					rtdnServiceAccountEmail: null,
					rtdnAuthorizedParty: null,
					enablePublisherMutations: true,
				},
			},
			{
				stripe: {
					secretKey: "sk_test_voysee",
					webhookSecret: "whsec_voysee",
					checkoutSuccessUrl: "https://voysee.example.com/billing/success",
					checkoutCancelUrl: "https://voysee.example.com/billing",
					portalReturnUrl: "https://voysee.example.com/account/billing",
				},
			},
		];

		for (const provider of invalidProviders) {
			expect(() =>
				loadEnv({
					...developmentSource,
					BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([{ ...project, ...provider }]),
				}),
			).toThrow("BILLING_PROJECT_RUNTIME_JSON is invalid");
		}
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

	it("requires project configuration in every auth mode", () => {
		expect(() =>
			loadEnv({
				POSTGRES_URI: postgresUri,
				BILLING_ENV: "development",
			}),
		).toThrow("BILLING_PROJECT_RUNTIME_JSON is required");
		expect(() =>
			loadEnv({
				POSTGRES_URI: postgresUri,
				BILLING_ENV: "development",
				BILLING_AUTH_MODE: "gateway",
				BILLING_TRUST_GATEWAY_PROJECT_HEADER: "true",
			}),
		).toThrow("BILLING_PROJECT_RUNTIME_JSON is required");
		expect(() => loadEnv({ ...developmentSource, BILLING_PROJECT_RUNTIME_JSON: "[]" })).toThrow(
			"BILLING_PROJECT_RUNTIME_JSON is invalid",
		);
	});

	it("requires projection delivery configuration for every project", () => {
		expect(() =>
			loadEnv({
				...developmentSource,
				BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([{ projectInstanceKey: "voysee" }]),
			}),
		).toThrow("BILLING_PROJECT_RUNTIME_JSON is invalid");
	});

	it("rejects the removed combined project configuration", () => {
		expect(() =>
			loadEnv({
				...developmentSource,
				BILLING_PROJECTS_JSON: runtimeJson,
			}),
		).toThrow("BILLING_PROJECTS_JSON has been removed");
	});

	it("rejects legacy identity and catalog fields in runtime configuration", () => {
		for (const legacyField of [
			{ apiKey: "plaintext-key-must-not-be-retained" },
			{ active: true },
			{ catalog: [] },
		]) {
			expect(() =>
				loadEnv({
					...developmentSource,
					BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([{ ...project, ...legacyField }]),
				}),
			).toThrow("BILLING_PROJECT_RUNTIME_JSON is invalid");
		}
	});

	it("rejects obsolete projection adapter configuration", () => {
		for (const adapter of ["noop", "voysee"]) {
			expect(() =>
				loadEnv({
					...developmentSource,
					BILLING_PROJECTION_ADAPTER: adapter,
				}),
			).toThrow("BILLING_PROJECTION_ADAPTER has been removed");
		}
	});

	it("requires an operator API key in production", () => {
		expect(() =>
			loadEnv({
				POSTGRES_URI: postgresUri,
				BILLING_ENV: "production",
				BILLING_PROJECT_RUNTIME_JSON: runtimeJson,
			}),
		).toThrow("BILLING_OPERATOR_API_KEY is required in production");
	});

	it("rejects unsafe production projection URLs", () => {
		const unsafeUrls = [
			"http://voysee.example.com",
			"https://localhost",
			"https://127.0.0.1",
			"https://10.0.0.8",
			"https://172.16.0.8",
			"https://192.168.1.8",
			"https://169.254.1.8",
			"https://[::1]",
			"https://[::ffff:127.0.0.1]",
			"https://[::ffff:10.0.0.1]",
			"https://[::ffff:7f00:1]",
			"https://[::ffff:a00:1]",
			"https://[fd00::1]",
			"https://[fe80::1]",
		];

		for (const projectionUrl of unsafeUrls) {
			expect(() =>
				loadEnv({
					POSTGRES_URI: postgresUri,
					BILLING_ENV: "production",
					BILLING_OPERATOR_API_KEY: operatorApiKey,
					BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([{ ...project, projectionUrl }]),
				}),
			).toThrow("Production billing project projectionUrl must be an HTTPS public URL");
		}
	});

	it("accepts production projects with HTTP projection delivery configuration", () => {
		const env = loadEnv({
			POSTGRES_URI: postgresUri,
			BILLING_ENV: "production",
			BILLING_OPERATOR_API_KEY: operatorApiKey,
			BILLING_PROJECT_RUNTIME_JSON: runtimeJson,
		});

		expect(env.projectRuntime).toEqual([parsedProject]);
	});

	it("rejects non-HTTPS Stripe redirects and allowed origins in production", () => {
		const stripe = {
			secretKey: "sk_live_123",
			webhookSecret: "whsec_123",
			checkoutSuccessUrl: "https://app.example.com/success?session={CHECKOUT_SESSION_ID}",
			checkoutCancelUrl: "https://app.example.com/cancel",
			portalReturnUrl: "https://app.example.com/account",
		};
		for (const override of [
			{ checkoutSuccessUrl: "http://app.example.com/success?session={CHECKOUT_SESSION_ID}" },
			{ checkoutCancelUrl: "http://app.example.com/cancel" },
			{ portalReturnUrl: "http://app.example.com/account" },
			{ allowedReturnOrigins: ["http://app.example.com"] },
		]) {
			expect(() =>
				loadEnv({
					POSTGRES_URI: postgresUri,
					BILLING_ENV: "production",
					BILLING_OPERATOR_API_KEY: operatorApiKey,
					BILLING_PROJECT_RUNTIME_JSON: JSON.stringify([
						{ ...project, stripe: { ...stripe, ...override } },
					]),
				}),
			).toThrow("Production Stripe redirect URLs and allowed origins must use HTTPS");
		}
	});

	it("fails closed when required configuration is missing", () => {
		expect(() => loadEnv({})).toThrow("POSTGRES_URI is required");
		expect(() => loadEnv({ POSTGRES_URI: postgresUri, BILLING_ENV: "development" })).toThrow(
			"BILLING_PROJECT_RUNTIME_JSON is required",
		);
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
