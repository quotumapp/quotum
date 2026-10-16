import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { stripeCheckoutSessionObject, stripeRefundObject } from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";
import { integrationProjectReadOnlyCredential } from "./helpers/platform-fixture";

const project = integrationProjectContext();
const account = "migration-stripe";
let context: LocalPostgresContext;
let eventOrder = 100;

describeLocalPostgres(describe, describe.skip)("refunds issued through Quotum", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		eventOrder = 100;
		await context.sql`
			INSERT INTO provider_plan_bindings (
				project_id, plan_version_id, store_product_id, provider, channel, status
			)
			SELECT price.project_id, price.plan_version_id, binding.store_product_id,
				'stripe', 'web', 'published'
			FROM price_components price
			JOIN provider_price_bindings binding
				ON binding.project_id = price.project_id AND binding.price_component_id = price.id
			WHERE price.key = 'base'
		`;
		await context.sql`
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval
			)
			SELECT version.project_id, version.id, feature.id, 'allocation', 100, 'month'
			FROM plan_versions version
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'ai_credits'
			WHERE plan.key = 'migration-plan' AND version.version = 1
		`;
		await syncSubscription();
		await insertInvoice("in_paid", 3000);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	// capability: refund.issue
	it("previews and executes a refund, and the credits follow Stripe's refund event", async () => {
		const app = fixture();
		await spend(30, "spend-before-refund");

		const preview = await previewRefund(app, { mode: "full", reason: "Customer asked" });
		expect(preview.status).toBe(200);
		const previewBody = (await preview.json()).data;
		expect(previewBody).toMatchObject({
			action: "refund",
			provider: "stripe",
			currency: "usd",
			amountStatus: "exact",
			refund: {
				targetKind: "subscription_payment",
				externalInvoiceId: "in_paid",
				providerPaymentId: "pi_refund",
				amountPaidMinor: 3000,
				refundedMinor: 0,
				refundableMinor: 3000,
				refundAmountMinor: 3000,
				basis: "full",
				cancelsSubscriptionId: null,
			},
		});

		const executed = await executeRefund(app, previewBody.previewToken, "refund-1");
		expect(executed.status).toBe(200);
		const result = (await executed.json()).data;
		expect(result).toMatchObject({
			kind: "refund_request",
			status: "succeeded",
			amountMinor: 3000,
			currency: "usd",
			providerRefundId: "re_fake_1",
			cancellation: null,
		});
		expect(app.stripe.refundCreates).toHaveLength(1);
		expect(app.stripe.refundCreates[0]).toMatchObject({
			paymentIntentId: "pi_refund",
			amountMinor: 3000,
			metadata: { quotumRefundRequestId: result.refundRequestId },
		});
		expect(app.stripe.refundCreates[0]?.idempotencyKey).toStartWith("billing:refund:commercial:");
		// Nothing is reversed before Stripe reports the money back.
		expect(await available()).toBe("70");

		await deliverRefund(app, "re_fake_1", 3000, result.refundRequestId);

		expect(await available()).toBe("0");
		const listed = await listRefunds(app);
		expect(listed.status).toBe(200);
		expect((await listed.json()).data).toEqual([
			expect.objectContaining({
				id: result.refundRequestId,
				status: "succeeded",
				amountMinor: 3000,
				mode: "full",
				basis: "full",
				reason: "Customer asked",
				providerRefundId: "re_fake_1",
				externalInvoiceId: "in_paid",
			}),
		]);
	});

	// capability: refund.issue
	it("answers a repeated execution with the same result and one Stripe refund", async () => {
		const app = fixture();
		const token = (await (await previewRefund(app, { mode: "full" })).json()).data.previewToken;

		const first = await executeRefund(app, token, "refund-1");
		const again = await executeRefund(app, token, "refund-1");
		const other = await executeRefund(app, token, "refund-2");

		expect(again.status).toBe(200);
		expect((await again.json()).data).toEqual((await first.json()).data);
		expect(other.status).toBe(409);
		expect((await other.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
		expect(app.stripe.refundCreates).toHaveLength(1);
	});

	// capability: refund.issue
	it("holds the payment's one open refund until Stripe settles it", async () => {
		const app = fixture({ refundStatus: "pending" });
		const token = (await (await previewRefund(app, { mode: "full" })).json()).data.previewToken;
		const executed = await executeRefund(app, token, "refund-1");
		const request = (await executed.json()).data;
		expect(request.status).toBe("pending");

		const second = await previewRefund(app, { mode: "full" });
		expect(second.status).toBe(409);
		expect((await second.json()).error.code).toBe("REFUND_ALREADY_OPEN");

		// Stripe reports the payout failed: nothing was returned, so nothing is reversed.
		await deliverRefund(app, "re_fake_1", 3000, request.refundRequestId, {
			status: "failed",
			failure_reason: "expired_or_canceled_card",
		});

		expect(await available()).toBe("100");
		expect((await (await listRefunds(app)).json()).data).toEqual([
			expect.objectContaining({
				status: "failed",
				failureCode: "expired_or_canceled_card",
				providerRefundId: "re_fake_1",
			}),
		]);
		// The slot is free again.
		expect((await previewRefund(app, { mode: "full" })).status).toBe(200);
	});

	// capability: refund.issue
	it("records a refusal from Stripe and answers it again on a repeat", async () => {
		const app = fixture();
		const token = (await (await previewRefund(app, { mode: "full" })).json()).data.previewToken;
		app.stripe.failNext(
			"createRefund",
			Object.assign(new Error("Charge ch_1 has already been refunded."), {
				statusCode: 400,
				type: "StripeInvalidRequestError",
				rawType: "invalid_request_error",
				code: "charge_already_refunded",
			}),
		);

		const refused = await executeRefund(app, token, "refund-1");
		const repeated = await executeRefund(app, token, "refund-1");

		for (const response of [refused, repeated]) {
			expect(response.status).toBe(409);
			const error = (await response.json()).error;
			expect(error.code).toBe("REFUND_REJECTED_BY_PROVIDER");
			expect(JSON.stringify(error)).not.toContain("ch_1");
		}
		expect(app.stripe.refundCreates).toHaveLength(0);
		expect((await (await listRefunds(app)).json()).data).toEqual([
			expect.objectContaining({ status: "failed", failureCode: "charge_already_refunded" }),
		]);
	});

	// capability: refund.issue
	it("resumes an execution whose answer was lost without calling it stale or refunding twice", async () => {
		const app = fixture();
		const token = (await (await previewRefund(app, { mode: "full" })).json()).data.previewToken;
		app.stripe.loseNextRefundCreate();

		const lost = await executeRefund(app, token, "refund-1");
		expect(lost.status).toBe(500);
		// Stripe's refund event arrives before the retry and changes the figures a new preview shows.
		await deliverRefund(app, "re_fake_1", 3000, null);
		expect(await invoiceReversed()).toBe("3000");

		const retried = await executeRefund(app, token, "refund-1");

		expect(retried.status).toBe(200);
		expect((await retried.json()).data).toMatchObject({
			kind: "refund_request",
			providerRefundId: "re_fake_1",
		});
		expect(app.stripe.refundCreates).toHaveLength(1);
	});

	// capability: refund.issue
	it("refuses a preview that Stripe's own refund made stale", async () => {
		const app = fixture();
		const token = (await (await previewRefund(app, { mode: "full" })).json()).data.previewToken;
		await deliverRefund(app, "re_dashboard", 1000, null);

		const executed = await executeRefund(app, token, "refund-1");

		expect(executed.status).toBe(409);
		expect((await executed.json()).error.code).toBe("COMMERCIAL_PREVIEW_STALE");
		expect(app.stripe.refundCreates).toHaveLength(0);
	});

	// capability: refund.issue
	it("ends the subscription with the refund when asked to", async () => {
		const app = fixture();
		const preview = await previewRefund(app, { mode: "full", cancelImmediately: true });
		expect(preview.status).toBe(200);
		const previewBody = (await preview.json()).data;
		expect(previewBody.refund.cancelsSubscriptionId).toBe("sub_migrate_stripe");
		expect(previewBody.cancellation).toMatchObject({ action: "cancel" });

		const executed = await executeRefund(app, previewBody.previewToken, "refund-1");

		expect(executed.status).toBe(200);
		expect((await executed.json()).data).toMatchObject({
			kind: "refund_request",
			status: "succeeded",
			cancellation: {
				kind: "subscription_cancellation",
				action: "cancel",
				externalSubscriptionId: "sub_migrate_stripe",
				effectiveMode: "immediate",
			},
		});
		expect(app.stripe.refundCreates).toHaveLength(1);
		expect(app.stripe.subscriptionCancellations).toHaveLength(1);
	});

	// capability: refund.issue
	it("refunds a one-time purchase and marks it refunded when Stripe confirms", async () => {
		const app = fixture();
		const service = stripeService(app);
		await service?.handleVerifiedAppEvent(
			verified("checkout.session.completed", stripeCheckoutSessionObject(), "evt_checkout"),
		);
		const [purchase] = await context.sql<Array<{ id: string; transaction_id: string }>>`
			SELECT id, transaction_id FROM purchases WHERE provider = 'stripe'
		`;
		if (purchase === undefined) throw new Error("Expected the purchase");

		const preview = await testRequest(
			app.app,
			"/v1/billing-accounts/integration_user/commercial-actions/preview",
			{
				method: "POST",
				headers: { ...app.authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					intent: {
						kind: "refund",
						target: { type: "purchase", purchaseId: purchase.id },
						mode: "full",
						reason: "Duplicate purchase",
					},
				}),
			},
		);
		expect(preview.status).toBe(200);
		const body = (await preview.json()).data;
		expect(body.refund).toMatchObject({
			targetKind: "purchase",
			purchaseId: purchase.id,
			providerPaymentId: purchase.transaction_id,
			basis: "full",
		});

		const executed = await testRequest(
			app.app,
			"/v1/billing-accounts/integration_user/commercial-actions",
			{
				method: "POST",
				headers: {
					...app.authHeaders(),
					"content-type": "application/json",
					"idempotency-key": "refund-purchase",
				},
				body: JSON.stringify({ previewToken: body.previewToken }),
			},
		);
		expect(executed.status).toBe(200);
		expect(app.stripe.refundCreates[0]).toMatchObject({ paymentIntentId: purchase.transaction_id });

		await service?.handleVerifiedAppEvent(
			verified(
				"refund.created",
				stripeRefundObject({
					id: "re_fake_1",
					payment_intent: purchase.transaction_id,
					amount: body.refund.refundAmountMinor,
					metadata: { quotumRefundRequestId: (await executed.json()).data.refundRequestId },
				}),
				"evt_purchase_refund",
			),
		);
		const [row] = await context.sql<Array<{ status: string }>>`
			SELECT status FROM purchases WHERE id = ${purchase.id}
		`;
		expect(row?.status).toBe("refunded");
	});

	// capability: refund.issue
	it("is a mutation a read-only credential cannot reach, though it can read the refunds", async () => {
		const app = fixture();
		const readOnly = { authorization: `Bearer ${integrationProjectReadOnlyCredential()}` };

		const preview = await testRequest(
			app.app,
			`/v1/billing-accounts/${account}/commercial-actions/preview`,
			{
				method: "POST",
				headers: { ...readOnly, "content-type": "application/json" },
				body: JSON.stringify({ intent: intent({ mode: "full" }) }),
			},
		);
		const list = await testRequest(app.app, `/v1/billing-accounts/${account}/refunds`, {
			headers: readOnly,
		});

		expect(preview.status).toBe(403);
		expect((await preview.json()).error.code).toBe("READ_ONLY_CREDENTIAL");
		expect(list.status).toBe(200);
	});
});

function fixture(options: { refundStatus?: string } = {}) {
	return createIntegrationApp({
		env: context.env,
		repository: context.repository,
		stripeInvoicePayments: { pi_refund: "in_paid" },
		...(options.refundStatus === undefined ? {} : { stripeRefundStatus: options.refundStatus }),
	});
}

type Fixture = ReturnType<typeof fixture>;

function stripeService(app: Fixture) {
	return app.projectProviderServices.acme?.stripeBillingService;
}

function intent(overrides: Record<string, unknown>) {
	return {
		kind: "refund",
		target: { type: "subscription_payment", externalSubscriptionId: "sub_migrate_stripe" },
		reason: "Customer asked",
		...overrides,
	};
}

async function previewRefund(app: Fixture, overrides: Record<string, unknown>) {
	return await testRequest(app.app, `/v1/billing-accounts/${account}/commercial-actions/preview`, {
		method: "POST",
		headers: { ...app.authHeaders(), "content-type": "application/json" },
		body: JSON.stringify({ intent: intent(overrides) }),
	});
}

async function executeRefund(app: Fixture, previewToken: string, key: string) {
	return await testRequest(app.app, `/v1/billing-accounts/${account}/commercial-actions`, {
		method: "POST",
		headers: {
			...app.authHeaders(),
			"content-type": "application/json",
			"idempotency-key": key,
		},
		body: JSON.stringify({ previewToken }),
	});
}

async function listRefunds(app: Fixture) {
	return await testRequest(app.app, `/v1/billing-accounts/${account}/refunds`, {
		headers: app.authHeaders(),
	});
}

function verified(type: string, object: Record<string, unknown>, id: string) {
	return { id, type, created: Math.floor(Date.now() / 1000), data: { object } };
}

/** Stripe's `refund.created` for a refund, as the webhook delivers it. */
async function deliverRefund(
	app: Fixture,
	refundId: string,
	amount: number,
	requestId: string | null,
	overrides: Record<string, unknown> = {},
) {
	const result = await stripeService(app)?.handleVerifiedAppEvent(
		verified(
			"refund.updated",
			stripeRefundObject({
				id: refundId,
				payment_intent: "pi_refund",
				amount,
				...(requestId === null ? {} : { metadata: { quotumRefundRequestId: requestId } }),
				...overrides,
			}),
			`evt_${refundId}_${++eventOrder}`,
		),
	);
	expect(result?.status === "processed" || result?.status === "ignored").toBe(true);
}

async function syncSubscription(): Promise<void> {
	const [subscription] = await context.sql`
		SELECT current_period_start, current_period_end FROM subscriptions
		WHERE external_subscription_id = 'sub_migrate_stripe'
	`;
	if (subscription === undefined) throw new Error("Expected the seeded subscription");
	const id = `evt_refund_${++eventOrder}`;
	await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
		billingAccountId: account,
		stripeCustomerId: "cus_migration",
		stripeSubscriptionId: "sub_migrate_stripe",
		invoiceId: null,
		externalProductId: "prod_migrate_v1_base",
		externalPriceId: "price_migrate_v1_base",
		subscriptionStatus: "active",
		purchasedAt: subscription.current_period_start,
		startsAt: subscription.current_period_start,
		expiresAt: subscription.current_period_end,
		currentPeriodStart: subscription.current_period_start,
		currentPeriodEnd: subscription.current_period_end,
		autoRenew: true,
		items: [
			{
				providerSubscriptionItemId: "si_migrate_base",
				externalProductId: "prod_migrate_v1_base",
				externalPriceId: "price_migrate_v1_base",
				quantity: 1,
			},
			{
				providerSubscriptionItemId: "si_migrate_seats",
				externalProductId: "prod_migrate_v1_seats",
				externalPriceId: "price_migrate_v1_seats",
				quantity: 7,
			},
		],
		rawPayload: {},
		eventType: "customer.subscription.updated",
		externalEventId: id,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${id}:projection`,
		providerEventCreated: eventOrder,
	});
}

/** A paid invoice billing the subscription's current period up front. */
async function insertInvoice(externalInvoiceId: string, amountPaid: number): Promise<void> {
	await context.sql`
		INSERT INTO billing_invoices (
			project_id, customer_id, subscription_id, external_invoice_id, external_subscription_id,
			status, amount_paid, currency, paid_at, provider_created_at, last_provider_event_created,
			raw_payload
		)
		SELECT subscription.project_id, subscription.customer_id, subscription.id,
			${externalInvoiceId}, subscription.external_subscription_id, 'paid', ${amountPaid}, 'usd',
			subscription.current_period_start, subscription.current_period_start, 1,
			jsonb_build_object('lines', jsonb_build_object('data', jsonb_build_array(
				jsonb_build_object(
					'id', 'il_1',
					'amount', ${amountPaid}::int,
					'period', jsonb_build_object(
						'start', floor(extract(epoch FROM subscription.current_period_start))::bigint,
						'end', floor(extract(epoch FROM subscription.current_period_end))::bigint
					)
				)
			)))
		FROM subscriptions subscription
		WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
	`;
}

async function invoiceReversed(): Promise<string> {
	const [row] = await context.sql<Array<{ reversed: string }>>`
		SELECT reversed_amount::text AS reversed FROM billing_invoices WHERE external_invoice_id = 'in_paid'
	`;
	if (row === undefined) throw new Error("Expected the invoice");
	return row.reversed;
}

async function available(): Promise<string | null> {
	return (await context.repository.getMeteringBalance(project, account, "ai_credits")).available;
}

async function spend(credits: number, key: string): Promise<void> {
	const result = await context.repository.consumeUsage(project, {
		billingAccountId: account,
		featureKey: "model_tokens",
		quantity: String(credits),
		idempotencyKey: key,
	});
	expect(result.allowed).toBe(true);
}
