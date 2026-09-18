import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import { requireProviderMethod } from "../../src/app/provider-services";
import type { StripeBillingServiceLike } from "../../src/app/types";
import { NotConfiguredError } from "../../src/billing/errors";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	postgresPreparedStatements: true,
	authMode: "api_key",
	operatorApiKey: "operator-secret-key",
	trustGatewayProjectHeader: false,
	connectionFixtures: [
		{
			projectInstanceKey: "voysee",
			projectionUrl: "https://voysee.example.com",
			projectionSecret: "voysee-projection-secret",
		},
	],
	runtimeEnvironment: "development",
	workerId: "worker-a",
	workerPollIntervalMs: 5000,
	projectionSyncMaxAttempts: 10,
	storeEventReplayMaxAttempts: 10,
	storeEventReplayPollIntervalMs: 5000,
	subscriptionReconciliationMaxAttempts: 10,
	subscriptionReconciliationPollIntervalMs: 60000,
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
};

/** Only the methods every Stripe service has; each guarded method is absent. */
function requiredOnlyStripeService(): StripeBillingServiceLike {
	return {
		async createCheckoutSession() {
			return { sessionId: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test" };
		},
		async createPortalSession() {
			return { url: "https://billing.stripe.com/p/session" };
		},
		async getCheckoutSessionStatus(input) {
			return {
				sessionId: input.sessionId,
				status: "open",
				paymentStatus: "unpaid",
				customerEmail: null,
				productKey: null,
			};
		},
		async handleWebhook() {
			return { status: "processed" };
		},
	};
}

function appWith(stripeBillingService: StripeBillingServiceLike) {
	return withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("voysee")],
				credentials: { secret: "voysee" },
			}),
			stripeBillingService,
		}),
	);
}

const json = { authorization: "Bearer secret", "content-type": "application/json" };
const previewToken = "11111111-1111-4111-8111-111111111111";

const guardedRoutes: Array<{
	adapterMethod: string;
	message: string;
	path: string;
	init?: RequestInit;
}> = [
	{
		adapterMethod: "reads.catalog",
		message: "Stripe catalog is not available",
		path: "/v1/catalog",
	},
	{
		adapterMethod: "reads.billingAccount",
		message: "Stripe billing account is not available",
		path: "/v1/billing-accounts/user_1/billing-account",
	},
	{
		adapterMethod: "commercial.preview",
		message: "Commercial previews are not available",
		path: "/v1/billing-accounts/user_1/commercial-actions/preview",
		init: {
			method: "POST",
			headers: json,
			body: JSON.stringify({ intent: { kind: "checkout_product", productKey: "credits_100" } }),
		},
	},
	{
		adapterMethod: "commercial.execute",
		message: "Commercial actions are not available",
		path: "/v1/billing-accounts/user_1/commercial-actions",
		init: {
			method: "POST",
			headers: { ...json, "idempotency-key": "execute-1" },
			body: JSON.stringify({ previewToken }),
		},
	},
	{
		adapterMethod: "checkout.createPlan",
		message: "Plan Checkout is not available",
		path: "/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
		init: { method: "POST", headers: json, body: JSON.stringify({ planKey: "pro" }) },
	},
	{
		adapterMethod: "commercial.requestChange",
		message: "Subscription changes are not available",
		path: "/v1/billing-accounts/user_1/subscriptions/sub_1/changes",
		init: {
			method: "POST",
			headers: { ...json, "idempotency-key": "change-1" },
			body: JSON.stringify({ targetPlanKey: "pro" }),
		},
	},
	{
		adapterMethod: "checkout.expire",
		message: "Checkout expiration is unavailable",
		path: "/v1/billing-accounts/user_1/providers/stripe/checkout-sessions/cs_1/expire",
		init: { method: "POST", headers: { authorization: "Bearer secret" } },
	},
];

describe("Stripe method guards", () => {
	it("rejects each route whose Stripe service lacks the method as not configured", async () => {
		const app = appWith(requiredOnlyStripeService());

		for (const route of guardedRoutes) {
			const response = await testRequest(
				app,
				route.path,
				route.init ?? { headers: { authorization: "Bearer secret" } },
			);

			expect(response.status, route.path).toBe(503);
			expect(await response.json(), route.path).toEqual({
				success: false,
				error: {
					code: "BILLING_PROVIDER_NOT_CONFIGURED",
					message: route.message,
					details: { provider: "stripe", adapterMethod: route.adapterMethod },
				},
			});
		}
	});

	it("rejects a missing idempotency key before checking the Stripe service", async () => {
		const app = appWith(requiredOnlyStripeService());

		for (const [path, body, message] of [
			[
				"/v1/billing-accounts/user_1/commercial-actions",
				{ previewToken },
				"Invalid commercial action execution",
			],
			[
				"/v1/billing-accounts/user_1/subscriptions/sub_1/changes",
				{ targetPlanKey: "pro" },
				"Invalid Stripe subscription change request",
			],
		] as const) {
			const response = await testRequest(app, path, {
				method: "POST",
				headers: json,
				body: JSON.stringify(body),
			});

			expect(response.status, path).toBe(400);
			expect(await response.json(), path).toEqual({
				success: false,
				error: { code: "INVALID_REQUEST", message },
			});
		}
	});

	it("calls a present method on its service", async () => {
		const catalog = { schemaVersion: 1 as const, plans: [], oneTimePurchases: [] };
		const stripe: StripeBillingServiceLike & { catalog: typeof catalog } = {
			...requiredOnlyStripeService(),
			catalog,
			async getCatalog() {
				return this.catalog;
			},
		};
		const getCatalog = requireProviderMethod(
			stripe,
			"stripe",
			"reads.catalog",
			"Stripe catalog is not available",
		);

		expect(await getCatalog()).toBe(catalog);
		const response = await testRequest(appWith(stripe), "/v1/catalog", {
			headers: { authorization: "Bearer secret" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: catalog });
	});

	it("throws a 503 not-configured error that names the adapter method", () => {
		let thrown: unknown;
		try {
			requireProviderMethod(
				requiredOnlyStripeService(),
				"stripe",
				"checkout.expire",
				"Checkout expiration is unavailable",
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(NotConfiguredError);
		const error = thrown as NotConfiguredError;
		expect({
			message: error.message,
			code: error.code,
			status: error.status,
			classification: error.classification,
			exposeMessage: error.exposeMessage,
			details: error.details,
		}).toEqual({
			message: "Checkout expiration is unavailable",
			code: "BILLING_PROVIDER_NOT_CONFIGURED",
			status: 503,
			classification: "not_configured",
			exposeMessage: true,
			details: { provider: "stripe", adapterMethod: "checkout.expire" },
		});
	});
});
