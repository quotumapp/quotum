import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import { executeCommercial } from "../../src/app/commercial-actions";
import type { StripeBillingServiceLike } from "../../src/app/types";
import type { BillingLogger } from "../../src/observability/logger";
import { StripeBillingService } from "../../src/providers/stripe/service";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { storedCommercialPreview } from "../helpers/commercial-preview";
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
			projectInstanceKey: "acme",
			projectionUrl: "https://acme.example.com",
			projectionSecret: "acme-projection-secret",
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
		environment: "test",
		release: null,
		enableLogs: true,
		tracesSampleRate: 0.01,
		logLevel: "warn",
		captureExpectedErrors: false,
	},
};

const json = { authorization: "Bearer secret", "content-type": "application/json" };
const project = projectInstanceContext("acme");
const embedded = { sessionId: "cs_embedded", clientSecret: "cs_embedded_secret", duplicate: false };

function stripeService(calls: unknown[]): StripeBillingServiceLike {
	return {
		async createCheckoutSession(input) {
			calls.push(input);
			return embedded;
		},
		async createRecurringCheckoutSession(input) {
			calls.push(input);
			return embedded;
		},
		async previewCommercialAction(input) {
			calls.push(input);
			return storedCommercialPreview().preview;
		},
		async executeCommercialAction(input) {
			calls.push(input);
			return { kind: "checkout", ...embedded, promotionRedemption: null };
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
				clientSecret: "cs_embedded_secret",
			};
		},
		async expireCheckoutSession(input) {
			return {
				sessionId: input.sessionId,
				status: "expired",
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

function appWith(calls: unknown[]) {
	return withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [project],
				credentials: { secret: "acme" },
			}),
			stripeBillingService: stripeService(calls),
			commercialPreviewReader: {
				getCommercialActionPreview: async () => storedCommercialPreview(),
			},
		}),
	);
}

describe("embedded Checkout routes", () => {
	it("passes uiMode to product and plan Checkout and answers the client secret", async () => {
		const calls: unknown[] = [];
		const app = appWith(calls);

		for (const target of [{ productKey: "credits_100" }, { planKey: "pro" }]) {
			const response = await testRequest(
				app,
				"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
				{
					method: "POST",
					headers: { ...json, "idempotency-key": "buy-1" },
					body: JSON.stringify({ ...target, uiMode: "embedded" }),
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true, data: embedded });
		}
		expect(calls).toMatchObject([
			{ billingAccountId: "user_1", productKey: "credits_100", uiMode: "embedded" },
			{ billingAccountId: "user_1", planKey: "pro", uiMode: "embedded" },
		]);
	});

	it("refuses an unknown uiMode before the provider", async () => {
		const calls: unknown[] = [];
		const response = await testRequest(
			appWith(calls),
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: json,
				body: JSON.stringify({ productKey: "credits_100", uiMode: "popup" }),
			},
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
		expect(calls).toEqual([]);
	});

	it("accepts uiMode on an intro-price checkout preview and answers the secret on execution", async () => {
		const calls: unknown[] = [];
		const app = appWith(calls);
		const intent = {
			kind: "checkout_plan",
			planKey: "pro",
			quantities: {},
			email: "buyer@example.com",
			promotionCode: "INTRO-50",
			expiresAt: 1_900_000_000,
			uiMode: "embedded",
		};

		const preview = await testRequest(
			app,
			"/v1/billing-accounts/user_1/commercial-actions/preview",
			{ method: "POST", headers: json, body: JSON.stringify({ provider: "stripe", intent }) },
		);
		const execute = await testRequest(app, "/v1/billing-accounts/user_1/commercial-actions", {
			method: "POST",
			headers: { ...json, "idempotency-key": "intro-1" },
			body: JSON.stringify({ previewToken: storedCommercialPreview().preview.previewToken }),
		});

		expect(preview.status).toBe(200);
		expect(execute.status).toBe(200);
		expect(await execute.json()).toEqual({
			success: true,
			data: { kind: "checkout", ...embedded, promotionRedemption: null },
		});
		expect(calls[0]).toEqual({ billingAccountId: "user_1", intent });
	});
});

describe("embedded Checkout status routes", () => {
	it("answers an open embedded session's client secret and null once it is expired", async () => {
		const app = appWith([]);
		const path = "/v1/billing-accounts/user_1/providers/stripe/checkout-sessions/cs_embedded";

		const status = await testRequest(app, path, { headers: { authorization: "Bearer secret" } });
		const expired = await testRequest(app, `${path}/expire`, {
			method: "POST",
			headers: { authorization: "Bearer secret" },
		});

		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_embedded",
				status: "open",
				paymentStatus: "unpaid",
				customerEmail: null,
				productKey: null,
				clientSecret: "cs_embedded_secret",
			},
		});
		expect(expired.status).toBe(200);
		expect((await expired.json()).data).toMatchObject({ status: "expired", clientSecret: null });
	});
});

describe("embedded Checkout secret in logs", () => {
	const secret = "cs_embedded_secret_never_logged";

	function recordingLogger(lines: unknown[]): BillingLogger {
		return {
			info: (message, context) => lines.push({ message, context }),
			warn: (message, context) => lines.push({ message, context }),
			error: (message, error, context) =>
				lines.push({ message, error: String(error), stack: (error as Error)?.stack, context }),
		};
	}

	/** The real service over a Stripe double whose embedded session stays open. */
	function realService(lines: unknown[], failRetrieve: () => boolean) {
		const receipts = new Map<string, { externalSessionId: string | null; requestHash: string }>();
		return new StripeBillingService({
			config: {
				checkoutSuccessUrl: "https://app.acme.com/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.acme.com/billing",
				portalReturnUrl: "https://app.acme.com/account",
			},
			logger: recordingLogger(lines),
			client: {
				createCustomer: async () => ({ id: "cus_1" }),
				createCheckoutSession: async () => ({
					id: "cs_embedded",
					url: null,
					client_secret: secret,
				}),
				retrieveCheckoutSession: async (sessionId: string) => {
					if (failRetrieve()) throw new Error("Stripe is unavailable");
					return {
						id: sessionId,
						status: "open",
						payment_status: "unpaid",
						ui_mode: "embedded_page",
						client_reference_id: "user_1",
						metadata: { billingAccountId: "user_1" },
						client_secret: secret,
					};
				},
			},
			repository: {
				getStripeWebStoreProductByKey: async () => ({
					storeProductId: "store_product_credits_100",
					productId: "product_credits_100",
					productKey: "credits_100",
					productType: "consumable",
					creditAmount: 100,
					externalProductId: "prod_credits_100",
					externalPriceId: "price_credits_100",
					billingPeriod: "one_time",
					billingPeriodCount: 1,
					currency: "usd",
					priceAmount: 499,
				}),
				getStripeProviderCustomer: async () => "cus_1",
				prepareStripeCheckoutRequest: async (input: {
					idempotencyKey: string;
					requestHash: string;
				}) => {
					const receipt = receipts.get(input.idempotencyKey);
					return receipt === undefined
						? { status: "creating", externalSessionId: null, sessionUrl: null }
						: { status: "created", externalSessionId: receipt.externalSessionId, sessionUrl: null };
				},
				completeStripeCheckoutRequest: async (input: {
					idempotencyKey: string;
					requestHash: string;
					externalSessionId: string;
				}) => {
					receipts.set(input.idempotencyKey, input);
					return {
						status: "created",
						externalSessionId: input.externalSessionId,
						sessionUrl: null,
					};
				},
			},
		} as unknown as ConstructorParameters<typeof StripeBillingService>[0]);
	}

	it("answers the secret to the backend and writes it to no log line, even on failure", async () => {
		const lines: unknown[] = [];
		let failRetrieve = false;
		const app = withOpenApiAssertions(
			createApp({
				env,
				logger: recordingLogger(lines),
				connections: fixtureConnections(env.connectionFixtures),
				projectContextResolver: projectContextResolver({
					contexts: [project],
					credentials: { secret: "acme" },
				}),
				stripeBillingService: realService(lines, () => failRetrieve),
			}),
		);
		const create = () =>
			testRequest(app, "/v1/billing-accounts/user_1/providers/stripe/checkout-sessions", {
				method: "POST",
				headers: { ...json, "idempotency-key": "buy-1" },
				body: JSON.stringify({ productKey: "credits_100", uiMode: "embedded" }),
			});
		const status = () =>
			testRequest(
				app,
				"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions/cs_embedded",
				{ headers: { authorization: "Bearer secret" } },
			);

		expect((await (await create()).json()).data).toMatchObject({ clientSecret: secret });
		expect((await (await create()).json()).data).toMatchObject({
			clientSecret: secret,
			duplicate: true,
		});
		expect((await (await status()).json()).data).toMatchObject({ clientSecret: secret });
		failRetrieve = true;
		expect((await status()).status).toBe(500);
		expect((await create()).status).toBe(500);

		expect(lines.length).toBeGreaterThan(0);
		expect(JSON.stringify(lines)).not.toContain(secret);
	});
});

describe("commercial execution replay", () => {
	function replay(
		executionResult: NonNullable<ReturnType<typeof storedCommercialPreview>["executionResult"]>,
	) {
		const stored = storedCommercialPreview();
		stored.intent = { kind: "checkout_product", productKey: "credits_100", uiMode: "embedded" };
		stored.status = "executed";
		stored.executionIdempotencyKey = "purchase";
		stored.executionResult = executionResult;
		const calls: unknown[] = [];
		const input = {
			project,
			billingAccountId: "user_1",
			previewToken: stored.preview.previewToken,
			idempotencyKey: "purchase",
			reader: { getCommercialActionPreview: async () => stored },
			services: {
				appleStoreKitService: async () => null,
				googlePlayBillingService: async () => null,
				stripeBillingService: async () => stripeService(calls),
			},
		};
		return { input, calls };
	}

	it("asks the provider again for an embedded Checkout, whose secret is not stored", async () => {
		const { input, calls } = replay({
			kind: "checkout",
			sessionId: "cs_embedded",
			duplicate: false,
		});

		expect(await executeCommercial(input)).toEqual({
			kind: "checkout",
			...embedded,
			promotionRedemption: null,
		});
		expect(calls).toHaveLength(1);
	});

	it("answers a hosted Checkout from storage and refuses an embedded one where answers are stored", async () => {
		const hosted = {
			kind: "checkout" as const,
			sessionId: "cs_hosted",
			url: "https://checkout.stripe.com/c/pay/cs_hosted",
			duplicate: false,
		};
		const stored = replay(hosted);
		expect(await executeCommercial(stored.input)).toEqual(hosted);
		expect(stored.calls).toEqual([]);

		const refused = replay({ kind: "checkout", sessionId: "cs_embedded", duplicate: false });
		await expect(
			executeCommercial({ ...refused.input, hostedCheckoutOnly: true }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		expect(refused.calls).toEqual([]);
	});
});
