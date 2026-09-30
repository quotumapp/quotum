import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/**
 * Each subscription pins the catalog revision it was bought from, so an account that bought its
 * base plan from one revision and an add-on from a later one holds two rate cards for a meter.
 */
localDescribe("rate cards across an account's pinned revisions", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publish(catalog("0.005", [plan("pro", "base")]), null);
		await publish(catalog("0.01", [plan("pro", "base", 2), plan("boost", "addon")]), 1);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("prices usage with the base plan's revision after an add-on from a later one", async () => {
		await subscribe(context.sql, "grandfathered", "pro", 1);
		await subscribe(context.sql, "grandfathered", "boost", 2);
		await grantCredits("grandfathered");

		const usage = { billingAccountId: "grandfathered", featureKey: "model_tokens" };
		expect(
			await context.repository.checkUsage(integrationProjectContext(), {
				...usage,
				quantity: "100",
			}),
		).toMatchObject({
			allowed: true,
			walletQuantity: "0.5",
			rateCard: { path: "pinned", revision: 1, ratePerUnit: "0.005" },
		});
		expect(
			await context.repository.consumeUsage(integrationProjectContext(), {
				...usage,
				quantity: "100",
				idempotencyKey: "grandfathered:1",
			}),
		).toMatchObject({
			allowed: true,
			walletQuantity: "0.5",
			rateCard: { path: "pinned", revision: 1 },
			balance: { available: "99.5" },
		});

		// Moving the base plan to the later revision moves the rate with it.
		const target = await versionOf("pro", 2);
		await context.sql`
			UPDATE subscriptions
			SET catalog_revision_id = ${target.revisionId}, plan_version_id = ${target.versionId}
			WHERE external_subscription_id = 'grandfathered:pro'
		`;
		expect(
			await context.repository.checkUsage(integrationProjectContext(), {
				...usage,
				quantity: "100",
			}),
		).toMatchObject({ walletQuantity: "1", rateCard: { path: "pinned", revision: 2 } });
	});

	it("prices with the newest add-on revision without a base plan, and the newest base of two", async () => {
		await subscribe(context.sql, "add-on-only", "boost", 2);
		await grantCredits("add-on-only");
		expect(
			await context.repository.checkUsage(integrationProjectContext(), {
				billingAccountId: "add-on-only",
				featureKey: "model_tokens",
				quantity: "100",
			}),
		).toMatchObject({ walletQuantity: "1", rateCard: { path: "pinned", revision: 2 } });

		await subscribe(context.sql, "two-bases", "pro", 1);
		await subscribe(context.sql, "two-bases", "pro", 2, "second");
		await grantCredits("two-bases");
		expect(
			await context.repository.checkUsage(integrationProjectContext(), {
				billingAccountId: "two-bases",
				featureKey: "model_tokens",
				quantity: "100",
			}),
		).toMatchObject({ walletQuantity: "1", rateCard: { path: "pinned", revision: 2 } });
	});
});

function plan(key: string, kind: "base" | "addon", version = 1): CatalogPlanIntent {
	return {
		key,
		name: key,
		version,
		currency: "USD",
		baseAmountMinor: (kind === "base" ? 1000 : 300) * version,
		billingInterval: "month",
		trialDays: null,
		kind,
		items: [],
		providerBindings: [],
	};
}

function catalog(ratePerUnit: string, plans: CatalogPlanIntent[]): CatalogIntent {
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
			{
				key: "model_tokens",
				name: "Model tokens",
				kind: "metered",
				meterKind: "consumable",
				unit: "token",
				creditScale: 0,
				filterDimensions: [],
			},
		],
		plans,
		topups: [],
		rateCards: [{ meterFeatureKey: "model_tokens", walletFeatureKey: "ai_credits", ratePerUnit }],
	};
}

async function publish(intent: CatalogIntent, expectedRevision: number | null): Promise<void> {
	const project = integrationProjectContext();
	const actor = "integration-rate-cards";
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

async function grantCredits(billingAccountId: string): Promise<void> {
	await context.repository.grantAllocation(integrationProjectContext(), {
		billingAccountId,
		featureKey: "ai_credits",
		quantity: "100",
		sourceKind: "credit_grant",
		sourceKey: `fixture:${billingAccountId}`,
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

/** A Stripe subscription to the plan version the given revision published, pinned to it. */
async function subscribe(
	sql: SQL,
	billingAccountId: string,
	planKey: string,
	revision: number,
	suffix = "",
): Promise<void> {
	const target = await versionOf(planKey, revision);
	await sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, ${billingAccountId} FROM projects WHERE key = 'acme'
		ON CONFLICT DO NOTHING
	`;
	await sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end,
			plan_version_id, catalog_revision_id
		)
		SELECT
			customers.project_id, customers.id, products.id, store_products.id, 'stripe', 'web',
			${`${billingAccountId}:${planKey}${suffix}`}, 'prod_stripe_premium', 'price_premium_monthly',
			'active', now() - INTERVAL '1 day', now() + INTERVAL '29 days',
			now() - INTERVAL '1 day', now() + INTERVAL '29 days',
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
