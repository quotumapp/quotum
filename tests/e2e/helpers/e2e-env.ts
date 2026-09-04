import { createHmac } from "node:crypto";
import { createSanitizedProcessEnv } from "../../../scripts/lib/sanitized-env";

export const e2eApiKey = testCredential("voysee") ?? "voysee-unit-test-placeholder";
export const e2eOperatorKey = "voysee-e2e-operator-key";
export const e2eProjectionSecret = "voysee-e2e-projection-secret";
export const e2eStripeWebhookSecret = "whsec_voysee_e2e";

export function e2eProjectRuntimeJson(receiverUrl = "http://127.0.0.1:9"): string {
	return JSON.stringify(
		testProjectInstanceKeys().map((projectInstanceKey) => ({
			projectInstanceKey,
			projectionUrl: receiverUrl,
			projectionSecret: e2eProjectionSecret,
			stripe: {
				secretKey: "sk_test_e2e_dummy",
				webhookSecret: e2eStripeWebhookSecret,
				checkoutSuccessUrl: "https://app.e2e.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.e2e.test/billing",
				portalReturnUrl: "https://app.e2e.test/account/billing",
			},
		})),
	);
}

function testProjectInstanceKeys(): string[] {
	const serialized = process.env.BILLING_TEST_PROJECT_CONTEXTS_JSON;
	if (serialized === undefined) return ["voysee", "wiseley"];

	const value = JSON.parse(serialized) as unknown;
	if (!Array.isArray(value)) {
		throw new Error("BILLING_TEST_PROJECT_CONTEXTS_JSON must be an array");
	}
	const keys = value.map((context) =>
		context !== null && typeof context === "object"
			? (context as Record<string, unknown>).projectInstanceKey
			: undefined,
	);
	if (keys.some((key) => typeof key !== "string" || key.trim() === "")) {
		throw new Error("BILLING_TEST_PROJECT_CONTEXTS_JSON contains an invalid project instance");
	}
	return keys as string[];
}

export function e2eServiceEnv({
	postgresUri,
	receiverUrl,
	port,
	overrides = {},
}: {
	postgresUri: string;
	receiverUrl?: string;
	port?: number;
	overrides?: Record<string, string>;
}): NodeJS.ProcessEnv {
	return {
		...createSanitizedProcessEnv(),
		NODE_ENV: "test",
		BILLING_AUTH_MODE: "api_key",
		BILLING_ENV: "development",
		BILLING_OPERATOR_API_KEY: e2eOperatorKey,
		BILLING_PROJECT_RUNTIME_JSON: e2eProjectRuntimeJson(receiverUrl),
		BILLING_TRUST_GATEWAY_PROJECT_HEADER: "false",
		BILLING_WORKER_POLL_INTERVAL_MS: "250",
		BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS: "250",
		BILLING_SUBSCRIPTION_RECONCILIATION_POLL_INTERVAL_MS: "3600000",
		POSTGRES_URI: postgresUri,
		SENTRY_DSN: "",
		...(port === undefined ? {} : { PORT: String(port) }),
		...overrides,
	};
}

function testCredential(projectInstanceKey: string): string | null {
	const serialized = process.env.BILLING_TEST_PROJECT_CREDENTIALS_JSON;
	if (serialized === undefined) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		throw new Error("BILLING_TEST_PROJECT_CREDENTIALS_JSON must be valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("BILLING_TEST_PROJECT_CREDENTIALS_JSON must be an object");
	}
	const credential = (parsed as Record<string, unknown>)[projectInstanceKey];
	if (typeof credential !== "string" || credential.trim() === "") {
		throw new Error(`Missing test credential for project instance ${projectInstanceKey}`);
	}
	return credential;
}

export function signStripeWebhook(payload: string): string {
	const timestamp = Math.floor(Date.now() / 1000);
	const signature = createHmac("sha256", e2eStripeWebhookSecret)
		.update(`${timestamp}.${payload}`)
		.digest("hex");
	return `t=${timestamp},v1=${signature}`;
}
