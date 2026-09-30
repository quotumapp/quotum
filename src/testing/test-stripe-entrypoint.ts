import { registerQuotumProcessShutdown } from "../composition/public-runtime";
import { createBillingReadinessCheck } from "../composition/runtime-readiness";
import { merchantPlatformEnabled } from "../platform/config";
import {
	FakeStripeBillingClient,
	type FakeStripeBillingClientOptions,
} from "../providers/stripe/testing/fake-client";
import { createBillingRuntime } from "../runtime";
import { fixtureConnections, loadFixtureEnv } from "./connection-fixtures";
import { MerchantCaptureMailer } from "./merchant-fakes";

if (process.env.BILLING_ENV !== "test" || process.env.BILLING_TEST_FAKE_STRIPE !== "true") {
	throw new Error(
		"Fake Stripe entrypoint requires BILLING_ENV=test and BILLING_TEST_FAKE_STRIPE=true",
	);
}

const env = loadFixtureEnv();
// One fake per connection, so sessions a checkout creates are still known to later lookups.
const fakeStripeClients = new Map<string, FakeStripeBillingClient>();

const runtime = createBillingRuntime(env, {
	connections: fixtureConnections(env.connectionFixtures),
	projectionFetch: globalThis.fetch,
	stripeClientFactory: (config) => {
		const key = `${config.secretKey}:${config.connectedAccountId ?? ""}`;
		const existing = fakeStripeClients.get(key);
		if (existing !== undefined) return existing;
		const client = new FakeStripeBillingClient(config, fakeStripeOptions());
		fakeStripeClients.set(key, client);
		return client;
	},
	readinessCheck: createBillingReadinessCheck(),
	merchant: merchantPlatformEnabled() ? { mailer: new MerchantCaptureMailer() } : null,
});

registerQuotumProcessShutdown(runtime);
await runtime.start();
export default runtime.app;

function fakeStripeOptions(): FakeStripeBillingClientOptions {
	const behavior = process.env.BILLING_TEST_FAKE_STRIPE_PAYMENT_BEHAVIOR;
	if (
		behavior !== undefined &&
		behavior !== "succeeded" &&
		behavior !== "action_required" &&
		behavior !== "retryable_failure"
	) {
		throw new Error("BILLING_TEST_FAKE_STRIPE_PAYMENT_BEHAVIOR is invalid");
	}
	const rawPrices = process.env.BILLING_TEST_FAKE_STRIPE_PRICE_AMOUNTS_JSON;
	return {
		paymentBehavior: behavior,
		defaultPaymentMethod:
			process.env.BILLING_TEST_FAKE_STRIPE_DEFAULT_PAYMENT_METHOD === "missing" ? null : undefined,
		priceAmountsMinor: rawPrices === undefined ? undefined : parsePriceAmounts(rawPrices),
	};
}

function parsePriceAmounts(raw: string): Record<string, number> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("BILLING_TEST_FAKE_STRIPE_PRICE_AMOUNTS_JSON must be valid JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("BILLING_TEST_FAKE_STRIPE_PRICE_AMOUNTS_JSON must be an object");
	}
	const result: Record<string, number> = {};
	for (const [priceId, amount] of Object.entries(value)) {
		if (
			priceId.trim() === "" ||
			typeof amount !== "number" ||
			!Number.isSafeInteger(amount) ||
			amount < 0
		) {
			throw new Error("Fake Stripe price amounts must be non-negative safe integers");
		}
		result[priceId] = amount;
	}
	return result;
}
