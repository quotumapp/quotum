import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createFakeStripeBillingClient,
	stripeSubscriptionObject,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;
let service: StripeBillingService;
const start = Math.floor(Date.now() / 1000) - 86400;
const end = start + 30 * 86400;
const metadata = {
	billingAccountId: "integration_user",
	externalProductId: "prod_stripe_premium",
	externalPriceId: "price_premium_monthly",
	productKey: "premium_monthly",
	purchaseKind: "subscription",
};
const event = (type: string, object: unknown, created: number, id: string) => ({
	id,
	type,
	created,
	data: { object },
});
const subscription = (extra = {}) =>
	stripeSubscriptionObject({ current_period_start: start, current_period_end: end, ...extra });
const invoice = (extra = {}) => ({
	id: "in_audit",
	object: "invoice",
	customer: "cus_integration",
	subscription: "sub_1",
	status: "paid",
	created: start,
	amount_paid: 999,
	currency: "usd",
	parent: { subscription_details: { subscription: "sub_1", metadata } },
	lines: {
		data: [
			{
				id: "il_audit",
				parent: {
					subscription_item_details: { subscription: "sub_1", subscription_item: "si_integration" },
				},
				pricing: {
					price_details: { product: "prod_stripe_premium", price: "price_premium_monthly" },
				},
				period: { start, end },
			},
		],
	},
	...extra,
});

localDescribe("Stripe invoice snapshots", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		service = new StripeBillingService({
			config: {
				projectKey: "voysee",
				checkoutSuccessUrl: "https://example.com/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://example.com/cancel",
				portalReturnUrl: "https://example.com/billing",
			},
			repository: context.repository.forProject(integrationProjectContext("voysee")),
			client: createFakeStripeBillingClient().client,
		});
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("must keep the new price when an upgrade invoice retains original Checkout metadata", async () => {
		await context.sql`INSERT INTO store_products(project_id, product_id, provider, channel, external_product_id, external_price_id, billing_period, currency, price_amount) SELECT project_id, product_id, provider, channel, 'prod_upgrade', 'price_upgrade', billing_period, currency, 1999 FROM store_products WHERE external_price_id='price_premium_monthly'`;
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.updated",
				subscription({
					items: {
						data: [
							{
								id: "si_integration",
								quantity: 1,
								price: { id: "price_upgrade", product: "prod_upgrade" },
								current_period_start: start,
								current_period_end: end,
							},
						],
					},
				}),
				start + 100,
				"evt_upgrade",
			),
		);
		expect(
			(await context.sql`SELECT external_price_id FROM subscriptions`)[0].external_price_id,
		).toBe("price_upgrade");
		await service.handleVerifiedAppEvent(
			event(
				"invoice.paid",
				invoice({
					lines: {
						data: [
							{
								parent: { subscription_item_details: { subscription: "sub_1" } },
								pricing: { price_details: { product: "prod_upgrade", price: "price_upgrade" } },
								period: { start, end },
							},
						],
					},
				}),
				start + 101,
				"evt_upgrade_invoice",
			),
		);
		expect(
			(await context.sql`SELECT external_price_id FROM subscriptions`)[0].external_price_id,
		).toBe("price_upgrade");
	});

	it("must preserve cancellation and trial state when a paid invoice arrives", async () => {
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.updated",
				subscription({
					status: "trialing",
					cancel_at_period_end: true,
					trial_start: start,
					trial_end: end,
				}),
				start + 100,
				"evt_cancel",
			),
		);
		expect(
			(
				await context.sql`SELECT cancel_at_period_end,auto_renew,trial_end_at FROM subscriptions`
			)[0],
		).toMatchObject({ cancel_at_period_end: true, auto_renew: false });
		await service.handleVerifiedAppEvent(
			event("invoice.paid", invoice({ amount_paid: 0 }), start + 101, "evt_trial_invoice"),
		);
		expect(
			(
				await context.sql`SELECT cancel_at_period_end,auto_renew,trial_end_at FROM subscriptions`
			)[0],
		).toMatchObject({
			cancel_at_period_end: true,
			auto_renew: false,
			trial_end_at: new Date(end * 1000),
		});
	});

	it("must record invoice history even when a newer subscription event arrived first", async () => {
		await service.handleVerifiedAppEvent(
			event("customer.subscription.updated", subscription(), start + 200, "evt_newer_subscription"),
		);
		await service.handleVerifiedAppEvent(
			event("invoice.paid", invoice(), start + 100, "evt_older_invoice"),
		);
		expect((await context.sql`SELECT external_invoice_id FROM billing_invoices`).length).toBe(1);
	});

	it("must not revive an expired subscription when an old usage invoice is paid", async () => {
		const oldStart = start - 60 * 86400;
		const oldEnd = start - 30 * 86400;
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.deleted",
				subscription({
					status: "canceled",
					current_period_start: oldStart,
					current_period_end: oldEnd,
				}),
				start + 100,
				"evt_expired",
			),
		);
		expect((await context.sql`SELECT status,expires_at FROM subscriptions`)[0].status).toBe(
			"expired",
		);
		await service.handleVerifiedAppEvent(
			event(
				"invoice.paid",
				invoice({
					metadata: { billingAccountId: "integration_user", usageInvoicePeriodId: "period-audit" },
					lines: {
						data: [
							{
								parent: {
									invoice_item_details: { subscription: "sub_1", invoice_item: "ii_usage" },
								},
								pricing: { price_details: { product: "prod_stripe_premium" } },
								period: { start: oldStart, end: oldEnd },
							},
						],
					},
				}),
				start + 101,
				"evt_old_usage_paid",
			),
		);
		expect((await context.sql`SELECT status,expires_at FROM subscriptions`)[0]).toMatchObject({
			status: "expired",
			expires_at: new Date(oldEnd * 1000),
		});
	});

	it("must not revert the current price when an older price invoice is paid after an upgrade", async () => {
		await context.sql`INSERT INTO store_products(project_id, product_id, provider, channel, external_product_id, external_price_id, billing_period, currency, price_amount) SELECT project_id, product_id, provider, channel, 'prod_upgrade', 'price_upgrade', billing_period, currency, 1999 FROM store_products WHERE external_price_id='price_premium_monthly'`;
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.updated",
				subscription({
					items: {
						data: [
							{
								id: "si_integration",
								quantity: 1,
								price: { id: "price_upgrade", product: "prod_upgrade" },
								current_period_start: start,
								current_period_end: end,
							},
						],
					},
				}),
				start + 100,
				"evt_new_price",
			),
		);
		expect(
			(await context.sql`SELECT external_price_id FROM subscriptions`)[0].external_price_id,
		).toBe("price_upgrade");
		// This is a newly emitted payment event for the old invoice, not delayed delivery of an old event.
		await service.handleVerifiedAppEvent(
			event("invoice.paid", invoice(), start + 101, "evt_old_price_paid_now"),
		);
		expect(
			(await context.sql`SELECT external_price_id FROM subscriptions`)[0].external_price_id,
		).toBe("price_upgrade");
	});

	it("must not replace the active subscription period when an overdue old-period invoice is paid", async () => {
		await service.handleVerifiedAppEvent(
			event("customer.subscription.updated", subscription(), start + 100, "evt_current_period"),
		);
		const oldStart = start - 60 * 86400;
		const oldEnd = start - 30 * 86400;
		await service.handleVerifiedAppEvent(
			event(
				"invoice.paid",
				invoice({
					created: oldStart,
					lines: {
						data: [
							{
								parent: {
									subscription_item_details: {
										subscription: "sub_1",
										subscription_item: "si_integration",
									},
								},
								pricing: {
									price_details: { product: "prod_stripe_premium", price: "price_premium_monthly" },
								},
								period: { start: oldStart, end: oldEnd },
							},
						],
					},
				}),
				start + 101,
				"evt_overdue_paid_now",
			),
		);
		expect(
			(
				await context.sql`SELECT current_period_start,current_period_end,expires_at FROM subscriptions`
			)[0],
		).toMatchObject({
			current_period_start: new Date(start * 1000),
			current_period_end: new Date(end * 1000),
			expires_at: new Date(end * 1000),
		});
	});

	it("must choose the debit rather than the credit in a proration-only invoice", async () => {
		await context.sql`INSERT INTO store_products(project_id, product_id, provider, channel, external_product_id, external_price_id, billing_period, currency, price_amount) SELECT project_id, product_id, provider, channel, 'prod_upgrade', 'price_upgrade', billing_period, currency, 1999 FROM store_products WHERE external_price_id='price_premium_monthly'`;
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.updated",
				subscription({
					items: {
						data: [
							{
								id: "si_integration",
								quantity: 1,
								price: { id: "price_upgrade", product: "prod_upgrade" },
								current_period_start: start,
								current_period_end: end,
							},
						],
					},
				}),
				start + 100,
				"evt_proration_upgrade",
			),
		);
		const line = (price: string, product: string, amount: number) => ({
			amount,
			parent: {
				subscription_item_details: {
					subscription: "sub_1",
					subscription_item: "si_integration",
					proration: true,
				},
			},
			pricing: { price_details: { product, price } },
			period: { start: start + 100, end },
		});
		// Debit was created after the removed-price credit and appears first in reverse chronology.
		await service.handleVerifiedAppEvent(
			event(
				"invoice.paid",
				invoice({
					billing_reason: "subscription_update",
					lines: {
						data: [
							line("price_upgrade", "prod_upgrade", 1500),
							line("price_premium_monthly", "prod_stripe_premium", -500),
						],
					},
				}),
				start + 101,
				"evt_proration_paid",
			),
		);
		expect(
			(await context.sql`SELECT external_price_id FROM subscriptions`)[0].external_price_id,
		).toBe("price_upgrade");
	});
	it("does not let a payment hide an earlier-created subscription upgrade", async () => {
		await context.sql`INSERT INTO store_products(project_id, product_id, provider, channel, external_product_id, external_price_id, billing_period, currency, price_amount) SELECT project_id, product_id, provider, channel, 'prod_upgrade', 'price_upgrade', billing_period, currency, 1999 FROM store_products WHERE external_price_id='price_premium_monthly'`;
		await service.handleVerifiedAppEvent(
			event("customer.subscription.updated", subscription(), start + 100, "evt_initial"),
		);
		await service.handleVerifiedAppEvent(
			event("invoice.paid", invoice(), start + 200, "evt_payment"),
		);
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.updated",
				subscription({
					status: "past_due",
					items: {
						data: [
							{
								id: "si_integration",
								quantity: 1,
								price: { id: "price_upgrade", product: "prod_upgrade" },
								current_period_start: start,
								current_period_end: end,
							},
						],
					},
				}),
				start + 150,
				"evt_delayed_upgrade",
			),
		);
		expect(
			(
				await context.sql`SELECT external_price_id,status,last_provider_event_created::text FROM subscriptions`
			)[0],
		).toEqual({
			external_price_id: "price_upgrade",
			status: "active",
			last_provider_event_created: String(start + 150),
		});
	});

	it("records an obsolete-price invoice without looking up its retired catalog mapping", async () => {
		await service.handleVerifiedAppEvent(
			event("customer.subscription.updated", subscription(), start + 100, "evt_initial"),
		);
		const before = (
			await context.sql`SELECT product_id,store_product_id,external_price_id,current_period_start,current_period_end,raw_state,last_provider_event_created FROM subscriptions`
		)[0];
		const obsolete = invoice({
			lines: {
				data: [
					{
						parent: { subscription_item_details: { subscription: "sub_1" } },
						pricing: { price_details: { product: "prod_retired", price: "price_retired" } },
						period: { start, end },
					},
				],
			},
		});
		await service.handleVerifiedAppEvent(
			event("invoice.paid", obsolete, start + 101, "evt_obsolete_invoice"),
		);
		await service.handleVerifiedAppEvent(
			event("invoice.paid", obsolete, start + 101, "evt_obsolete_invoice"),
		);
		expect(
			(
				await context.sql`SELECT product_id,store_product_id,external_price_id,current_period_start,current_period_end,raw_state,last_provider_event_created FROM subscriptions`
			)[0],
		).toEqual(before);
		expect([
			...(await context.sql`SELECT status,amount_paid::integer FROM billing_invoices`),
		]).toEqual([{ status: "paid", amount_paid: 999 }]);
	});

	it("does not regress a recovered payment state on an older invoice event", async () => {
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.updated",
				subscription({ status: "past_due" }),
				start + 100,
				"evt_past_due",
			),
		);
		await service.handleVerifiedAppEvent(
			event("invoice.paid", invoice(), start + 200, "evt_recovered"),
		);
		await service.handleVerifiedAppEvent(
			event(
				"invoice.payment_failed",
				invoice({ status: "open", amount_paid: 0 }),
				start + 150,
				"evt_old_failure",
			),
		);
		expect((await context.sql`SELECT status FROM subscriptions`)[0].status).toBe("active");
		expect(
			(await context.sql`SELECT status,amount_paid::integer FROM billing_invoices`)[0],
		).toEqual({ status: "paid", amount_paid: 999 });
	});
});
