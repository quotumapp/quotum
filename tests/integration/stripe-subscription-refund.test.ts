import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { createFakeStripeBillingClient, stripeRefundObject } from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const project = integrationProjectContext();
let context: LocalPostgresContext;
let eventOrder = 100;

describeLocalPostgres(describe, describe.skip)("a refunded subscription payment", () => {
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
	});
	afterAll(async () => {
		await context.sql.close();
	});

	// capability: refund.sync
	it("takes back the refunded share of the period's credits and keeps what was spent", async () => {
		await insertInvoice("in_paid", 1000, "advance");
		await spend(30, "spend-before-refund");
		expect(await available()).toBe("70");

		await refund("re_quarter", 250);

		expect(await invoiceReversed("in_paid")).toBe("250");
		expect(await allocation()).toMatchObject({ reversed: "25.000000000", closed: false });
		expect(await available()).toBe("45");

		// The next refund event of the same refund changes nothing.
		await refund("re_quarter", 250, "refund.updated");
		expect(await invoiceReversed("in_paid")).toBe("250");
		expect(await available()).toBe("45");

		// Refunds add up against the payment.
		await refund("re_second_quarter", 250);
		expect(await invoiceReversed("in_paid")).toBe("500");
		expect(await allocation()).toMatchObject({ reversed: "50.000000000", closed: false });
		expect(await available()).toBe("20");
	});

	// capability: refund.sync
	it("never reverses spent or held quantity, and closes the allocation on a full refund", async () => {
		await insertInvoice("in_full", 1000, "advance");
		await spend(30, "spend-before-full-refund");

		await refund("re_full", 1000);

		expect(await invoiceReversed("in_full")).toBe("1000");
		expect(await allocation()).toMatchObject({
			reversed: "70.000000000",
			consumed: "30.000000000",
			closed: true,
		});
		expect(await available()).toBe("0");
	});

	// capability: refund.sync
	it("refunds more than was paid only up to the payment", async () => {
		await insertInvoice("in_cap", 1000, "advance");

		await refund("re_over", 900);
		await refund("re_rest", 900);

		expect(await invoiceReversed("in_cap")).toBe("1000");
		expect(await allocation()).toMatchObject({ reversed: "100.000000000", closed: true });
	});

	// capability: refund.sync
	it("records but does not apply a refund in another currency", async () => {
		await insertInvoice("in_currency", 1000, "advance");

		await refund("re_eur", 250, "refund.created", "eur");

		expect(await invoiceReversed("in_currency")).toBe("0");
		expect(await allocation()).toMatchObject({ reversed: "0.000000000", closed: false });
		expect(await available()).toBe("100");
		expect(await reversalJobs()).toBe(1);
	});

	// capability: refund.sync
	it("leaves credits of other periods alone when an invoice only billed usage in arrears", async () => {
		await insertInvoice("in_arrears", 1000, "arrears");

		await refund("re_arrears", 500);

		expect(await invoiceReversed("in_arrears")).toBe("500");
		expect(await allocation()).toMatchObject({ reversed: "0.000000000", closed: false });
		expect(await available()).toBe("100");
	});
});

/** The subscription's period allowance, as the sync materializes it. */
async function syncSubscription(): Promise<void> {
	const [subscription] = await context.sql`
		SELECT current_period_start, current_period_end FROM subscriptions
		WHERE external_subscription_id = 'sub_migrate_stripe'
	`;
	if (subscription === undefined) throw new Error("Expected the seeded subscription");
	const id = `evt_refund_${++eventOrder}`;
	await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
		billingAccountId: "migration-stripe",
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

/**
 * A paid invoice of the subscription. An `advance` invoice bills the current period up front; an
 * `arrears` one bills a finished period's usage, which funded no allocation of the current one.
 */
async function insertInvoice(
	externalInvoiceId: string,
	amountPaid: number,
	billing: "advance" | "arrears",
): Promise<void> {
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
					'period', CASE ${billing}
						WHEN 'advance' THEN jsonb_build_object(
							'start', floor(extract(epoch FROM subscription.current_period_start))::bigint,
							'end', floor(extract(epoch FROM subscription.current_period_end))::bigint
						)
						ELSE jsonb_build_object(
							'start', floor(extract(epoch FROM subscription.current_period_start - interval '30 days'))::bigint,
							'end', floor(extract(epoch FROM subscription.current_period_start))::bigint
						)
					END
				)
			)))
		FROM subscriptions subscription
		WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
	`;
}

async function refund(
	id: string,
	amount: number,
	type: "refund.created" | "refund.updated" = "refund.created",
	currency = "usd",
): Promise<void> {
	const service = new StripeBillingService({
		config: {
			projectKey: "acme",
			checkoutSuccessUrl:
				"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
			checkoutCancelUrl: "https://app.integration.test/billing",
			portalReturnUrl: "https://app.integration.test/account/billing",
		},
		client: createFakeStripeBillingClient({
			invoicePayments: { pi_refund: await invoiceOfPayment() },
		}).client,
		repository: context.repository.forProject(project),
	});
	const result = await service.handleVerifiedAppEvent({
		id: `evt_${id}_${++eventOrder}`,
		type,
		created: Math.floor(Date.now() / 1000),
		data: { object: stripeRefundObject({ id, payment_intent: "pi_refund", amount, currency }) },
	});
	expect(result.status).toBe("processed");
}

/** The fake maps the refunded payment to the invoice the test is about. */
async function invoiceOfPayment(): Promise<string> {
	const [invoice] = await context.sql<Array<{ external_invoice_id: string }>>`
		SELECT external_invoice_id FROM billing_invoices ORDER BY created_at DESC LIMIT 1
	`;
	if (invoice === undefined) throw new Error("Expected an invoice");
	return invoice.external_invoice_id;
}

async function invoiceReversed(externalInvoiceId: string): Promise<string> {
	const [row] = await context.sql<Array<{ reversed: string }>>`
		SELECT reversed_amount::text AS reversed FROM billing_invoices
		WHERE external_invoice_id = ${externalInvoiceId}
	`;
	if (row === undefined) throw new Error("Expected the invoice");
	return row.reversed;
}

async function allocation() {
	const [row] = await context.sql<Array<{ reversed: string; consumed: string; closed: boolean }>>`
		SELECT reversed_quantity::text AS reversed, consumed_quantity::text AS consumed,
			reversed_at IS NOT NULL AS closed
		FROM balance_allocations
		WHERE source_kind = 'subscription'
	`;
	if (row === undefined) throw new Error("Expected the plan allowance");
	return row;
}

async function available(): Promise<string | null> {
	return (await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"))
		.available;
}

async function spend(credits: number, key: string): Promise<void> {
	const result = await context.repository.consumeUsage(project, {
		billingAccountId: "migration-stripe",
		featureKey: "model_tokens",
		quantity: String(credits),
		idempotencyKey: key,
	});
	expect(result.allowed).toBe(true);
}

async function reversalJobs(): Promise<number> {
	const [row] = await context.sql<Array<{ count: number }>>`
		SELECT count(*)::int AS count FROM projection_sync_jobs
		WHERE idempotency_key LIKE 'stripe:refund:%:reversal'
	`;
	return row?.count ?? 0;
}
