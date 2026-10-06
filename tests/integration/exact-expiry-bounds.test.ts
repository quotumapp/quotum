import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { maxExpirySeconds } from "../../src/shared/cadence";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { stripeCheckoutSessionObject, stripeEvent } from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);

let context: LocalPostgresContext;

/** One plan and one top-up whose allowance and credit expire as given. */
function catalog(version: number, planExpiry: unknown, topupExpiry: unknown) {
	return {
		features: [
			{
				key: "ai_credits",
				name: "AI credits",
				kind: "metered",
				meterKind: "consumable",
				unit: "credit",
				creditScale: 3,
				filterDimensions: [],
			},
		],
		plans: [
			{
				key: "premium",
				name: "Premium",
				version,
				kind: "base",
				basePrice: {
					key: "premium_monthly",
					currency: "USD",
					unitAmountMinor: 999,
					billingUnits: "1",
					billingInterval: "month",
					minimumQuantity: 1,
					maximumQuantity: 1,
					taxBehavior: "exclusive",
					providerBindings: [{ productKey: "premium_monthly", provider: "stripe", channel: "web" }],
				},
				providerPriced: null,
				items: [
					{
						itemKind: "allocation",
						featureKey: "ai_credits",
						quantity: "1000",
						reset: { interval: "month", intervalCount: 1 },
						expiry: planExpiry,
					},
				],
			},
		],
		topups: [
			{
				key: "ai_credits_10",
				featureKey: "ai_credits",
				quantity: "10",
				expiry: topupExpiry,
				providerBindings: [{ productKey: "echo_credits_10", provider: "stripe", channel: "web" }],
			},
		],
		rateCards: [],
	};
}

const forever = { mode: "forever" };
const seconds = (value: number) => ({ mode: "after_seconds", seconds: value });

localDescribe("exact-duration expiry bounds", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	function operatorApp(
		overrides: Parameters<typeof createIntegrationApp>[0] extends infer T ? Partial<T> : never = {},
	) {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			...overrides,
		});
		const headers = {
			...(fixture.authHeaders() as Record<string, string>),
			"content-type": "application/json",
			"x-billing-actor": "expiry-bounds-test",
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
		};
		return { ...fixture, headers };
	}

	async function preview(
		app: ReturnType<typeof createIntegrationApp>["app"],
		headers: Record<string, string>,
		body: unknown,
		expectedRevision: number | null = null,
	) {
		const response = await testRequest(app, "/v1/admin/catalog/preview", {
			method: "POST",
			headers,
			body: JSON.stringify({ expectedRevision, catalog: body }),
		});
		return { status: response.status, body: await response.json() };
	}

	async function publish(
		app: ReturnType<typeof createIntegrationApp>["app"],
		headers: Record<string, string>,
		body: unknown,
	) {
		const previewed = await preview(app, headers, body);
		expect(previewed.status).toBe(200);
		const response = await testRequest(app, "/v1/admin/catalog/publish", {
			method: "POST",
			headers,
			body: JSON.stringify({
				expectedRevision: null,
				previewToken: previewed.body.data.previewToken,
				catalog: body,
			}),
		});
		expect(response.status).toBe(200);
	}

	it("refuses an exact expiry above ten years and accepts exactly ten years", async () => {
		const { app, headers } = operatorApp();
		for (const value of [maxExpirySeconds + 1, 9_000_000_000_000, Number.MAX_SAFE_INTEGER]) {
			for (const body of [
				catalog(1, seconds(value), forever),
				catalog(1, forever, seconds(value)),
			]) {
				const refused = await preview(app, headers, body);
				expect(refused.status).toBe(400);
				expect(refused.body.error.code).toBe("INVALID_REQUEST");
			}
		}
		const legacyTopup = catalog(1, forever, forever);
		const refusedLegacy = await preview(app, headers, {
			...legacyTopup,
			topups: legacyTopup.topups.map(({ expiry: _expiry, ...topup }) => ({
				...topup,
				expiresAfterSeconds: maxExpirySeconds + 1,
			})),
		});
		expect(refusedLegacy.status).toBe(400);

		await publish(app, headers, catalog(1, seconds(maxExpirySeconds), seconds(maxExpirySeconds)));
		expect(
			(
				await context.sql<Array<{ expires_after_seconds: string }>>`
					SELECT expires_after_seconds FROM topup_options
				`
			).map((row) => ({ ...row })),
		).toEqual([{ expires_after_seconds: String(maxExpirySeconds) }]);
	});

	it("credits a captured top-up whose stored duration exceeds the bound, expiring at ten years", async () => {
		const { app, headers } = operatorApp();
		await publish(app, headers, catalog(1, forever, seconds(86_400)));
		// A catalog published before the bound existed can hold any positive duration.
		await context.sql`UPDATE topup_options SET expires_after_seconds = 9000000000000`;
		const errors: unknown[] = [];
		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_expiry_bound_topup",
			),
			logger: {
				error: (_message: string, error: unknown) => errors.push(error),
				warn() {},
				info() {},
			},
		});
		const response = await testRequest(checkout.app, "/v1/projects/acme/webhooks/stripe", {
			method: "POST",
			headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
			body: JSON.stringify({
				id: "evt_expiry_bound_topup",
				type: "checkout.session.completed",
				data: { object: {} },
			}),
		});
		expect(errors).toEqual([]);
		expect(response.status).toBe(200);
		const rows = await context.sql<Array<{ quantity: string; lifetime_seconds: string }>>`
			SELECT allocation.quantity::text,
				extract(epoch FROM allocation.expires_at - purchase.purchased_at)::bigint::text AS lifetime_seconds
			FROM balance_allocations allocation
			JOIN purchases purchase ON purchase.id = allocation.purchase_id
			WHERE allocation.source_kind = 'topup'
		`;
		expect(rows.map((row) => ({ ...row }))).toEqual([
			{ quantity: "10.000000000", lifetime_seconds: String(maxExpirySeconds) },
		]);
		const events = await context.sql<Array<{ processing_status: string }>>`
			SELECT processing_status FROM store_events
		`;
		expect(events.map((row) => row.processing_status)).toEqual(["processed"]);
	});

	it("syncs a subscription whose plan item stores a duration beyond the bound", async () => {
		const { app, headers } = operatorApp();
		await publish(app, headers, catalog(1, seconds(86_400), forever));
		await context.sql`UPDATE plan_items SET expires_after_seconds = 9007199254740991`;
		const periodStart = new Date();
		const periodEnd = new Date(periodStart.getTime() + 30 * 86_400_000);
		const outcome = await context.repository.recordStripeSubscriptionAndEnqueueProjection(
			integrationProjectContext(),
			{
				billingAccountId: "acct-expiry",
				stripeCustomerId: "cus_expiry",
				stripeSubscriptionId: "sub_expiry",
				invoiceId: null,
				externalProductId: "prod_stripe_premium",
				externalPriceId: "price_premium_monthly",
				subscriptionStatus: "active",
				purchasedAt: periodStart,
				startsAt: periodStart,
				expiresAt: periodEnd,
				currentPeriodStart: periodStart,
				currentPeriodEnd: periodEnd,
				autoRenew: true,
				rawPayload: {},
				eventType: "customer.subscription.updated",
				externalEventId: "evt_expiry_bound_plan",
				projectionReason: "provider_webhook",
				projectionIdempotencyKey: "evt_expiry_bound_plan:projection",
				providerEventCreated: 1,
			} as Parameters<typeof context.repository.recordStripeSubscriptionAndEnqueueProjection>[1],
		);
		expect(outcome.processingStatus).toBe("processed");
		const rows = await context.sql<Array<{ quantity: string }>>`
			SELECT quantity::text FROM balance_allocations WHERE source_kind = 'subscription'
		`;
		expect(rows.map((row) => ({ ...row }))).toEqual([{ quantity: "1000.000000000" }]);
	});
});
