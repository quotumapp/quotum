import { isIP } from "node:net";
import { z } from "zod";
import type { ProjectRuntimeConfig } from "./projects/config";
import { parseProjectRuntimeConfigs } from "./projects/config";

export type AppleEnvironmentName = "sandbox" | "production";
export type BillingRuntimeEnvironment = "development" | "test" | "production";
export type BillingAuthMode = "api_key" | "gateway";

export interface BillingRateLimitEnv {
	windowMs: number;
	verifyLimit: number;
	webhookLimit: number;
	adminLimit: number;
	meteringLimit: number;
	trustProxyHeaders: boolean;
}

export interface SentryEnv {
	dsn: string | null;
	enableLogs: boolean;
	tracesSampleRate: number;
	logLevel: "info" | "warn" | "error";
	captureExpectedErrors: boolean;
}

export interface AppleBillingEnv {
	bundleId: string;
	appAppleId: number | null;
	issuerId: string;
	keyId: string;
	privateKey: string;
	environment: AppleEnvironmentName;
	enableOnlineChecks: boolean;
	rootCertificatesDir: string | null;
}

export interface GooglePlayBillingEnv {
	packageName: string;
	serviceAccountJson: string | null;
	serviceAccountKeyFile: string | null;
	obfuscatedAccountIdSecret: string;
	previousObfuscatedAccountIdSecrets: string[];
	rtdnAudience: string | null;
	rtdnServiceAccountEmail: string | null;
	rtdnAuthorizedParty: string | null;
	enablePublisherMutations: boolean;
}

export interface StripeBillingEnv {
	secretKey: string;
	webhookSecret: string;
	checkoutSuccessUrl: string;
	checkoutCancelUrl: string;
	portalReturnUrl: string;
	allowedReturnOrigins?: string[];
	taxMode?: "disabled" | "test" | "registered";
	integrationIdentifier?: string;
}

export interface BillingEnv {
	postgresUri: string;
	authMode: BillingAuthMode;
	operatorApiKey: string | null;
	trustGatewayProjectHeader: boolean;
	projects: ProjectRuntimeConfig[];
	runtimeEnvironment: BillingRuntimeEnvironment;
	workerId: string;
	workerPollIntervalMs: number;
	projectionSyncMaxAttempts: number;
	storeEventReplayMaxAttempts: number;
	storeEventReplayPollIntervalMs: number;
	subscriptionReconciliationMaxAttempts: number;
	subscriptionReconciliationPollIntervalMs: number;
	providerReconciliationStaleAfterMs: number;
	meteringMaintenancePollIntervalMs: number;
	rateLimit: BillingRateLimitEnv;
	sentry: SentryEnv;
}

const envSchema = z.object({
	POSTGRES_URI: requiredString("POSTGRES_URI"),
	BILLING_OPERATOR_API_KEY: optionalString(),
	BILLING_PROJECTS_JSON: requiredString("BILLING_PROJECTS_JSON"),
	BILLING_AUTH_MODE: z.enum(["api_key", "gateway"]).default("api_key"),
	BILLING_TRUST_GATEWAY_PROJECT_HEADER: z.enum(["true", "false"]).default("false"),
	BILLING_ENV: z.enum(["development", "test", "production"]).default("production"),
	BILLING_WORKER_ID: z.string().trim().min(1).optional(),
	BILLING_WORKER_POLL_INTERVAL_MS: positiveIntegerString("BILLING_WORKER_POLL_INTERVAL_MS").default(
		"5000",
	),
	BILLING_PROJECTION_SYNC_MAX_ATTEMPTS: positiveIntegerString(
		"BILLING_PROJECTION_SYNC_MAX_ATTEMPTS",
	).default("10"),
	BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS: positiveIntegerString(
		"BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS",
	).default("10"),
	BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS: positiveIntegerString(
		"BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS",
	).default("5000"),
	BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS: positiveIntegerString(
		"BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS",
	).default("60000"),
	BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS: positiveIntegerString(
		"BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS",
	).default("10"),
	BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS: positiveIntegerString(
		"BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS",
	).default("21600000"),
	BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS: positiveIntegerString(
		"BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS",
	).default("60000"),
	BILLING_RATE_LIMIT_WINDOW_MS: positiveIntegerString("BILLING_RATE_LIMIT_WINDOW_MS").default(
		"60000",
	),
	BILLING_VERIFY_RATE_LIMIT_PER_WINDOW: positiveIntegerString(
		"BILLING_VERIFY_RATE_LIMIT_PER_WINDOW",
	).default("120"),
	BILLING_WEBHOOK_RATE_LIMIT_PER_WINDOW: positiveIntegerString(
		"BILLING_WEBHOOK_RATE_LIMIT_PER_WINDOW",
	).default("600"),
	BILLING_ADMIN_RATE_LIMIT_PER_WINDOW: positiveIntegerString(
		"BILLING_ADMIN_RATE_LIMIT_PER_WINDOW",
	).default("60"),
	BILLING_METERING_RATE_LIMIT_PER_WINDOW: positiveIntegerString(
		"BILLING_METERING_RATE_LIMIT_PER_WINDOW",
	).default("6000"),
	BILLING_TRUST_PROXY_HEADERS: z.enum(["true", "false"]).default("false"),
	SENTRY_DSN: z.string().optional(),
	SENTRY_ENABLE_LOGS: z.enum(["true", "false"]).default("true"),
	SENTRY_TRACES_SAMPLE_RATE: sampleRateString("SENTRY_TRACES_SAMPLE_RATE").default("0.01"),
	SENTRY_LOG_LEVEL: z.enum(["info", "warn", "error"]).default("warn"),
	SENTRY_CAPTURE_EXPECTED_ERRORS: z.enum(["true", "false"]).default("false"),
});

export function loadEnv(source: Record<string, string | undefined> = process.env): BillingEnv {
	if (source.BILLING_PROJECTION_ADAPTER !== undefined) {
		throw new Error(
			"BILLING_PROJECTION_ADAPTER has been removed; configure project projectionUrl and projectionSecret",
		);
	}

	const parsed = envSchema.parse(source);

	const sentry = parseSentryEnv(parsed, source);
	const authMode = parsed.BILLING_AUTH_MODE;
	const trustGatewayProjectHeader = parsed.BILLING_TRUST_GATEWAY_PROJECT_HEADER === "true";
	if (authMode === "gateway" && !trustGatewayProjectHeader) {
		throw new Error(
			"BILLING_TRUST_GATEWAY_PROJECT_HEADER must be true when BILLING_AUTH_MODE is gateway",
		);
	}
	const projects = parseProjectRuntimeConfigs(parsed.BILLING_PROJECTS_JSON);
	const operatorApiKey = parseOperatorApiKey(parsed.BILLING_OPERATOR_API_KEY);
	if (parsed.BILLING_ENV === "production") {
		assertProductionOperatorApiKey(operatorApiKey);
		assertProductionProjectionProjects(projects);
		assertProductionStripeProjects(projects);
	}

	return {
		postgresUri: parsed.POSTGRES_URI,
		authMode,
		operatorApiKey,
		trustGatewayProjectHeader,
		projects,
		runtimeEnvironment: parsed.BILLING_ENV,
		workerId: parsed.BILLING_WORKER_ID ?? `billing-worker-${crypto.randomUUID()}`,
		workerPollIntervalMs: Number.parseInt(parsed.BILLING_WORKER_POLL_INTERVAL_MS, 10),
		projectionSyncMaxAttempts: Number.parseInt(parsed.BILLING_PROJECTION_SYNC_MAX_ATTEMPTS, 10),
		storeEventReplayMaxAttempts: Number.parseInt(
			parsed.BILLING_STORE_EVENT_REPLAY_MAX_ATTEMPTS,
			10,
		),
		storeEventReplayPollIntervalMs: Number.parseInt(
			parsed.BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS,
			10,
		),
		subscriptionReconciliationPollIntervalMs: Number.parseInt(
			parsed.BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS,
			10,
		),
		subscriptionReconciliationMaxAttempts: Number.parseInt(
			parsed.BILLING_SUBSCRIPTION_RECONCILIATION_MAX_ATTEMPTS,
			10,
		),
		providerReconciliationStaleAfterMs: Number.parseInt(
			parsed.BILLING_PROVIDER_RECONCILIATION_STALE_AFTER_MS,
			10,
		),
		meteringMaintenancePollIntervalMs: Number.parseInt(
			parsed.BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS,
			10,
		),
		rateLimit: {
			windowMs: Number.parseInt(parsed.BILLING_RATE_LIMIT_WINDOW_MS, 10),
			verifyLimit: Number.parseInt(parsed.BILLING_VERIFY_RATE_LIMIT_PER_WINDOW, 10),
			webhookLimit: Number.parseInt(parsed.BILLING_WEBHOOK_RATE_LIMIT_PER_WINDOW, 10),
			adminLimit: Number.parseInt(parsed.BILLING_ADMIN_RATE_LIMIT_PER_WINDOW, 10),
			meteringLimit: Number.parseInt(parsed.BILLING_METERING_RATE_LIMIT_PER_WINDOW, 10),
			trustProxyHeaders: parsed.BILLING_TRUST_PROXY_HEADERS === "true",
		},
		sentry,
	};
}

function assertProductionOperatorApiKey(operatorApiKey: string | null): void {
	if (operatorApiKey === null) {
		throw new Error("BILLING_OPERATOR_API_KEY is required in production");
	}
}

function assertProductionProjectionProjects(projects: readonly ProjectRuntimeConfig[]): void {
	for (const project of projects) {
		if (!isProductionProjectionUrlSafe(project.projectionUrl)) {
			throw new Error("Production billing project projectionUrl must be an HTTPS public URL");
		}
	}
}

function assertProductionStripeProjects(projects: readonly ProjectRuntimeConfig[]): void {
	for (const project of projects) {
		const stripe = project.stripe;
		if (stripe === null || stripe === undefined) {
			continue;
		}
		const urls = [
			stripe.checkoutSuccessUrl,
			stripe.checkoutCancelUrl,
			stripe.portalReturnUrl,
			...(stripe.allowedReturnOrigins ?? []),
		];
		if (urls.some((value) => !isHttpsUrl(value))) {
			throw new Error("Production Stripe redirect URLs and allowed origins must use HTTPS");
		}
	}
}

function isHttpsUrl(value: string): boolean {
	const url = new URL(value);
	return url.protocol === "https:" && url.username === "" && url.password === "";
}

function isProductionProjectionUrlSafe(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}

	if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
		return false;
	}

	const hostname = normalizeUrlHostname(url.hostname);
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		return false;
	}

	const ipVersion = isIP(hostname);
	if (ipVersion === 4) {
		return !isUnsafeIpv4(hostname);
	}
	if (ipVersion === 6) {
		return !isUnsafeIpv6(hostname);
	}

	return true;
}

function normalizeUrlHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isUnsafeIpv4(hostname: string): boolean {
	const [first, second] = hostname.split(".").map((part) => Number.parseInt(part, 10));

	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168)
	);
}

function isUnsafeIpv6(hostname: string): boolean {
	if (hostname === "::" || hostname === "::1") {
		return true;
	}

	const ipv4MappedPrefix = "::ffff:";
	if (hostname.startsWith(ipv4MappedPrefix)) {
		const mappedIpv4 = ipv4FromMappedIpv6(hostname.slice(ipv4MappedPrefix.length));
		return mappedIpv4 !== null && isUnsafeIpv4(mappedIpv4);
	}

	const firstHextet = Number.parseInt(hostname.split(":")[0] ?? "", 16);
	if (!Number.isFinite(firstHextet)) {
		return false;
	}

	return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

function ipv4FromMappedIpv6(value: string): string | null {
	if (isIP(value) === 4) {
		return value;
	}

	const hextets = value.split(":");
	if (hextets.length !== 2 || hextets.some((hextet) => !/^[0-9a-f]{1,4}$/i.test(hextet))) {
		return null;
	}
	const high = Number.parseInt(hextets[0] ?? "", 16);
	const low = Number.parseInt(hextets[1] ?? "", 16);
	return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

function parseOperatorApiKey(value: string | undefined): string | null {
	if (value === undefined) {
		return null;
	}

	if (value.length < 16) {
		throw new Error("BILLING_OPERATOR_API_KEY must be at least 16 characters");
	}

	return value;
}

function parseSentryEnv(
	parsed: z.infer<typeof envSchema>,
	source: Record<string, string | undefined>,
): SentryEnv {
	const rawDsn = source.SENTRY_DSN;
	const dsn = rawDsn === undefined ? null : normalizeSentryDsn(rawDsn);

	return {
		dsn,
		enableLogs: parsed.SENTRY_ENABLE_LOGS !== "false",
		tracesSampleRate: Number.parseFloat(parsed.SENTRY_TRACES_SAMPLE_RATE),
		logLevel: parsed.SENTRY_LOG_LEVEL,
		captureExpectedErrors: parsed.SENTRY_CAPTURE_EXPECTED_ERRORS === "true",
	};
}

function normalizeSentryDsn(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function requiredString(name: string, minLength = 1): z.ZodType<string> {
	return z.preprocess(
		(value) => (value === undefined ? "" : value),
		z
			.string()
			.trim()
			.min(1, `${name} is required`)
			.min(minLength, `${name} must be at least ${minLength} characters`),
	);
}

function optionalString(): z.ZodType<string | undefined> {
	return z.preprocess((value) => {
		if (typeof value !== "string") {
			return undefined;
		}

		const trimmed = value.trim();
		return trimmed === "" ? undefined : trimmed;
	}, z.string().min(1).optional());
}

function positiveIntegerString(name: string): z.ZodType<string> {
	return z
		.string()
		.trim()
		.refine(
			(value) => {
				const parsed = Number.parseInt(value, 10);
				return String(parsed) === value && parsed > 0;
			},
			{ message: `${name} must be a positive integer` },
		);
}

function sampleRateString(name: string): z.ZodType<string> {
	return z
		.string()
		.trim()
		.refine(
			(value) => {
				if (value === "") {
					return false;
				}

				const parsed = Number(value);
				return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1;
			},
			{ message: `${name} must be a number between 0 and 1` },
		);
}
