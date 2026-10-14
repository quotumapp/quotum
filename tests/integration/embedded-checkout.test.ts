import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { embeddedClientSecret } from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

/** Every stored row as text, to prove the client secret was written nowhere. */
async function storedText(): Promise<string> {
	const rows = await context.sql<Array<{ row: string }>>`
		SELECT row_to_json(c)::text AS row FROM checkout_requests c
		UNION ALL
		SELECT row_to_json(p)::text FROM commercial_action_previews p
		UNION ALL
		SELECT row_to_json(r)::text FROM promotion_redemptions r
	`;
	return rows.map(({ row }) => row).join("\n");
}

localDescribe("embedded Stripe Checkout", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	// capability: checkout.hosted
	it("records an embedded session without a URL and answers a replay with Stripe's secret", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const create = () =>
			testRequest(app, "/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions", {
				method: "POST",
				headers: {
					...authHeaders("acme"),
					"content-type": "application/json",
					"idempotency-key": "embedded-1",
				},
				body: JSON.stringify({ productKey: "echo_credits_10", uiMode: "embedded" }),
			});

		const first = await create();
		const replay = await create();

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_integration",
				clientSecret: embeddedClientSecret,
				duplicate: false,
			},
		});
		expect(await replay.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_integration",
				clientSecret: embeddedClientSecret,
				duplicate: true,
			},
		});
		expect(stripe.checkoutSessionParams).toHaveLength(1);
		expect(stripe.checkoutSessionParams[0]).toMatchObject({
			ui_mode: "embedded_page",
			return_url: expect.stringContaining("{CHECKOUT_SESSION_ID}"),
			client_reference_id: "integration_user",
			metadata: { billingAccountId: "integration_user", productKey: "echo_credits_10" },
		});
		expect(stripe.checkoutSessionParams[0]).not.toHaveProperty("success_url");
		expect(stripe.checkoutSessionParams[0]).not.toHaveProperty("cancel_url");
		expect(stripe.calls).toContain("retrieveCheckoutSession:cs_test_integration");
		// The fake's session is already paid, so the status read answers no secret.
		const status = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions/cs_test_integration",
			{ headers: authHeaders("acme") },
		);
		expect((await status.json()).data).toMatchObject({ status: "complete", clientSecret: null });
		const receipts = await context.sql<
			Array<{ status: string; external_session_id: string; session_url: string | null }>
		>`
			SELECT status, external_session_id, session_url
			FROM checkout_requests
			WHERE project_id = ${project.projectInstanceId}
		`;
		expect(receipts).toEqual([
			{ status: "created", external_session_id: "cs_test_integration", session_url: null },
		]);
		expect(await storedText()).not.toContain(embeddedClientSecret);
	});

	// capability: promotion.code_entry
	it("executes an intro-price embedded checkout, stores no secret and replays it", async () => {
		await context.repository.promotions.createPromotion(project, {
			key: "intro",
			name: "Intro price",
			effect: {
				kind: "discount",
				discount: { type: "percent", percentOffBps: 5000, duration: "once", durationMonths: null },
			},
			targets: [{ kind: "product", key: "echo_credits_10" }],
			codes: [{ code: "INTRO50", maxRedemptions: 5 }],
			actor: "operator@example.com",
		});
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = { ...authHeaders("acme"), "content-type": "application/json" };

		const previewResponse = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					provider: "stripe",
					intent: {
						kind: "checkout_product",
						productKey: "echo_credits_10",
						promotionCode: "intro50",
						uiMode: "embedded",
					},
				}),
			},
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).data;
		expect(preview).toMatchObject({ promotion: { code: "INTRO50" }, estimatedTotalMinor: 249 });

		const execute = () =>
			testRequest(app, "/v1/billing-accounts/integration_user/commercial-actions", {
				method: "POST",
				headers: { ...headers, "idempotency-key": "intro-embedded" },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			});
		const executed = await execute();
		const replayed = await execute();

		expect(executed.status).toBe(200);
		const result = (await executed.json()).data;
		expect(result).toMatchObject({
			kind: "checkout",
			sessionId: "cs_test_integration",
			clientSecret: embeddedClientSecret,
			duplicate: false,
			promotionRedemption: { status: "reserved" },
		});
		expect(result).not.toHaveProperty("url");
		expect((await replayed.json()).data).toEqual(result);
		expect(stripe.checkoutSessionParams).toHaveLength(1);
		const [coupon] = [...stripe.promotions.coupons.values()];
		expect(stripe.checkoutSessionParams[0]).toMatchObject({
			ui_mode: "embedded_page",
			discounts: [{ coupon: coupon?.id }],
			metadata: { quotumPromotionRedemptionId: result.promotionRedemption.id },
		});
		const [stored] = await context.sql<Array<{ execution_result: Record<string, unknown> }>>`
			SELECT execution_result
			FROM commercial_action_previews
			WHERE project_id = ${project.projectInstanceId}
		`;
		expect(stored?.execution_result).toEqual({
			kind: "checkout",
			sessionId: "cs_test_integration",
			duplicate: false,
			promotionRedemption: result.promotionRedemption,
		});
		expect(await storedText()).not.toContain(embeddedClientSecret);
	});
});

localDescribe("embedded intro-price plan Checkout", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	// capability: checkout.plan
	// capability: promotion.code_entry
	it("executes an embedded checkout_plan with an intro code and reads the secret back", async () => {
		await context.repository.promotions.createPromotion(project, {
			key: "intro-plan",
			name: "Intro plan price",
			effect: {
				kind: "discount",
				discount: { type: "percent", percentOffBps: 5000, duration: "once", durationMonths: null },
			},
			targets: [{ kind: "plan", key: "migration-plan" }],
			codes: [{ code: "INTROPLAN" }],
			actor: "operator@example.com",
		});
		const account = "checkout-account";
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			// What Stripe answers on a read while the customer still has the form open.
			stripeCheckoutSession: {
				status: "open",
				payment_status: "unpaid",
				client_reference_id: account,
				metadata: { billingAccountId: account },
			},
		});
		const headers = { ...authHeaders("acme"), "content-type": "application/json" };
		const expiresAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;

		const previewResponse = await testRequest(
			app,
			`/v1/billing-accounts/${account}/commercial-actions/preview`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					provider: "stripe",
					intent: {
						kind: "checkout_plan",
						planKey: "migration-plan",
						quantities: { licensed_seats: 1 },
						email: "buyer@example.com",
						promotionCode: "introplan",
						expiresAt,
						uiMode: "embedded",
					},
				}),
			},
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).data;
		expect(preview).toMatchObject({ action: "checkout_plan", promotion: { code: "INTROPLAN" } });

		const execute = () =>
			testRequest(app, `/v1/billing-accounts/${account}/commercial-actions`, {
				method: "POST",
				headers: { ...headers, "idempotency-key": "intro-plan-1" },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			});
		const executed = await execute();
		const replayed = await execute();

		expect(executed.status).toBe(200);
		const result = (await executed.json()).data;
		expect(result).toEqual({
			kind: "checkout",
			sessionId: "cs_test_integration",
			clientSecret: embeddedClientSecret,
			duplicate: false,
			promotionRedemption: { id: expect.any(String), status: "reserved" },
		});
		expect((await replayed.json()).data).toEqual(result);
		expect(stripe.checkoutSessionParams).toHaveLength(1);
		const [coupon] = [...stripe.promotions.coupons.values()];
		expect(stripe.checkoutSessionParams[0]).toMatchObject({
			ui_mode: "embedded_page",
			return_url: expect.stringContaining("{CHECKOUT_SESSION_ID}"),
			mode: "subscription",
			expires_at: expiresAt,
			client_reference_id: account,
			discounts: [{ coupon: coupon?.id }],
		});
		expect(stripe.checkoutSessionParams[0]).not.toHaveProperty("success_url");
		expect(stripe.checkoutSessionParams[0]).not.toHaveProperty("cancel_url");

		const status = await testRequest(
			app,
			`/v1/billing-accounts/${account}/providers/stripe/checkout-sessions/${result.sessionId}`,
			{ headers: authHeaders("acme") },
		);
		expect(status.status).toBe(200);
		expect((await status.json()).data).toMatchObject({
			sessionId: "cs_test_integration",
			status: "open",
			clientSecret: embeddedClientSecret,
		});
		expect(await storedText()).not.toContain(embeddedClientSecret);
	});
});
