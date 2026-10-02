import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { InvalidRequestError } from "../../src/billing/errors";
import type {
	AuthoredCatalogIntent,
	AuthoredPlanIntent,
	AuthoredPlanItemIntent,
} from "../../src/catalog/types";
import { readProjectionBalances } from "../../src/db/repository/entitlements";
import type { QueryExecutor } from "../../src/db/repository/types";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

/** An unlimited usage item lifts a feature's hard caps while a source holding it is active. */
localDescribe("unlimited usage items", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("lifts the base plan's cap while an unlimited add-on is active, and keeps its usage after", async () => {
		await publish(
			catalog([
				plan("pro", "base", [cap("100", "blocked")]),
				plan("unlimited_requests", "addon", [unlimited]),
			]),
			null,
		);
		await subscribe("lifted", "pro", 1);
		const addOn = await subscribe("lifted", "unlimited_requests", 1);
		const usage = { billingAccountId: "lifted", featureKey: "api_requests" };

		expect(await context.repository.checkUsage(project, { ...usage, quantity: "500" })).toEqual(
			expect.objectContaining({
				allowed: true,
				balance: expect.objectContaining({
					granted: null,
					available: null,
					unlimited: true,
					consumed: "0",
				}),
			}),
		);
		// Usage is still recorded in the base plan's window.
		expect(
			await context.repository.consumeUsage(project, {
				...usage,
				quantity: "150",
				idempotencyKey: "lifted:1",
			}),
		).toMatchObject({
			allowed: true,
			balance: { granted: null, consumed: "150", available: null, unlimited: true },
		});
		expect(await context.repository.getMeteringBalance(project, "lifted", "api_requests")).toEqual(
			expect.objectContaining({ granted: null, available: null, unlimited: true, consumed: "150" }),
		);
		const projected = async () =>
			(
				await readProjectionBalances(
					context.db as unknown as QueryExecutor,
					project.projectInstanceId,
					await customerId("lifted"),
				)
			).filter((balance) => balance.featureKey === "api_requests");
		// Additive: the projection keeps the window's finite figures and marks the lifted cap.
		expect(await projected()).toEqual([
			expect.objectContaining({ available: "0", held: "0", unlimited: true }),
		]);

		// The add-on ends: the finite cap applies to the usage the window already holds.
		await context.sql`
			UPDATE subscriptions SET status = 'expired', expires_at = now() - INTERVAL '1 second'
			WHERE id = ${addOn}
		`;
		const capped = await context.repository.checkUsage(project, { ...usage, quantity: "1" });
		expect(capped).toMatchObject({
			allowed: false,
			balance: { granted: "100", consumed: "150", available: "0" },
		});
		expect(capped.balance).not.toHaveProperty("unlimited");
		expect(await projected()).toEqual([expect.objectContaining({ available: "0" })]);
		expect((await projected())[0]).not.toHaveProperty("unlimited");
	});

	it("reports an unlimited quota through the compact check, consume and receipt", async () => {
		await publish(
			catalog([
				plan("pro", "base", [cap("100", "blocked")]),
				plan("unlimited_requests", "addon", [unlimited]),
			]),
			null,
		);
		await subscribe("compact", "pro", 1);
		await subscribe("compact", "unlimited_requests", 1);
		const { app, authHeaders } = createIntegrationApp(context);
		const headers = { ...authHeaders(), "content-type": "application/json" };
		const unlimitedBalance = {
			featureId: "api_requests",
			granted: null,
			available: null,
			unlimited: true,
		};

		const checked = await testRequest(app, "/v1/billing-accounts/compact/usage/check", {
			method: "POST",
			headers,
			body: JSON.stringify({ featureId: "api_requests", value: "500" }),
		});
		expect(checked.status).toBe(200);
		expect((await checked.json()).data).toMatchObject({
			kind: "metered",
			allowed: true,
			balance: unlimitedBalance,
		});

		const consumed = await testRequest(app, "/v1/billing-accounts/compact/usage/consume", {
			method: "POST",
			headers: { ...headers, "idempotency-key": "compact-unlimited" },
			body: JSON.stringify({ featureId: "api_requests", value: "500" }),
		});
		expect(consumed.status).toBe(200);
		const result = (await consumed.json()).data;
		expect(result).toMatchObject({
			allowed: true,
			balance: { ...unlimitedBalance, consumed: "500" },
		});

		const receipt = await testRequest(
			app,
			`/v1/billing-accounts/compact/usage/receipts/${result.receiptId}`,
			{ headers: authHeaders() },
		);
		expect(receipt.status).toBe(200);
		expect((await receipt.json()).data.balance).toMatchObject(unlimitedBalance);
	});

	it("still counts usage against a usage limit control and fires its alerts", async () => {
		await publish(catalog([plan("unlimited", "base", [unlimited])]), null);
		await subscribe("controlled", "unlimited", 1);
		const controls = context.repository.controlsEnterprise;
		await controls.upsertControl(project, {
			billingAccountId: "controlled",
			controlKind: "usage_limit",
			featureKey: "api_requests",
			limitValue: "10000",
			interval: "day",
			actor: "integration-test",
		});
		for (const [thresholdType, thresholdValue] of [
			["percentage", "80"],
			["absolute", "5000"],
		] as const) {
			await controls.createUsageAlert(project, {
				billingAccountId: "controlled",
				featureKey: "api_requests",
				thresholdType,
				thresholdValue,
				interval: "day",
				actor: "integration-test",
			});
		}
		const consume = (quantity: string, key: string) =>
			context.repository.consumeUsage(project, {
				billingAccountId: "controlled",
				featureKey: "api_requests",
				quantity,
				idempotencyKey: key,
			});

		expect(await consume("7999", "controlled:1")).toMatchObject({
			allowed: true,
			balance: { unlimited: true, consumed: "7999" },
		});
		expect(await controls.listUsageAlertEvents(project, "controlled", 100)).toHaveLength(1);
		await consume("1", "controlled:2");
		// The 80% alert takes its denominator from the usage limit control: it fires at 8,000.
		expect(
			(await controls.listUsageAlertEvents(project, "controlled", 100)).map(
				({ eventType }) => eventType,
			),
		).toEqual(["threshold_crossed", "threshold_crossed"]);
		expect(await consume("2001", "controlled:3")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
		expect(await consume("2000", "controlled:4")).toMatchObject({ allowed: true });
	});

	it("allows an account its unlimited plan without a finite limit, and caps one without", async () => {
		await publish(
			catalog([plan("unlimited", "base", [unlimited]), plan("starter", "base", [])]),
			null,
		);
		await subscribe("unlimited-plan", "unlimited", 1);
		await subscribe("starter-plan", "starter", 1);
		expect(
			await context.repository.consumeUsage(project, {
				billingAccountId: "unlimited-plan",
				featureKey: "api_requests",
				quantity: "1000000",
				idempotencyKey: "unlimited-plan:1",
			}),
		).toMatchObject({ allowed: true, balance: { unlimited: true, consumed: "1000000" } });
		// A hold and its confirmation go through uncapped too.
		const hold = await context.repository.reserveUsage(project, {
			billingAccountId: "unlimited-plan",
			featureKey: "api_requests",
			quantity: "10",
			idempotencyKey: "unlimited-plan:hold",
			expiresInSeconds: 300,
		});
		expect(
			await context.repository.confirmUsageReservation(project, {
				billingAccountId: "unlimited-plan",
				reservationId: hold.reservationId ?? "",
				quantity: "10",
				idempotencyKey: "unlimited-plan:confirm",
			}),
		).toMatchObject({
			status: "confirmed",
			balance: { unlimited: true, held: "0", consumed: "1000010" },
		});
		// Without a finite limit the projection reports the lifted cap in a calendar-month window.
		expect(
			(
				await readProjectionBalances(
					context.db as unknown as QueryExecutor,
					project.projectInstanceId,
					await customerId("unlimited-plan"),
				)
			).filter((balance) => balance.featureKey === "api_requests"),
		).toEqual([expect.objectContaining({ available: "0", unlimited: true })]);
		// Absence still means no quota entitlement.
		expect(
			await context.repository.checkUsage(project, {
				billingAccountId: "starter-plan",
				featureKey: "api_requests",
				quantity: "1",
			}),
		).toMatchObject({ allowed: false, balance: { granted: "0", available: "0" } });
	});

	it("refuses an unlimited item beside a postpaid limit, and leaves one that slips through out", async () => {
		await provisionPostpaidProducts();
		await expect(
			context.repository.previewCatalog(project, {
				expectedRevision: null,
				actor: "integration-test",
				catalog: catalog([
					postpaidPlan("allowed"),
					plan("unlimited_requests", "addon", [unlimited]),
				]),
			}),
		).rejects.toThrow(
			new InvalidRequestError(
				"Plan metered cannot allow postpaid overage on api_requests, because plan unlimited_requests grants unlimited usage of it; unlimited usage lifts hard caps only",
			),
		);

		// A later revision drops the postpaid plan, so its unlimited add-on publishes; an account still
		// on the postpaid version cannot add it up.
		await publish(catalog([postpaidPlan("allowed")]), null);
		await publish(
			catalog([postpaidPlan("blocked", 2), plan("unlimited_requests", "addon", [unlimited])]),
			1,
		);
		await subscribe("postpaid", "metered", 1);
		const { versionId } = await versionOf("unlimited_requests", 2);
		expect(
			await context.repository.addOnMeterLimitConflicts(project, "postpaid", versionId),
		).toEqual(["api_requests"]);
		await subscribe("postpaid", "unlimited_requests", 2);
		// The postpaid limit has no cap to lift: its overage stays billed and its balance finite.
		const decision = await context.repository.checkUsage(project, {
			billingAccountId: "postpaid",
			featureKey: "api_requests",
			quantity: "150",
		});
		expect(decision).toMatchObject({ allowed: true, balance: { granted: "100" } });
		expect(decision.balance).not.toHaveProperty("unlimited");
	});

	it("lifts an account-scoped cap and treats one beside an entity-scoped cap as a mixed scope", async () => {
		// An unlimited usage item declares no scope: it covers the account. It lifts an account cap.
		await publish(
			catalog([
				plan("pro", "base", [
					{ ...cap("100", "blocked"), allocationScope: "account" } as AuthoredPlanItemIntent,
				]),
				plan("unlimited_requests", "addon", [unlimited]),
			]),
			null,
		);
		await subscribe("scoped", "pro", 1);
		await subscribe("scoped", "unlimited_requests", 1);
		const usage = { billingAccountId: "scoped", featureKey: "api_requests" };
		expect(
			await context.repository.checkUsage(project, { ...usage, quantity: "500" }),
		).toMatchObject({
			allowed: true,
			balance: { granted: null, available: null, unlimited: true },
		});

		// Beside an entity-scoped cap an account could hold it with, it is a mixed scope: refused at
		// publication, at purchase, and, if it still reaches metering, by the mixed-scope refusal.
		await expect(
			context.repository.previewCatalog(project, {
				expectedRevision: 1,
				actor: "integration-test",
				catalog: catalog([
					plan(
						"pro",
						"base",
						[{ ...cap("100", "blocked"), allocationScope: "entity" } as AuthoredPlanItemIntent],
						2,
					),
					plan("unlimited_requests", "addon", [unlimited]),
				]),
			}),
		).rejects.toThrow(
			new InvalidRequestError(
				"Unlimited usage of api_requests on plan unlimited_requests declares account scope, but plan pro caps it with entity scope and can be held together with it; declare the same allocationScope",
			),
		);
		await context.sql`
			UPDATE plan_items item SET allocation_scope = 'entity'
			FROM plan_versions version
			JOIN plans ON plans.project_id = version.project_id AND plans.id = version.plan_id
			WHERE version.project_id = item.project_id AND version.id = item.plan_version_id
				AND plans.key = 'pro' AND item.item_kind = 'meter_limit'
		`;
		const { versionId } = await versionOf("unlimited_requests", 1);
		await subscribe("other", "pro", 1);
		expect(await context.repository.meterLimitScopeConflicts(project, "other", versionId)).toEqual([
			"api_requests",
		]);
		const refused = await context.repository.checkUsage(project, { ...usage, quantity: "1" }).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(refused).toMatchObject({
			code: "METERING_CONFIGURATION_ERROR",
			status: 409,
			details: { reason: "mixed_scope", featureKey: "api_requests" },
		});
		// Reads report the anchor's own scope and do not claim the entity cap is lifted.
		const balance = await context.repository.getMeteringBalance(project, "scoped", "api_requests");
		expect(balance).toMatchObject({ granted: "100" });
		expect(balance).not.toHaveProperty("unlimited");
	});
});

const unlimited: AuthoredPlanItemIntent = {
	itemKind: "unlimited_usage",
	featureKey: "api_requests",
};

function cap(quantity: string, policy: "blocked" | "allowed"): AuthoredPlanItemIntent {
	return {
		itemKind: "meter_limit",
		featureKey: "api_requests",
		quantity,
		reset: { interval: "month", intervalCount: 1 },
		overage:
			policy === "blocked"
				? { policy: "blocked" }
				: {
						policy: "allowed",
						price: {
							key: "api_overage",
							currency: "USD",
							unitAmountMinor: 1,
							billingUnits: "1",
							billingInterval: "month",
							minimumQuantity: 1,
							maximumQuantity: null,
							taxBehavior: "exclusive",
							providerBindings: [{ productKey: "api_overage", provider: "stripe", channel: "web" }],
						},
					},
	};
}

/** An unpriced plan, as the add-on meter-limit tests use: subscriptions pin its version directly. */
function plan(
	key: string,
	kind: "base" | "addon",
	items: AuthoredPlanItemIntent[],
	version = 1,
): AuthoredPlanIntent {
	return { key, name: key, version, kind, items };
}

/**
 * The Stripe products a postpaid plan binds, its base price's and its overage price's, provisioned
 * as publication needs.
 */
async function provisionPostpaidProducts(): Promise<void> {
	for (const [key, amount] of [
		["metered_base", 1000],
		["api_overage", 1],
	] as const) {
		await context.sql`
			INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type, active)
			SELECT id, ${key}, ${key}, 0, ${key}, 'subscription', true
			FROM projects WHERE key = 'acme'
		`;
		await context.sql`
			INSERT INTO store_products (
				project_id, product_id, provider, channel, external_product_id,
				external_price_id, billing_period, billing_period_count, currency, price_amount, active
			)
			SELECT project.id, product.id, 'stripe', 'web', ${`prod_${key}`}, ${`price_${key}`},
				'month', 1, 'usd', ${amount}, true
			FROM projects project
			JOIN products product ON product.project_id = project.id AND product.key = ${key}
			WHERE project.key = 'acme'
		`;
	}
}

/** The postpaid plan: a base price, and a meter limit whose overage is billed or blocked. */
function postpaidPlan(policy: "blocked" | "allowed", version = 1): AuthoredPlanIntent {
	return {
		...plan("metered", "base", [cap("100", policy)], version),
		basePrice: {
			key: "metered_base",
			currency: "USD",
			unitAmountMinor: 1000,
			billingUnits: "1",
			billingInterval: "month",
			minimumQuantity: 1,
			maximumQuantity: 1,
			taxBehavior: "exclusive",
			providerBindings: [{ productKey: "metered_base", provider: "stripe", channel: "web" }],
		},
	};
}

function catalog(plans: AuthoredPlanIntent[]): AuthoredCatalogIntent {
	return {
		features: [
			{
				key: "api_requests",
				name: "API requests",
				kind: "metered",
				meterKind: "consumable",
				unit: "request",
				creditScale: 0,
				filterDimensions: [],
			},
		],
		plans,
		topups: [],
		rateCards: [],
	};
}

async function publish(intent: AuthoredCatalogIntent, expectedRevision: number | null) {
	const actor = "integration-unlimited-usage";
	const preview = await context.repository.previewCatalog(project, {
		expectedRevision,
		actor,
		catalog: intent,
	});
	await context.repository.publishCatalog(project, {
		expectedRevision,
		actor,
		previewToken: preview.previewToken,
		catalog: intent,
	});
}

/** The plan's version published in the given catalog revision. */
async function versionOf(
	planKey: string,
	revision: number,
): Promise<{ versionId: string; revisionId: string }> {
	const [row] = await context.sql<Array<{ id: string; catalog_revision_id: string }>>`
		SELECT version.id::text, version.catalog_revision_id::text
		FROM plan_versions version
		JOIN plans ON plans.project_id = version.project_id AND plans.id = version.plan_id
		JOIN catalog_revisions cr
			ON cr.project_id = version.project_id AND cr.id = version.catalog_revision_id
		JOIN projects ON projects.id = version.project_id AND projects.key = 'acme'
		WHERE plans.key = ${planKey} AND cr.revision = ${revision}
	`;
	if (row === undefined) throw new Error(`Plan ${planKey} has no version in revision ${revision}`);
	return { versionId: row.id, revisionId: row.catalog_revision_id };
}

async function customerId(billingAccountId: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		SELECT customers.id FROM customers
		JOIN projects ON projects.id = customers.project_id AND projects.key = 'acme'
		WHERE customers.billing_account_id = ${billingAccountId}
	`;
	if (row === undefined) throw new Error(`No customer ${billingAccountId}`);
	return row.id;
}

/** A Stripe subscription to the plan version the given revision published; returns its id. */
async function subscribe(billingAccountId: string, planKey: string, revision: number) {
	const target = await versionOf(planKey, revision);
	await context.sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, ${billingAccountId} FROM projects WHERE key = 'acme'
		ON CONFLICT DO NOTHING
	`;
	const [row] = await context.sql<Array<{ id: string }>>`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end,
			plan_version_id, catalog_revision_id
		)
		SELECT
			customers.project_id, customers.id, products.id, store_products.id, 'stripe', 'web',
			${`${billingAccountId}:${planKey}:${revision}`}, 'prod_stripe_premium', 'price_premium_monthly',
			'active', now() - INTERVAL '1 hour', now() + INTERVAL '30 days',
			now() - INTERVAL '1 hour', now() + INTERVAL '30 days',
			${target.versionId}::bigint, ${target.revisionId}::bigint
		FROM customers
		JOIN projects ON projects.id = customers.project_id AND projects.key = 'acme'
		JOIN products ON products.project_id = customers.project_id AND products.key = 'premium_monthly'
		JOIN store_products ON store_products.project_id = products.project_id
			AND store_products.product_id = products.id
			AND store_products.provider = 'stripe'
		WHERE customers.billing_account_id = ${billingAccountId}
		RETURNING id::text
	`;
	if (row === undefined) throw new Error(`Subscription to ${planKey} was not created`);
	return row.id;
}
