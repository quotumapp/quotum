import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { createLocalProjectionReceiver } from "../helpers/projection-receiver";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectTableCounts } from "./helpers/db-assertions";
import {
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeRefundObject,
	stripeSubscriptionObject,
} from "./helpers/fake-provider-clients";
import { makeSubscriptionExpired } from "./helpers/job-time-travel";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	runProjectionWorkerOnce,
	runSubscriptionReconciliationWorkerOnce,
} from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Cross-provider journeys integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("combines Apple premium and Stripe credits for one customer", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "voysee-projection-secret" });
		const env = withProjectionUrl(receiver.url);

		try {
			const fixture = createIntegrationApp({
				env,
				repository: context.repository,
				stripeEvent: stripeEvent(
					"checkout.session.completed",
					stripeCheckoutSessionObject(),
					"evt_checkout",
				),
			});
			await createAppleAccountToken(fixture);

			expect((await verifyAppleSubscription(fixture)).status).toBe(200);
			expect((await postStripeWebhook(fixture, { id: "evt_checkout" })).status).toBe(200);

			const entitlementResponse = await fixture.app.request(
				"/v1/billing-accounts/integration_user/entitlements",
				{ headers: fixture.authHeaders("voysee") },
			);
			expect((await entitlementResponse.json()).data.entitlements).toHaveLength(1);
			await expectProviderSummary(context.sql, {
				customers: 1,
				provider_customers: 2,
				purchases: 2,
				subscriptions: 1,
			});

			const result = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(2, 1000);

			expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0 });
			expect(receiver.requests.map((request) => request.body.idempotencyKey).sort()).toEqual([
				"apple:200000000000001:purchase_verified",
				"stripe:payment:pi_integration:projection",
			]);
			expect(
				receiver.requests.find(
					(request) => request.body.idempotencyKey === "stripe:payment:pi_integration:projection",
				)?.body.purchase,
			).toMatchObject({
				provider: "stripe",
				productKey: "echo_credits_10",
				creditAmount: 10,
			});
		} finally {
			receiver.stop();
		}
	});

	it("migrates premium from expired Apple subscription to Stripe subscription", async () => {
		const appleFixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await createAppleAccountToken(appleFixture);
		expect((await verifyAppleSubscription(appleFixture)).status).toBe(200);
		await makeSubscriptionExpired(context.sql, "voysee", "100000000000001");

		const reconciliation = await runSubscriptionReconciliationWorkerOnce({
			env: context.env,
			repository: context.repository,
			providers: { apple: null, google: null, stripe: null },
		});
		expect(reconciliation.expiredSubscriptions).toBe(1);
		await expectPremiumState(context.sql, {
			activeProviders: [],
			statuses: ["apple:expired"],
		});

		const stripeFixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"customer.subscription.created",
				stripeSubscriptionObject(),
				"evt_subscription_created",
			),
		});
		expect(
			(await postStripeWebhook(stripeFixture, { id: "evt_subscription_created" })).status,
		).toBe(200);

		await expectPremiumState(context.sql, {
			activeProviders: ["stripe"],
			statuses: ["apple:expired", "stripe:active"],
		});
		const entitlements = await stripeFixture.app.request(
			"/v1/billing-accounts/integration_user/entitlements",
			{ headers: stripeFixture.authHeaders("voysee") },
		);
		expect((await entitlements.json()).data.entitlements).toHaveLength(1);
	});

	it("keeps Stripe refunds scoped to credits while Apple premium remains active", async () => {
		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_checkout",
			),
		});
		await createAppleAccountToken(checkout);
		expect((await verifyAppleSubscription(checkout)).status).toBe(200);
		expect((await postStripeWebhook(checkout, { id: "evt_checkout" })).status).toBe(200);

		const refund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent("refund.created", stripeRefundObject(), "evt_refund"),
		});
		expect((await postStripeWebhook(refund, { id: "evt_refund" })).status).toBe(200);

		await expectStripePurchaseRefunded(context.sql);
		await expectPremiumState(context.sql, {
			activeProviders: ["apple"],
			statuses: ["apple:active"],
		});
		const entitlements = await refund.app.request(
			"/v1/billing-accounts/integration_user/entitlements",
			{
				headers: refund.authHeaders("voysee"),
			},
		);
		expect((await entitlements.json()).data.entitlements).toHaveLength(1);
	});

	it("links the same billing account independently across Apple, Google, and Stripe", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		await createAppleAccountToken(fixture);
		const google = await fixture.app.request(
			"/v1/billing-accounts/integration_user/providers/google/account-link",
			{ headers: fixture.authHeaders("voysee") },
		);
		expect(google.status).toBe(200);
		const checkout = await fixture.app.request(
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					...fixture.authHeaders("voysee"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ productKey: "echo_credits_10" }),
			},
		);
		expect(checkout.status).toBe(200);

		await expectProviderSummary(context.sql, {
			customers: 1,
			provider_customers: 3,
			purchases: 0,
			subscriptions: 0,
		});
		await expectLinkedProviders(context.sql, ["apple", "google", "stripe"]);
	});
});

function withProjectionUrl(projectionUrl: string): LocalPostgresContext["env"] {
	return {
		...context.env,
		projects: context.env.projects.map((project) =>
			project.key === "voysee" ? { ...project, projectionUrl } : project,
		),
	};
}

async function createAppleAccountToken(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<void> {
	const response = await fixture.app.request(
		"/v1/billing-accounts/integration_user/providers/apple/account-token",
		{ headers: fixture.authHeaders("voysee") },
	);
	const body = await response.json();
	expect(response.status).toBe(200);
	fixture.apple.setAppAccountToken(body.data.appAccountToken);
}

async function verifyAppleSubscription(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders("voysee"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "apple",
			billingAccountId: "integration_user",
			transactionId: "200000000000001",
		}),
	});
}

async function postStripeWebhook(
	fixture: ReturnType<typeof createIntegrationApp>,
	body: Record<string, unknown>,
): Promise<Response> {
	return await fixture.app.request("/v1/projects/voysee/webhooks/stripe", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": "sig_test",
		},
		body: JSON.stringify(body),
	});
}

async function expectProviderSummary(
	sql: SQL,
	expected: {
		customers: number;
		provider_customers: number;
		purchases: number;
		subscriptions: number;
	},
): Promise<void> {
	await expectTableCounts(sql, expected);
}

async function expectPremiumState(
	sql: SQL,
	expected: { activeProviders: string[]; statuses: string[] },
): Promise<void> {
	const entitlementRows = await sql<{ provider: string }[]>`
		SELECT subscriptions.provider
		FROM entitlements
		JOIN subscriptions ON subscriptions.id = entitlements.source_subscription_id
			AND subscriptions.project_id = entitlements.project_id
		JOIN projects ON projects.id = entitlements.project_id
		WHERE projects.key = 'voysee'
			AND entitlements.entitlement_key = 'premium'
			AND entitlements.active = true
		ORDER BY subscriptions.provider
	`;
	expect(entitlementRows.map((row) => row.provider)).toEqual(expected.activeProviders);

	const subscriptionRows = await sql<{ provider: string; status: string }[]>`
		SELECT provider, status
		FROM subscriptions
		JOIN projects ON projects.id = subscriptions.project_id
		WHERE projects.key = 'voysee'
		ORDER BY provider, status
	`;
	expect(subscriptionRows.map((row) => `${row.provider}:${row.status}`)).toEqual(expected.statuses);
}

async function expectStripePurchaseRefunded(sql: SQL): Promise<void> {
	const rows = await sql<
		{ provider: string; status: string; reversed_credit_amount: number; purchase_kind: string }[]
	>`
		SELECT provider, status, reversed_credit_amount, purchase_kind
		FROM purchases
		JOIN projects ON projects.id = purchases.project_id
		WHERE projects.key = 'voysee'
			AND provider = 'stripe'
	`;
	expect(rows).toEqual([
		{
			provider: "stripe",
			status: "refunded",
			reversed_credit_amount: 10,
			purchase_kind: "consumable",
		},
	]);
}

async function expectLinkedProviders(sql: SQL, providers: string[]): Promise<void> {
	const rows = await sql<{ provider: string }[]>`
		SELECT provider_customers.provider
		FROM provider_customers
		JOIN customers ON customers.id = provider_customers.customer_id
			AND customers.project_id = provider_customers.project_id
		JOIN projects ON projects.id = customers.project_id
		WHERE projects.key = 'voysee'
			AND customers.billing_account_id = 'integration_user'
		ORDER BY provider_customers.provider
	`;
	expect(rows.map((row) => row.provider)).toEqual(providers);
}
