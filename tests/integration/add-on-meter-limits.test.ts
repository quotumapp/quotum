import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";
import { readProjectionBalances } from "../../src/db/repository/entitlements";
import type { QueryExecutor } from "../../src/db/repository/types";
import type { CadenceUnit } from "../../src/shared/cadence";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/** A base plan and an add-on that both cap one feature, as an add-on that raises a quota does. */
localDescribe("meter limits from a base plan and its add-ons", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("adds an add-on's cap to the base plan's in one window", async () => {
		await publish(
			catalog([
				plan("pro", "base", 1, limit("100", "day")),
				plan("boost", "addon", 1, limit("50", "day")),
				plan("starter", "base", 1, null),
			]),
			null,
		);
		await subscribe("raised", "pro", 1);
		await subscribe("raised", "boost", 1);
		const project = integrationProjectContext();
		const usage = { billingAccountId: "raised", featureKey: "api_requests" };

		expect(
			await context.repository.checkUsage(project, { ...usage, quantity: "150" }),
		).toMatchObject({ allowed: true, balance: { granted: "150", available: "150" } });
		expect(
			await context.repository.consumeUsage(project, {
				...usage,
				quantity: "120",
				idempotencyKey: "raised:1",
			}),
		).toMatchObject({ allowed: true, balance: { granted: "150", consumed: "120" } });
		expect(
			await context.repository.consumeUsage(project, {
				...usage,
				quantity: "31",
				idempotencyKey: "raised:2",
			}),
		).toMatchObject({ allowed: false, balance: { available: "30" } });
		const balances = await readProjectionBalances(
			context.db as unknown as QueryExecutor,
			project.projectInstanceId,
			await customerId("raised"),
		);
		expect(balances.filter((balance) => balance.featureKey === "api_requests")).toMatchObject([
			{ available: "30", held: "0" },
		]);

		// Without a base plan cap the add-on's own applies.
		await subscribe("add-on-only", "starter", 1);
		await subscribe("add-on-only", "boost", 1);
		expect(
			await context.repository.checkUsage(project, {
				billingAccountId: "add-on-only",
				featureKey: "api_requests",
				quantity: "1",
			}),
		).toMatchObject({ allowed: true, balance: { granted: "50" } });
		expect(await conflicts("raised", "boost", 1)).toEqual([]);
	});

	it("keeps a cap that cannot join the base plan's out, and refuses buying it", async () => {
		await publish(catalog([plan("pro", "base", 1, limit("100", "day"))]), null);
		// A later revision caps monthly throughout, so its add-on publishes; an account still on the
		// daily base plan cannot add it up.
		await publish(
			catalog([
				plan("pro", "base", 2, limit("1000", "month")),
				plan("boost", "addon", 1, limit("50", "month")),
			]),
			1,
		);
		await subscribe("legacy", "pro", 1);
		await subscribe("legacy", "boost", 2);
		expect(
			await context.repository.checkUsage(integrationProjectContext(), {
				billingAccountId: "legacy",
				featureKey: "api_requests",
				quantity: "1",
			}),
		).toMatchObject({ allowed: true, balance: { granted: "100" } });
		expect(await conflicts("legacy", "boost", 2)).toEqual(["api_requests"]);
	});
});

function limit(quantity: string, resetInterval: CadenceUnit) {
	return { quantity, resetInterval };
}

function plan(
	key: string,
	kind: "base" | "addon",
	version: number,
	cap: { quantity: string; resetInterval: CadenceUnit } | null,
): CatalogPlanIntent {
	return {
		key,
		name: key,
		version,
		currency: "USD",
		baseAmountMinor: (kind === "base" ? 1000 : 300) * version,
		billingInterval: "month",
		trialDays: null,
		kind,
		items:
			cap === null
				? []
				: [
						{
							featureKey: "api_requests",
							itemKind: "meter_limit",
							quantity: cap.quantity,
							resetInterval: cap.resetInterval,
							expiresAfterSeconds: null,
							overagePolicy: "blocked",
						},
					],
		providerBindings: [],
	};
}

function catalog(plans: CatalogPlanIntent[]): CatalogIntent {
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

async function publish(intent: CatalogIntent, expectedRevision: number | null): Promise<void> {
	const project = integrationProjectContext();
	const actor = "integration-meter-limits";
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

async function conflicts(
	billingAccountId: string,
	planKey: string,
	revision: number,
): Promise<string[]> {
	const { versionId } = await versionOf(planKey, revision);
	return await context.repository.addOnMeterLimitConflicts(
		integrationProjectContext(),
		billingAccountId,
		versionId,
	);
}

/** A Stripe subscription to the plan version the given revision published, pinned to it. */
async function subscribe(billingAccountId: string, planKey: string, revision: number) {
	const target = await versionOf(planKey, revision);
	await context.sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, ${billingAccountId} FROM projects WHERE key = 'acme'
		ON CONFLICT DO NOTHING
	`;
	await context.sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end,
			plan_version_id, catalog_revision_id
		)
		SELECT
			customers.project_id, customers.id, products.id, store_products.id, 'stripe', 'web',
			${`${billingAccountId}:${planKey}`}, 'prod_stripe_premium', 'price_premium_monthly',
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
	`;
}
