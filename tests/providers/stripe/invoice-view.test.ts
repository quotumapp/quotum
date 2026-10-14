import { describe, expect, it } from "bun:test";
import { stripeInvoiceView } from "../../../src/providers/stripe/invoice-view";

const start = 1_788_220_800; // 2026-09-01T00:00:00Z
const end = start + 30 * 86_400;

describe("stripeInvoiceView", () => {
	it("reads totals, the service period and lines from a current-shape invoice", () => {
		const view = stripeInvoiceView({
			id: "in_1",
			number: "ACME-0001",
			total: 1299,
			amount_due: 0,
			// The usage window a subscription invoice looks back over; the service period is on the lines.
			period_start: start - 30 * 86_400,
			period_end: start,
			hosted_invoice_url: "https://invoice.stripe.com/i/acct/test",
			invoice_pdf: "https://pay.stripe.com/invoice/test/pdf",
			lines: {
				has_more: false,
				data: [
					{
						id: "il_1",
						description: "Premium",
						amount: 999,
						quantity: 1,
						period: { start, end },
						pricing: { price_details: { price: "price_1", product: "prod_1" } },
						parent: { subscription_item_details: { subscription: "sub_1", proration: false } },
					},
					{
						id: "il_2",
						description: "Setup",
						amount: 300,
						quantity: 1,
						period: { start: start - 60, end: start - 60 },
						parent: { invoice_item_details: { invoice_item: "ii_1" } },
					},
				],
			},
		});
		expect(view).toMatchObject({
			number: "ACME-0001",
			totalMinor: 1299,
			amountDueMinor: 0,
			periodStart: new Date(start * 1000).toISOString(),
			periodEnd: new Date(end * 1000).toISOString(),
			hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/test",
			invoicePdfUrl: "https://pay.stripe.com/invoice/test/pdf",
			linesTruncated: false,
		});
		expect(view.lines).toEqual([
			{
				id: "il_1",
				description: "Premium",
				amountMinor: 999,
				quantity: 1,
				periodStart: new Date(start * 1000).toISOString(),
				periodEnd: new Date(end * 1000).toISOString(),
				externalPriceId: "price_1",
				externalProductId: "prod_1",
				proration: false,
			},
			{
				id: "il_2",
				description: "Setup",
				amountMinor: 300,
				quantity: 1,
				periodStart: new Date((start - 60) * 1000).toISOString(),
				periodEnd: new Date((start - 60) * 1000).toISOString(),
				externalPriceId: null,
				externalProductId: null,
				proration: null,
			},
		]);
	});

	it("reads the legacy line shape and flags a truncated page of lines", () => {
		const view = stripeInvoiceView({
			lines: {
				has_more: true,
				data: [
					{
						id: "il_legacy",
						amount: -250,
						proration: true,
						period: { start, end },
						price: { id: "price_legacy", product: "prod_legacy" },
					},
				],
			},
		});
		expect(view.linesTruncated).toBe(true);
		expect(view.lines).toEqual([
			{
				id: "il_legacy",
				description: null,
				amountMinor: -250,
				quantity: null,
				periodStart: new Date(start * 1000).toISOString(),
				periodEnd: new Date(end * 1000).toISOString(),
				externalPriceId: "price_legacy",
				externalProductId: "prod_legacy",
				proration: true,
			},
		]);
	});

	it("answers null fields and no lines for a scrubbed or unusable payload", () => {
		const empty = {
			number: null,
			totalMinor: null,
			amountDueMinor: null,
			periodStart: null,
			periodEnd: null,
			hostedInvoiceUrl: null,
			invoicePdfUrl: null,
			lines: [],
			linesTruncated: false,
		};
		for (const payload of [{}, null, undefined, "{}", [], 7]) {
			expect(stripeInvoiceView(payload)).toEqual(empty);
		}
	});

	it("ignores fields of the wrong type instead of throwing", () => {
		const view = stripeInvoiceView({
			number: 12,
			total: "1299",
			amount_due: 1.5,
			hosted_invoice_url: { href: "x" },
			lines: {
				data: [null, "line", { id: 5, amount: Number.NaN, period: { start: "x", end: 1e30 } }],
			},
		});
		expect(view.number).toBeNull();
		expect(view.totalMinor).toBeNull();
		expect(view.amountDueMinor).toBeNull();
		expect(view.hostedInvoiceUrl).toBeNull();
		expect(view.periodStart).toBeNull();
		expect(view.periodEnd).toBeNull();
		expect(view.lines).toEqual([
			{
				id: null,
				description: null,
				amountMinor: null,
				quantity: null,
				periodStart: null,
				periodEnd: null,
				externalPriceId: null,
				externalProductId: null,
				proration: null,
			},
		]);
	});
});
