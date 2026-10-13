import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import { StripeBillingService } from "../../src/providers/stripe/service";
import type { DeepPartial } from "../helpers/deep-partial";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createFakeStripeBillingClient,
	stripeSubscriptionObject,
	stripeSubscriptionPeriod,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const account = "integration_user";
let context: LocalPostgresContext;
let service: StripeBillingService;
const start = Math.floor(Date.now() / 1000) - 86400;
const end = start + 30 * 86400;
const metadata = {
	billingAccountId: account,
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
const invoice = (id: string, created: number, extra: DeepPartial<Stripe.Invoice> = {}) =>
	({
		id,
		object: "invoice",
		customer: "cus_integration",
		status: "paid",
		created,
		number: `ACME-${id}`,
		total: 999,
		amount_paid: 999,
		amount_due: 0,
		currency: "usd",
		hosted_invoice_url: `https://invoice.stripe.com/i/acct_1/${id}`,
		invoice_pdf: `https://pay.stripe.com/invoice/${id}/pdf`,
		parent: { subscription_details: { subscription: "sub_1", metadata } },
		lines: {
			has_more: false,
			data: [
				{
					id: `il_${id}`,
					description: "Premium monthly",
					amount: 999,
					quantity: 1,
					parent: {
						subscription_item_details: {
							subscription: "sub_1",
							subscription_item: "si_integration",
						},
					},
					pricing: {
						price_details: { product: "prod_stripe_premium", price: "price_premium_monthly" },
					},
					period: { start, end },
				},
			],
		},
		...extra,
	}) satisfies DeepPartial<Stripe.Invoice>;

localDescribe("invoice reads", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		service = new StripeBillingService({
			config: {
				projectKey: "acme",
				checkoutSuccessUrl: "https://example.com/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://example.com/cancel",
				portalReturnUrl: "https://example.com/billing",
			},
			repository: context.repository.forProject(integrationProjectContext("acme")),
			client: createFakeStripeBillingClient().client,
		});
	});
	afterAll(async () => {
		await context.sql.close();
	});

	function http() {
		const { app, authHeaders } = createIntegrationApp(context);
		return (path: string, init: RequestInit = {}) =>
			testRequest(app, path, { ...init, headers: { ...authHeaders(), ...init.headers } });
	}

	/** Two paid invoices created in the same second and one whose payment failed, newest last. */
	async function seedInvoices(): Promise<void> {
		await service.handleVerifiedAppEvent(
			event(
				"customer.subscription.updated",
				stripeSubscriptionObject({ ...stripeSubscriptionPeriod(start, end) }),
				start + 10,
				"evt_subscription",
			),
		);
		for (const id of ["in_a", "in_b"]) {
			await service.handleVerifiedAppEvent(
				event("invoice.paid", invoice(id, start + 100), start + 100, `evt_${id}`),
			);
		}
		await service.handleVerifiedAppEvent(
			event(
				"invoice.payment_failed",
				invoice("in_c", start + 200, { status: "open", amount_paid: 0, amount_due: 999 }),
				start + 200,
				"evt_in_c",
			),
		);
	}

	async function pageIds(
		input: { status?: "paid" | "open"; limit: number },
		cursor: { createdAt: string; id: string } | null = null,
	) {
		const page = await context.repository.listInvoices(project, {
			billingAccountId: account,
			...input,
			cursor,
		});
		return { ids: page.items.map((item) => item.externalInvoiceId), next: page.nextCursor, page };
	}

	it("pages newest first without skipping or repeating invoices created in the same second", async () => {
		await seedInvoices();

		const first = await pageIds({ limit: 2 });
		expect(first.ids[0]).toBe("in_c");
		expect(first.next).not.toBeNull();
		const second = await pageIds({ limit: 2 }, first.next);
		expect(second.ids).toHaveLength(1);
		expect(second.next).toBeNull();
		expect([...first.ids, ...second.ids].sort()).toEqual(["in_a", "in_b", "in_c"]);

		const paid = await pageIds({ status: "paid", limit: 10 });
		expect(paid.ids.sort()).toEqual(["in_a", "in_b"]);
		const open = await pageIds({ status: "open", limit: 10 });
		expect(open.ids).toEqual(["in_c"]);
		expect(open.page.items[0]).toMatchObject({
			status: "open",
			amountPaidMinor: 0,
			amountDueMinor: 999,
			totalMinor: 999,
			number: "ACME-in_c",
		});
	});

	it("serves the list and one invoice with lines and links over HTTP", async () => {
		await seedInvoices();
		const request = http();

		const listed = await request(`/v1/billing-accounts/${account}/invoices?limit=1`);
		expect(listed.status).toBe(200);
		const body = await listed.json();
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({ externalInvoiceId: "in_c", status: "open" });
		expect(typeof body.pagination.nextCursor).toBe("string");
		expect(JSON.stringify(body)).not.toContain("invoice.stripe.com");

		const next = await request(
			`/v1/billing-accounts/${account}/invoices?limit=5&cursor=${body.pagination.nextCursor}`,
		);
		expect(next.status).toBe(200);
		expect((await next.json()).data).toHaveLength(2);

		const id = (await pageIds({ status: "open", limit: 1 })).page.items[0]?.id;
		const detail = await request(`/v1/billing-accounts/${account}/invoices/${id}`);
		expect(detail.status).toBe(200);
		const invoiceBody = (await detail.json()).data;
		expect(invoiceBody).toMatchObject({
			externalInvoiceId: "in_c",
			externalSubscriptionId: "sub_1",
			periodStart: new Date(start * 1000).toISOString(),
			periodEnd: new Date(end * 1000).toISOString(),
			linesTruncated: false,
			hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/in_c",
			invoicePdfUrl: "https://pay.stripe.com/invoice/in_c/pdf",
		});
		expect(invoiceBody.lines).toEqual([
			{
				id: "il_in_c",
				description: "Premium monthly",
				amountMinor: 999,
				quantity: 1,
				periodStart: new Date(start * 1000).toISOString(),
				periodEnd: new Date(end * 1000).toISOString(),
				externalPriceId: "price_premium_monthly",
				externalProductId: "prod_stripe_premium",
				proration: null,
			},
		]);
	});

	it("keeps invoices of other accounts and unknown accounts unreachable", async () => {
		await seedInvoices();
		await context.repository.usageApi.createAccount(project, "other_account");
		const request = http();
		const id = (await pageIds({ limit: 1 })).page.items[0]?.id;

		const crossAccount = await request(`/v1/billing-accounts/other_account/invoices/${id}`);
		expect(crossAccount.status).toBe(404);
		expect((await crossAccount.json()).error.code).toBe("INVOICE_NOT_FOUND");

		const otherList = await request("/v1/billing-accounts/other_account/invoices");
		expect(otherList.status).toBe(200);
		expect((await otherList.json()).data).toEqual([]);

		const unknown = await request("/v1/billing-accounts/never_created/invoices");
		expect(unknown.status).toBe(404);
		expect((await unknown.json()).error.code).toBe("BILLING_ACCOUNT_NOT_FOUND");
	});

	it("lists an automatic top-up invoice as its own kind with only the recorded columns", async () => {
		await seedInvoices();
		await context.sql`
			INSERT INTO billing_invoices (
				project_id, customer_id, subscription_id, external_invoice_id, external_subscription_id,
				status, amount_paid, currency, paid_at, provider_created_at, last_provider_event_created,
				raw_payload
			)
			SELECT project_id, id, NULL, 'in_topup', NULL, 'paid', 500, 'usd', now(), now() + interval '1 day', 0,
				'{"source":"auto_topup","autoTopupJobId":"job-1","externalPaymentId":"pi_1"}'::jsonb
			FROM customers WHERE billing_account_id = ${account}
		`;
		const request = http();

		const listed = await request(`/v1/billing-accounts/${account}/invoices?limit=1`);
		expect(listed.status).toBe(200);
		const [topup] = (await listed.json()).data;
		expect(topup).toMatchObject({
			externalInvoiceId: "in_topup",
			kind: "auto_topup",
			subscriptionId: null,
			externalSubscriptionId: null,
			status: "paid",
			amountPaidMinor: 500,
			number: null,
			totalMinor: null,
			periodStart: null,
		});
		// The job and payment identifiers in the stored payload are internal.
		expect(JSON.stringify(topup)).not.toContain("job-1");
		expect(JSON.stringify(topup)).not.toContain("pi_1");

		const detail = await request(`/v1/billing-accounts/${account}/invoices/${topup.id}`);
		expect((await detail.json()).data).toMatchObject({ kind: "auto_topup", lines: [] });
		const subscription = await pageIds({ status: "open", limit: 1 });
		expect(subscription.page.items[0]?.kind).toBe("subscription");
	});

	it("still lists an invoice whose payload was scrubbed, with the payload fields empty", async () => {
		await seedInvoices();
		await context.sql`UPDATE billing_invoices SET raw_payload = '{}'::jsonb`;
		const request = http();

		const listed = await request(`/v1/billing-accounts/${account}/invoices`);
		expect(listed.status).toBe(200);
		const items = (await listed.json()).data;
		expect(items).toHaveLength(3);
		expect(items[0]).toMatchObject({
			externalInvoiceId: "in_c",
			status: "open",
			currency: "usd",
			number: null,
			totalMinor: null,
			amountDueMinor: null,
			periodStart: null,
		});

		const detail = await request(`/v1/billing-accounts/${account}/invoices/${items[0].id}`);
		expect(detail.status).toBe(200);
		expect((await detail.json()).data).toMatchObject({
			lines: [],
			linesTruncated: false,
			hostedInvoiceUrl: null,
			invoicePdfUrl: null,
		});
	});
});
