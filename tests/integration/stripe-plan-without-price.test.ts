import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/** A published base plan that the Stripe connection has no price for, like a free or Apple-only plan. */
async function seedUnpricedPlan(sql: SQL): Promise<void> {
	await sql`
		WITH target AS (
			SELECT project.id AS project_id, revision.id AS revision_id
			FROM projects project
			JOIN catalog_revisions revision ON revision.project_id = project.id AND revision.revision = 1
			WHERE project.key = 'acme'
		), plan AS (
			INSERT INTO plans (project_id, key, name)
			SELECT project_id, 'apple-only', 'Apple only' FROM target
			RETURNING id, project_id
		)
		INSERT INTO plan_versions (
			project_id, plan_id, catalog_revision_id, version, status, currency,
			base_amount_minor, billing_interval, tier_rank
		)
		SELECT plan.project_id, plan.id, target.revision_id, 1, 'published', 'USD', 500, 'month', 30
		FROM plan, target
	`;
	await sql`
		UPDATE plans SET active_version_id = version.id
		FROM plan_versions version
		WHERE plans.project_id = version.project_id AND plans.id = version.plan_id
			AND plans.key = 'apple-only'
	`;
}

localDescribe("Stripe requests for a plan without a Stripe price", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		await seedUnpricedPlan(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	function post(path: string, body: unknown) {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		return {
			stripe,
			response: testRequest(app, path, {
				method: "POST",
				headers: { ...authHeaders("acme"), "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		};
	}

	async function expectNotPurchasable(response: Promise<Response>) {
		const reply = await response;
		expect(reply.status).toBe(409);
		const body = await reply.json();
		expect(body.success).toBe(false);
		expect(body.error).toMatchObject({
			code: "PLAN_NOT_PURCHASABLE_VIA_STRIPE",
			message: "Plan apple-only has no Stripe price",
		});
	}

	it("refuses a plan Checkout session with 409 before reaching Stripe", async () => {
		const { stripe, response } = post(
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions",
			{ planKey: "apple-only" },
		);
		await expectNotPurchasable(response);
		expect(stripe.checkoutSessionParams).toHaveLength(0);
	});

	it("refuses a previewed plan Checkout with 409 and stores no preview", async () => {
		const { response } = post("/v1/billing-accounts/integration_user/commercial-actions/preview", {
			intent: { kind: "checkout_plan", planKey: "apple-only" },
		});
		await expectNotPurchasable(response);
		const [{ count }] = await context.sql<
			Array<{ count: string }>
		>`SELECT count(*)::text AS count FROM commercial_action_previews`;
		expect(count).toBe("0");
	});

	it("refuses a hosted payment setup for the plan with 409", async () => {
		const { response } = post("/v1/billing-accounts/integration_user/commercial-actions/preview", {
			intent: {
				kind: "setup_payment",
				currency: "usd",
				plan: { planKey: "apple-only", quantities: {} },
			},
		});
		await expectNotPurchasable(response);
	});

	it("refuses a plan change to the plan with 409", async () => {
		const intent = {
			kind: "subscription_change",
			externalSubscriptionId: "sub_migrate_stripe",
			targetPlanKey: "apple-only",
			quantities: {},
			effectiveMode: "immediate",
		};
		await expectNotPurchasable(
			post("/v1/billing-accounts/migration-stripe/commercial-actions/preview", { intent }).response,
		);
		const direct = createIntegrationApp({ env: context.env, repository: context.repository });
		const reply = await testRequest(
			direct.app,
			"/v1/billing-accounts/migration-stripe/subscriptions/sub_migrate_stripe/changes",
			{
				method: "POST",
				headers: {
					...direct.authHeaders("acme"),
					"content-type": "application/json",
					"idempotency-key": "plan-without-price:direct",
				},
				body: JSON.stringify({ targetPlanKey: "apple-only", quantities: {} }),
			},
		);
		expect(reply.status).toBe(409);
		expect((await reply.json()).error.code).toBe("PLAN_NOT_PURCHASABLE_VIA_STRIPE");
		const [{ count }] = await context.sql<
			Array<{ count: string }>
		>`SELECT count(*)::text AS count FROM subscription_changes`;
		expect(count).toBe("0");
	});

	it("refuses a product Checkout whose Stripe price carries no amount with 409", async () => {
		await context.sql`
			UPDATE store_products SET price_amount = NULL
			WHERE provider = 'stripe' AND external_price_id = 'price_credits_10'
		`;
		const { stripe, response } = post(
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions",
			{ productKey: "echo_credits_10" },
		);
		const reply = await response;
		expect(reply.status).toBe(409);
		expect((await reply.json()).error).toMatchObject({
			code: "PRODUCT_NOT_PURCHASABLE_VIA_STRIPE",
			message: "Stripe product echo_credits_10 has no price amount and currency",
		});
		expect(stripe.checkoutSessionParams).toHaveLength(0);
	});

	it("still checks out a plan that has a Stripe price", async () => {
		const { stripe, response } = post(
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions",
			{ planKey: "migration-plan", quantities: { licensed_seats: 2 } },
		);
		expect((await response).status).toBe(200);
		expect(stripe.checkoutSessionParams).toHaveLength(1);
	});
});
