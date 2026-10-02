import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";
import { runUsageScopesCommand } from "../../src/composition/cli/usage-scopes";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import type { UsageScopesVerification } from "../../src/db/repository/usage-scopes-transition";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;
let directory: string;
let consumed: { usageEventId: string | null };

/** `quotum usage scopes snapshot` before `quotum migrate`, then `verify` after it (PC-04). */
localDescribe("declared meter-limit scope transition", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		directory = await mkdtemp(join(tmpdir(), "quotum-scopes-transition-"));
		await seedTransitionState();
		expect(await run(["snapshot", "--out", baseline()])).toMatchObject({ code: 0 });
	});

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
		await context.sql.close();
	});

	it("verifies an unchanged database and lists what is over the cap", async () => {
		const result = await run(["verify", "--baseline", baseline(), "--json"]);
		expect(result.code).toBe(0);
		const verification = JSON.parse(result.stdout) as UsageScopesVerification;
		expect(verification.checks.map(({ name, passed }) => [name, passed])).toEqual([
			["usage totals", true],
			["active holds", true],
			["correction routing", true],
			["invoice attribution", true],
			["no capacity gain", true],
			["blockers", true],
		]);
		// The entity's legacy filter windows sum over its cap: refused until room is left, not a failure.
		expect(verification.overCap).toMatchObject([
			{ scope: "entity", usage: "60", held: "0", limit: "50" },
		]);
		const text = await run(["verify", "--baseline", baseline()]);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("PASS correction routing");
		expect(text.stdout).toEndWith("Verified: start the service.");
	});

	it("fails when usage moved after the snapshot", async () => {
		await context.sql`UPDATE usage_windows SET usage = usage + 1 WHERE usage = 30`;
		await expectFailed("usage totals", /usage changed from 30\.000000000 to 31\.000000000/);
	});

	it("fails when a hold changed", async () => {
		await context.sql`UPDATE reservations SET held_quantity = 4`;
		await expectFailed("active holds", /changed from 5\.000000000 to 4\.000000000/);
	});

	it("fails when an event would correct a window its scope does not count", async () => {
		await context.sql`
			UPDATE usage_events
			SET metadata = jsonb_set(
				metadata,
				'{usageWindowId}',
				to_jsonb((
					SELECT window_row.id::text FROM usage_windows window_row
					JOIN customers customer ON customer.id = window_row.customer_id
					WHERE customer.billing_account_id = 'team' LIMIT 1
				))
			)
			WHERE id = ${consumed.usageEventId}::uuid
		`;
		await expectFailed("correction routing", /of another account or feature/);
	});

	it("fails when a pending invoice period changed", async () => {
		await context.sql`UPDATE usage_invoice_periods SET amount_minor = amount_minor + 1`;
		await expectFailed("invoice attribution", /Invoice period .+ changed\./);
	});

	it("fails when unbilled usage would invoice another quantity than the snapshot recorded", async () => {
		const file = Bun.file(baseline());
		const snapshot = (await file.json()) as { unbilledGroups: Array<{ usage: string }> };
		expect(snapshot.unbilledGroups.map(({ usage }) => usage)).toEqual(["9.000000000"]);
		const [group] = snapshot.unbilledGroups;
		if (group !== undefined) group.usage = "99";
		await rm(baseline());
		await Bun.write(baseline(), JSON.stringify(snapshot));
		await expectFailed("invoice attribution", /would invoice 9\.000000000 instead of 99/);
	});

	it("fails while an open window has usage no meter limit applies to", async () => {
		await context.sql`
			UPDATE subscriptions SET status = 'expired', expires_at = now() - INTERVAL '1 minute'
			WHERE external_subscription_id = 'team:team'
		`;
		await expectFailed("blockers", /but no meter limit applies to it now/);
	});

	it("fails while an account holds mixed scopes", async () => {
		// An add-on capping per entity, as a catalog published before declared scopes could hold.
		await context.sql`
			WITH addon AS (
				INSERT INTO plans (project_id, key, name)
				SELECT id, 'boost', 'Boost' FROM projects WHERE key = 'acme'
				RETURNING id, project_id
			), version AS (
				INSERT INTO plan_versions (
					project_id, plan_id, catalog_revision_id, version, status, currency,
					base_amount_minor, billing_interval, tier_rank, plan_kind
				)
				SELECT addon.project_id, addon.id, project.published_catalog_revision_id, 1, 'published',
					'USD', 300, 'month', 0, 'addon'
				FROM addon JOIN projects project ON project.id = addon.project_id
				RETURNING id, project_id
			)
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval,
				allocation_scope
			)
			SELECT version.project_id, version.id, feature.id, 'meter_limit', 50, 'day', 'entity'
			FROM version
			JOIN features feature
				ON feature.project_id = version.project_id AND feature.key = 'api_requests'
		`;
		await subscribe("wide", "boost");
		await expectFailed("blockers", /Account wide holds mixed scopes on api_requests/);
	});
});

async function expectFailed(check: string, detail: RegExp): Promise<void> {
	const result = await run(["verify", "--baseline", baseline(), "--json"]);
	expect(result.code).toBe(2);
	expect(result.stderr).toEqual([
		"The declared-scope transition did not verify: do not start the service; restore the dump instead (docs/upgrade-transitions.md).",
	]);
	const verification = JSON.parse(result.stdout) as UsageScopesVerification;
	const failed = verification.checks.find(({ name }) => name === check);
	expect(failed?.passed).toBe(false);
	expect(failed?.details.join("\n")).toMatch(detail);
	expect(verification.checks.filter(({ passed }) => !passed).map(({ name }) => name)).toEqual([
		check,
	]);
}

function baseline(): string {
	return join(directory, "pre.json");
}

async function run(argv: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await runUsageScopesCommand(
		argv,
		{},
		{
			database: context.db as unknown as TransactionalQueryExecutor,
			output: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
		},
	);
	return { code, stdout: stdout.join("\n"), stderr };
}

/**
 * What a release before declared scopes left behind: per-entity and per-filter windows, a hold on
 * one of them, and a closed window not invoiced yet.
 */
async function seedTransitionState(): Promise<void> {
	// Base plans exclude each other, so they may declare different scopes.
	await publish(
		catalog([plan("pro", "base", "100", "account"), plan("team", "base", "50", "entity")]),
	);
	const project = integrationProjectContext();
	await subscribe("wide", "pro");
	await entity("wide", "workspace-a");
	await entity("wide", "workspace-b");
	consumed = await context.repository.consumeUsage(project, {
		billingAccountId: "wide",
		featureKey: "api_requests",
		quantity: "10",
		idempotencyKey: "wide:consume",
	});
	await context.repository.reserveUsage(project, {
		billingAccountId: "wide",
		featureKey: "api_requests",
		quantity: "5",
		expiresInSeconds: 3600,
		idempotencyKey: "wide:hold",
	});
	await subscribe("team", "team");
	await entity("team", "workspace-c");
	await context.repository.consumeUsage(project, {
		billingAccountId: "team",
		featureKey: "api_requests",
		entityId: "workspace-c",
		quantity: "40",
		idempotencyKey: "team:consume",
	});
	// The rows as the old release wrote them, plus more of its per-entity and per-filter windows.
	await context.sql`UPDATE usage_windows SET scope = NULL`;
	await context.sql`UPDATE usage_windows SET filter_key = 'region=west' WHERE usage = 40`;
	await context.sql`
		INSERT INTO usage_windows (
			project_id, customer_id, entity_id, feature_id, filter_key, window_start_at, window_end_at,
			usage, subscription_id, anchor_plan_item_id
		)
		SELECT source.project_id, source.customer_id, entity.id, source.feature_id, added.filter_key,
			source.window_start_at, source.window_end_at, added.usage, source.subscription_id,
			source.anchor_plan_item_id
		FROM usage_windows source
		JOIN customers customer ON customer.id = source.customer_id
		JOIN (VALUES
			('wide', 'workspace-a', NULL, 30),
			('wide', 'workspace-b', 'region=west', 20),
			('team', 'workspace-c', 'region=east', 20)
		) AS added(account, entity_key, filter_key, usage) ON added.account = customer.billing_account_id
		JOIN entities entity ON entity.customer_id = customer.id AND entity.external_id = added.entity_key
	`;
	// Two closed windows: one a pending invoice period bills, one no period has billed yet.
	await context.sql`
		INSERT INTO usage_windows (
			project_id, customer_id, feature_id, window_start_at, window_end_at, usage, subscription_id,
			anchor_plan_item_id
		)
		SELECT project_id, customer_id, feature_id, window_start_at - closed.days,
			window_end_at - closed.days, closed.usage, subscription_id, anchor_plan_item_id
		FROM usage_windows
		CROSS JOIN (VALUES (INTERVAL '40 days', 7), (INTERVAL '80 days', 9)) AS closed(days, usage)
		WHERE usage_windows.usage = 10
	`;
	await context.sql`
		WITH closed AS (SELECT * FROM usage_windows WHERE usage = 7), component AS (
			INSERT INTO price_components (
				project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing, currency,
				unit_amount_minor, billing_units, billing_interval, minimum_quantity
			)
			SELECT closed.project_id, item.plan_version_id, item.id, 'overage', 'metered_overage',
				'in_arrears', 'USD', 5, 1, 'month', 1
			FROM closed JOIN plan_items item ON item.id = closed.anchor_plan_item_id
			RETURNING id
		)
		INSERT INTO usage_invoice_periods (
			project_id, customer_id, subscription_id, provider, plan_item_id, price_component_id,
			period_start_at, period_end_at, usage_quantity, included_quantity, billable_quantity,
			billing_units, unit_amount_minor, amount_minor, currency, status
		)
		SELECT closed.project_id, closed.customer_id, closed.subscription_id, 'stripe',
			closed.anchor_plan_item_id, component.id, closed.window_start_at, closed.window_end_at, 7, 100,
			0, 1, 5, 0, 'USD', 'pending'
		FROM closed, component
	`;
}

function plan(
	key: string,
	kind: "base" | "addon",
	quantity: string,
	allocationScope: "account" | "entity",
): CatalogPlanIntent {
	return {
		key,
		name: key,
		version: 1,
		currency: "USD",
		baseAmountMinor: kind === "base" ? 1000 : 300,
		billingInterval: "month",
		trialDays: null,
		kind,
		items: [
			{
				featureKey: "api_requests",
				itemKind: "meter_limit",
				quantity,
				resetInterval: "day",
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
				allocationScope,
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
				filterDimensions: ["region"],
			},
		],
		plans,
		topups: [],
		rateCards: [],
	};
}

async function publish(intent: CatalogIntent): Promise<void> {
	const project = integrationProjectContext();
	const actor = "integration-scopes-transition";
	const preview = await context.repository.previewCatalog(project, {
		expectedRevision: null,
		actor,
		catalog: intent,
	});
	await context.repository.publishCatalog(project, {
		expectedRevision: null,
		actor,
		previewToken: preview.previewToken,
		catalog: intent,
	});
}

async function entity(billingAccountId: string, externalId: string): Promise<void> {
	await context.repository.controlsEnterprise.createEntity(integrationProjectContext(), {
		billingAccountId,
		externalId,
		kind: "workspace",
	});
}

async function subscribe(billingAccountId: string, planKey: string): Promise<void> {
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
			version.id, version.catalog_revision_id
		FROM customers
		JOIN projects ON projects.id = customers.project_id AND projects.key = 'acme'
		JOIN products ON products.project_id = customers.project_id AND products.key = 'premium_monthly'
		JOIN store_products ON store_products.project_id = products.project_id
			AND store_products.product_id = products.id
			AND store_products.provider = 'stripe'
		JOIN plans plan ON plan.project_id = customers.project_id AND plan.key = ${planKey}
		JOIN plan_versions version ON version.project_id = plan.project_id AND version.plan_id = plan.id
		WHERE customers.billing_account_id = ${billingAccountId}
	`;
}
