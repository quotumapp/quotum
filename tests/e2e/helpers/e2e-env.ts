import { createHmac } from "node:crypto";
import { createSanitizedProcessEnv } from "../../../scripts/lib/sanitized-env";

export const e2eApiKey = "voysee-e2e-api-key";
export const e2eOperatorKey = "voysee-e2e-operator-key";
export const e2eProjectionSecret = "voysee-e2e-projection-secret";
export const e2eStripeWebhookSecret = "whsec_voysee_e2e";

export function e2eProjectsJson(receiverUrl = "http://127.0.0.1:9"): string {
	return JSON.stringify([
		{
			key: "voysee",
			apiKey: e2eApiKey,
			projectionUrl: receiverUrl,
			projectionSecret: e2eProjectionSecret,
			stripe: {
				secretKey: "sk_test_e2e_dummy",
				webhookSecret: e2eStripeWebhookSecret,
				checkoutSuccessUrl: "https://app.e2e.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.e2e.test/billing",
				portalReturnUrl: "https://app.e2e.test/account/billing",
			},
		},
	]);
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
		BILLING_PROJECTS_JSON: e2eProjectsJson(receiverUrl),
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

export function signStripeWebhook(payload: string): string {
	const timestamp = Math.floor(Date.now() / 1000);
	const signature = createHmac("sha256", e2eStripeWebhookSecret)
		.update(`${timestamp}.${payload}`)
		.digest("hex");
	return `t=${timestamp},v1=${signature}`;
}
