import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/types";
import { NotFoundBillingError } from "../../src/billing/errors";
import {
	decodeInvoiceCursor,
	encodeInvoiceCursor,
	encodeUsageCursor,
	type InvoiceDetail,
	type InvoiceItem,
	type InvoiceListInput,
} from "../../src/billing/insights";
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
		verifyLimit: 100000,
		webhookLimit: 100000,
		adminLimit: 100000,
		meteringLimit: 100000,
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

const invoiceId = "0198f2a4-6b1c-7a3e-8d5f-123456789abc";
const olderInvoiceId = "0198f2a4-6b1c-7a3e-8d5f-123456789abd";
const missingInvoiceId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const item: InvoiceItem = {
	id: invoiceId,
	externalInvoiceId: "in_1",
	kind: "subscription",
	subscriptionId: null,
	externalSubscriptionId: "sub_1",
	status: "paid",
	number: "ACME-0001",
	currency: "usd",
	amountPaidMinor: 999,
	totalMinor: 999,
	amountDueMinor: 0,
	periodStart: "2026-09-01T00:00:00.000Z",
	periodEnd: "2026-10-01T00:00:00.000Z",
	paidAt: "2026-09-01T00:00:05.000Z",
	createdAt: "2026-09-01T00:00:00.000Z",
};
const detail: InvoiceDetail = {
	...item,
	lines: [
		{
			id: "il_1",
			description: "Premium monthly",
			amountMinor: 999,
			quantity: 1,
			periodStart: "2026-09-01T00:00:00.000Z",
			periodEnd: "2026-10-01T00:00:00.000Z",
			externalPriceId: "price_premium_monthly",
			externalProductId: "prod_premium",
			proration: false,
		},
	],
	linesTruncated: false,
	hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/test_secret",
	invoicePdfUrl: "https://pay.stripe.com/invoice/acct_1/test_secret/pdf",
};

function testApp() {
	const listed: InvoiceListInput[] = [];
	const read: Array<[string, string]> = [];
	const billingInsightsService: NonNullable<AppDependencies["billingInsightsService"]> = {
		listUsageEvents() {
			throw new Error("Unexpected usage events read");
		},
		listProjectUsageEvents() {
			throw new Error("Unexpected project usage events read");
		},
		getUsageSeries() {
			throw new Error("Unexpected usage series read");
		},
		getCustomerBillingSummary() {
			throw new Error("Unexpected billing summary read");
		},
		async listInvoices(_project, input) {
			listed.push(input);
			// A page that is not the last one, so the response has to carry a cursor.
			return {
				items: [item],
				nextCursor:
					input.cursor === null
						? { createdAt: "2026-09-01T00:00:00.000000Z", id: invoiceId }
						: null,
			};
		},
		async getInvoice(_project, billingAccountId, requestedInvoiceId) {
			read.push([billingAccountId, requestedInvoiceId]);
			if (requestedInvoiceId === missingInvoiceId) {
				throw new NotFoundBillingError("Invoice was not found", "INVOICE_NOT_FOUND");
			}
			return detail;
		},
	};
	const app = withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("acme")],
				credentials: {
					"full-key": "acme",
					"read-key": { projectInstanceKey: "acme", access: "read_only" },
				},
			}),
			billingInsightsService,
		}),
	);
	return { app, listed, read };
}

const full = { authorization: "Bearer full-key" };
const readOnly = { authorization: "Bearer read-key" };

describe("invoice reads", () => {
	it("lists a billing account's invoices and pages with an opaque cursor", async () => {
		const { app, listed } = testApp();
		const first = await testRequest(app, "/v1/billing-accounts/acct_1/invoices", {
			headers: readOnly,
		});
		expect(first.status).toBe(200);
		const page = await first.json();
		expect(page.data).toEqual([item]);
		expect(listed[0]).toEqual({
			billingAccountId: "acct_1",
			status: undefined,
			limit: 25,
			cursor: null,
		});
		expect(decodeInvoiceCursor(page.pagination.nextCursor)).toEqual({
			createdAt: "2026-09-01T00:00:00.000000Z",
			id: invoiceId,
		});

		const second = await testRequest(
			app,
			`/v1/billing-accounts/acct_1/invoices?status=paid&limit=5&cursor=${page.pagination.nextCursor}`,
			{ headers: readOnly },
		);
		expect(second.status).toBe(200);
		expect((await second.json()).pagination).toEqual({ nextCursor: null });
		expect(listed[1]).toEqual({
			billingAccountId: "acct_1",
			status: "paid",
			limit: 5,
			cursor: { createdAt: "2026-09-01T00:00:00.000000Z", id: invoiceId },
		});
	});

	it("refuses a malformed query before any read", async () => {
		const { app, listed } = testApp();
		const usageCursor = encodeUsageCursor({
			recordedAt: "2026-09-01T00:00:00.000Z",
			id: invoiceId,
		});
		const goodCursor = encodeInvoiceCursor({
			createdAt: "2026-09-01T00:00:00.000000Z",
			id: olderInvoiceId,
		});
		const queries = [
			"cursor=not-a-cursor",
			`cursor=${usageCursor}`,
			"limit=0",
			"limit=101",
			"limit=0x10",
			"status=refunded",
			`cursor=${goodCursor}&unknown=1`,
		];
		for (const query of queries) {
			const response = await testRequest(app, `/v1/billing-accounts/acct_1/invoices?${query}`, {
				headers: full,
			});
			expect(response.status, query).toBe(400);
		}
		expect(listed).toEqual([]);
	});

	it("returns an invoice with its lines and hands the bearer links to a full credential only", async () => {
		const { app, read } = testApp();
		const withKey = await testRequest(app, `/v1/billing-accounts/acct_1/invoices/${invoiceId}`, {
			headers: full,
		});
		expect(withKey.status).toBe(200);
		expect((await withKey.json()).data).toEqual(detail);

		const withReadOnlyKey = await testRequest(
			app,
			`/v1/billing-accounts/acct_1/invoices/${invoiceId}`,
			{ headers: readOnly },
		);
		expect(withReadOnlyKey.status).toBe(200);
		expect((await withReadOnlyKey.json()).data).toEqual({
			...detail,
			hostedInvoiceUrl: null,
			invoicePdfUrl: null,
		});
		expect(read).toEqual([
			["acct_1", invoiceId],
			["acct_1", invoiceId],
		]);
	});

	it("answers 404 for an unknown invoice and 400 for an id that is not a UUID", async () => {
		const { app, read } = testApp();
		const missing = await testRequest(
			app,
			`/v1/billing-accounts/acct_1/invoices/${missingInvoiceId}`,
			{ headers: full },
		);
		expect(missing.status).toBe(404);
		expect((await missing.json()).error.code).toBe("INVOICE_NOT_FOUND");

		const malformed = await testRequest(app, "/v1/billing-accounts/acct_1/invoices/in_1", {
			headers: full,
		});
		expect(malformed.status).toBe(400);
		expect(read).toEqual([["acct_1", missingInvoiceId]]);
	});
});
