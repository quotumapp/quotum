import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import { commercialActionExecuteBodySchema } from "../../src/app/customer-routes";
import type { AppDependencies, StripeBillingServiceLike } from "../../src/app/types";
import type { AffiliateServiceLike, AffiliateSummary } from "../../src/billing/affiliates";
import { BillingError } from "../../src/billing/errors";
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
const session = { sessionId: "cs_1", url: "https://checkout.stripe.com/c/1", duplicate: false };
const snapshot = {
	billingAccountId: "user_1",
	generatedAt: "2026-05-31T00:00:00.000Z",
	entitlements: [],
};
const summary: AffiliateSummary = {
	affiliateKey: "acme-partner",
	customers: 2,
	revenue: [
		{ provider: "stripe", currency: "usd", payments: 3, amountMinor: 5000, estimated: false },
		{ provider: "google", currency: null, payments: 1, amountMinor: null, estimated: true },
	],
};

interface Fixture {
	recorded: Array<{ billingAccountId: string; affiliateKey: string }>;
	app: ReturnType<typeof withOpenApiAssertions>;
}

function fixture(
	options: {
		failCheckout?: boolean;
		execution?: Record<string, unknown>;
		dependencies?: Partial<AppDependencies>;
	} = {},
): Fixture {
	const recorded: Fixture["recorded"] = [];
	const affiliateService: AffiliateServiceLike = {
		async recordAffiliateKey(_project, input) {
			recorded.push(input);
		},
		async getAffiliateSummary(_project, affiliateKey) {
			return { ...summary, affiliateKey };
		},
		async listAffiliateCustomers() {
			return {
				items: [{ billingAccountId: "user_1", affiliateKeySetAt: "2026-10-31T00:00:00.000000Z" }],
				nextCursor: "00000000-0000-7000-8000-000000000001",
			};
		},
	};
	const checkout = async () => {
		if (options.failCheckout === true) {
			throw new BillingError("Provider refused", "PROVIDER_REQUEST_FAILED", 502);
		}
		return session;
	};
	const stripe = {
		createCheckoutSession: checkout,
		createRecurringCheckoutSession: checkout,
		async executeCommercialAction() {
			return options.execution ?? { kind: "checkout", ...session, promotionRedemption: null };
		},
	} as unknown as StripeBillingServiceLike;
	const app = withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [project],
				credentials: {
					secret: "acme",
					"read-key": { projectInstanceKey: "acme", access: "read_only" },
				},
			}),
			affiliateService,
			stripeBillingService: stripe,
			projectProviderServices: { acme: { paddleBillingService: stripe } },
			appleStoreKitService: {
				verifyPurchase: async () => snapshot,
			} as unknown as AppDependencies["appleStoreKitService"],
			googlePlayBillingService: {
				verifyPurchase: async () => snapshot,
			} as unknown as AppDependencies["googlePlayBillingService"],
			commercialPreviewReader: {
				getCommercialActionPreview: async () => storedCommercialPreview(),
			},
			...options.dependencies,
		}),
	);
	return { recorded, app };
}

const stripeCheckout = "/v1/billing-accounts/user_1/providers/stripe/checkout-sessions";
const paddleCheckout = "/v1/billing-accounts/user_1/providers/paddle/checkout-sessions";
const commercialActions = "/v1/billing-accounts/user_1/commercial-actions";
const previewToken = storedCommercialPreview().preview.previewToken;
const paymentSetup = {
	kind: "payment_setup",
	setupId: "setup_1",
	status: "awaiting_customer",
	sessionId: "cs_setup",
	url: "https://checkout.stripe.com/c/setup",
	expiresAt: "2026-11-01T00:00:00.000Z",
	reused: false,
};

function post(
	app: Fixture["app"],
	path: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = { "idempotency-key": "buy-1" },
) {
	return testRequest(app, path, {
		method: "POST",
		headers: { ...json, ...headers },
		body: JSON.stringify(body),
	});
}

describe("affiliate key on purchase calls", () => {
	it("records the key from a Stripe checkout, for a product and for a plan", async () => {
		for (const target of [{ productKey: "credits_100" }, { planKey: "pro" }]) {
			const { app, recorded } = fixture();
			const response = await post(app, stripeCheckout, { ...target, affiliateKey: "acme-partner" });
			expect(response.status).toBe(200);
			expect(recorded).toEqual([{ billingAccountId: "user_1", affiliateKey: "acme-partner" }]);
		}
	});

	it("records the key from a Paddle checkout", async () => {
		const { app, recorded } = fixture();
		const response = await post(app, paddleCheckout, {
			productKey: "credits_100",
			affiliateKey: "acme.partner_1",
		});
		expect(response.status).toBe(200);
		expect(recorded).toEqual([{ billingAccountId: "user_1", affiliateKey: "acme.partner_1" }]);
	});

	it("records the key from an Apple and a Google verification", async () => {
		const purchases = [
			{ provider: "apple", billingAccountId: "user_1", transactionId: "1000" },
			{
				provider: "google",
				billingAccountId: "user_1",
				purchaseKind: "subscription",
				purchaseToken: "token",
			},
		];
		for (const purchase of purchases) {
			const { app, recorded } = fixture();
			const response = await post(
				app,
				"/v1/purchases/verify",
				{ ...purchase, affiliateKey: "acme-partner" },
				{},
			);
			expect(response.status).toBe(200);
			expect(recorded).toEqual([{ billingAccountId: "user_1", affiliateKey: "acme-partner" }]);
		}
	});

	it("records the key when a commercial action starts a purchase, and only then", async () => {
		const body = { previewToken, affiliateKey: "acme-partner" };
		const named = [{ billingAccountId: "user_1", affiliateKey: "acme-partner" }];
		const planSetup = {
			...paymentSetup,
			plan: { planKey: "pro", planVersionId: "plan_version_1", status: "pending" },
		};
		const purchases: Array<[Record<string, unknown> | undefined, number, unknown[]]> = [
			[undefined, 200, named],
			[planSetup, 200, named],
			[{ ...paymentSetup, plan: null }, 200, []],
			[
				{
					kind: "subscription_change",
					changeId: "change_1",
					status: "pending",
					effectiveMode: "immediate",
					effectiveAt: "2026-11-01T00:00:00.000Z",
				},
				202,
				[],
			],
		];
		for (const [execution, status, expected] of purchases) {
			const { app, recorded } = fixture({ execution });
			expect((await post(app, commercialActions, body)).status).toBe(status);
			expect(recorded).toEqual(expected as Fixture["recorded"]);
		}
	});

	it("records nothing when the purchase fails or names no affiliate", async () => {
		const failed = fixture({ failCheckout: true });
		const response = await post(failed.app, stripeCheckout, {
			productKey: "credits_100",
			affiliateKey: "acme-partner",
		});
		expect(response.status).toBe(502);
		expect(failed.recorded).toEqual([]);

		const plain = fixture();
		expect((await post(plain.app, stripeCheckout, { productKey: "credits_100" })).status).toBe(200);
		expect(plain.recorded).toEqual([]);
	});

	it("refuses a key that cannot name a partner in a URL", async () => {
		const { app, recorded } = fixture();
		for (const affiliateKey of ["", "with space", "a/b", "x".repeat(201)]) {
			const response = await post(app, stripeCheckout, {
				productKey: "credits_100",
				affiliateKey,
			});
			expect([affiliateKey, response.status]).toEqual([affiliateKey, 400]);
		}
		expect(recorded).toEqual([]);
	});

	it("keeps the affiliate key off the console's commercial action body", () => {
		expect(
			commercialActionExecuteBodySchema.safeParse({ previewToken, affiliateKey: "acme-partner" })
				.success,
		).toBe(false);
	});

	it("still refuses unknown fields on commercial action execution", async () => {
		const { app } = fixture();
		const response = await post(app, commercialActions, { previewToken, other: true });
		expect(response.status).toBe(400);
	});
});

describe("affiliate reads", () => {
	it("answers the summary and the customer list to a read-only key", async () => {
		const { app } = fixture();
		const headers = { authorization: "Bearer read-key" };

		const read = await testRequest(app, "/v1/affiliates/acme-partner/summary", { headers });
		expect(read.status).toBe(200);
		expect((await read.json()) as unknown).toEqual({ success: true, data: summary });

		const list = await testRequest(app, "/v1/affiliates/acme-partner/customers?limit=1", {
			headers,
		});
		expect(list.status).toBe(200);
		expect((await list.json()) as unknown).toEqual({
			success: true,
			data: [{ billingAccountId: "user_1", affiliateKeySetAt: "2026-10-31T00:00:00.000000Z" }],
			pagination: { nextCursor: "00000000-0000-7000-8000-000000000001" },
		});
	});

	it("refuses a bad key, cursor or limit", async () => {
		const { app } = fixture();
		const headers = { authorization: "Bearer secret" };
		for (const path of [
			"/v1/affiliates/with%20space/summary",
			"/v1/affiliates/acme-partner/customers?cursor=not-a-uuid",
			"/v1/affiliates/acme-partner/customers?limit=101",
		]) {
			const response = await testRequest(app, path, { headers });
			expect([path, response.status]).toEqual([path, 400]);
		}
	});
});
