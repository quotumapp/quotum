import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";
import { runUsageScopesCommand } from "../../src/composition/cli/usage-scopes";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import type { UsageScopesReport } from "../../src/db/repository/usage-scopes-report";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/** `quotum usage scopes report` against real windows, holds and pinned subscriptions. */
localDescribe("declared meter-limit scope report", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("reports scopes, the windows they will sum, and what blocks the upgrade, writing nothing", async () => {
		// Publication refuses scopes an account could hold together, so the entity-scoped plans are
		// published with the account scope and rewritten below, as a catalog published before PC-04
		// could hold them.
		await publish(
			catalog([
				plan("pro", "base", "api_requests", "100", "account"),
				plan("teams", "base", "api_requests", "50", "account"),
				plan("boost", "addon", "api_requests", "50", "account"),
				plan("metered", "base", "tokens", "100", "account"),
			]),
		);
		await context.sql`
			UPDATE plan_items SET allocation_scope = 'entity'
			FROM plan_versions version
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			WHERE version.project_id = plan_items.project_id AND version.id = plan_items.plan_version_id
				AND plan.key IN ('boost', 'teams')
		`;
		const project = integrationProjectContext();
		const api = { featureKey: "api_requests" };

		// Before declared scopes, each entity and filter got its own window; the account scope sums
		// them. The hold is taken first, then its window and the others are written the old way.
		await subscribe("wide", "pro");
		await entity("wide", "workspace-a");
		await entity("wide", "workspace-b");
		const hold = await context.repository.reserveUsage(project, {
			...api,
			billingAccountId: "wide",
			quantity: "10",
			idempotencyKey: "wide:hold",
			expiresInSeconds: 300,
		});
		expect(hold.reservationId).not.toBeNull();
		const [bounds] = await context.sql<Array<{ start: Date; end: Date }>>`
			UPDATE usage_windows SET scope = NULL
			WHERE id = (SELECT usage_window_id FROM reservations WHERE id = ${hold.reservationId}::uuid)
			RETURNING window_start_at AS start, window_end_at AS end
		`;
		if (bounds === undefined) throw new Error("Expected the hold's window");
		const legacy = (
			billingAccountId: string,
			entityId: string | null,
			region: string | null,
			usage: string,
		) => legacyWindow({ billingAccountId, entityId, region, usage, ...bounds });
		await legacy("wide", "workspace-a", null, "60");
		await legacy("wide", "workspace-b", "west", "45");

		// An entity scope sums one entity's filters.
		await subscribe("teamsacct", "teams");
		await entity("teamsacct", "workspace-a");
		for (const region of ["west", "east"]) {
			await legacy("teamsacct", "workspace-a", region, "20");
		}

		// A base plan and an add-on that cap one feature with different scopes.
		await subscribe("mixed", "pro");
		await subscribe("mixed", "boost");

		// An open window nothing caps any more.
		await subscribe("lapsed", "pro");
		await legacy("lapsed", null, null, "5");
		await context.sql`
			UPDATE subscriptions SET status = 'expired', expires_at = now() - INTERVAL '1 minute'
			WHERE external_subscription_id = 'lapsed:pro'
		`;

		// A postpaid per-entity limit a subscription still holds.
		await subscribe("postpaid", "metered");
		await context.sql`
			UPDATE plan_items SET allocation_scope = 'entity', overage_policy = 'allowed'
			FROM features
			WHERE features.id = plan_items.feature_id AND features.key = 'tokens'
				AND plan_items.item_kind = 'meter_limit'
		`;

		const before = await stateFingerprint();
		const { code, report, stderr } = await runReport(["report", "--json", "--project", "acme"]);
		expect(await stateFingerprint()).toEqual(before);
		expect(code).toBe(2);
		expect(stderr).toEqual([
			"3 blocking items: resolve them before the declared-scope upgrade (docs/upgrade-transitions.md).",
		]);
		expect(report.blockingItems).toBe(3);
		expect(report.warningItems).toBe(1);
		const [acme] = report.projects;
		if (acme === undefined) throw new Error("Expected the acme project");
		expect(acme.project.key).toBe("acme");

		expect(acme.features.map((feature) => feature.featureKey)).toEqual(["api_requests", "tokens"]);
		expect(
			acme.features[0]?.limits.map((limit) => [
				limit.plan,
				limit.planKind,
				limit.scope,
				limit.quantity,
				limit.subscriptions,
			]),
		).toEqual([
			["boost", "addon", "entity", "50", 1],
			// The lapsed subscription no longer counts as pinned.
			["pro", "base", "account", "100", 2],
			["teams", "base", "entity", "50", 1],
		]);

		expect(acme.blocking.mixedScopeAccounts).toEqual([
			{
				billingAccountId: "mixed",
				featureKey: "api_requests",
				sources: [
					{ plan: "boost", version: 1, scope: "entity" },
					{ plan: "pro", version: 1, scope: "account" },
				],
			},
		]);
		expect(acme.blocking.postpaidEntityFanOut).toMatchObject([
			{ featureKey: "tokens", limit: { plan: "metered", scope: "entity", subscriptions: 1 } },
		]);
		expect(acme.blocking.unresolvedWindows).toMatchObject([
			{ billingAccountId: "lapsed", featureKey: "api_requests", scope: "unresolved", usage: "5" },
		]);
		expect(acme.warnings.mixedScopeConfigurations).toMatchObject([
			{
				featureKey: "api_requests",
				first: { plan: "boost", scope: "entity" },
				second: { plan: "pro", scope: "account" },
			},
		]);
		expect(acme.warnings.postpaidEntityFanOut).toEqual([]);

		expect(acme.accounts).toMatchObject({ affectedGroups: 2, overCapGroups: 1, truncated: false });
		expect(acme.accounts.listed).toMatchObject([
			{
				billingAccountId: "wide",
				scope: "account",
				entity: null,
				windows: 3,
				entities: 3,
				filters: 2,
				usage: "105",
				held: "10",
				limit: "100",
				overCap: true,
			},
			{
				billingAccountId: "teamsacct",
				scope: "entity",
				entity: "workspace-a",
				windows: 2,
				filters: 2,
				usage: "40",
				held: "0",
				limit: "50",
				overCap: false,
			},
		]);

		const text = await runText(["report", "--project", "acme", "--limit", "1"]);
		expect(text.code).toBe(2);
		expect(text.stdout).toContain("Project acme (");
		expect(text.stdout).toContain(
			"Account mixed holds mixed scopes on api_requests: boost v1 (entity), pro v1 (account).",
		);
		expect(text.stdout).toContain("OVER CAP wide api_requests [account]");
		expect(text.stdout).not.toContain("teamsacct api_requests");
		expect(text.stdout).toContain("… more not listed; raise --limit or use --json.");
	});

	it("reports every instance, and treats an unknown one as a usage error", async () => {
		const all = await runReport(["report", "--json"]);
		expect(all.code).toBe(0);
		const keys = all.report.projects.map((project) => project.project.key);
		expect(keys).toEqual([...keys].sort());
		expect(keys).toEqual(expect.arrayContaining(["acme", "globex"]));
		expect(all.report.projects.every((project) => project.features.length === 0)).toBe(true);

		const unknown = await runText(["report", "--project", "initech"]);
		expect(unknown.code).toBe(64);
		expect(unknown.stderr).toEqual([
			'No project instance "initech". Run `quotum usage scopes --help` for usage.',
		]);
	});
});

async function runText(argv: string[]) {
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

async function runReport(argv: string[]) {
	const result = await runText(argv);
	return { ...result, report: JSON.parse(result.stdout) as UsageScopesReport };
}

/** Everything the report reads that a write could change. */
async function stateFingerprint() {
	return await context.sql`
		SELECT
			(SELECT count(*)::int FROM usage_windows) AS windows,
			(SELECT COALESCE(sum(usage), 0)::text FROM usage_windows) AS usage,
			(SELECT string_agg(status || held_quantity::text, ',' ORDER BY id) FROM reservations) AS holds,
			(SELECT count(*)::int FROM customers) AS customers,
			(SELECT count(*)::int FROM plan_grants) AS grants
	`;
}

/** An `api_requests` window the way a release before declared scopes wrote it. */
async function legacyWindow(input: {
	billingAccountId: string;
	entityId: string | null;
	region: string | null;
	usage: string;
	start: Date;
	end: Date;
}): Promise<void> {
	await context.sql`
		INSERT INTO usage_windows (
			project_id, customer_id, entity_id, feature_id, filter_key, window_start_at, window_end_at,
			usage
		)
		SELECT customer.project_id, customer.id,
			(
				SELECT entity.id FROM entities entity
				WHERE entity.customer_id = customer.id AND entity.external_id = ${input.entityId}
			),
			feature.id, ${input.region === null ? null : `region=${input.region}`}, ${input.start},
			${input.end}, ${input.usage}::numeric
		FROM customers customer
		JOIN projects project ON project.id = customer.project_id AND project.key = 'acme'
		JOIN features feature ON feature.project_id = customer.project_id
			AND feature.key = 'api_requests'
		WHERE customer.billing_account_id = ${input.billingAccountId}
	`;
}

function plan(
	key: string,
	kind: "base" | "addon",
	featureKey: string,
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
				featureKey,
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
	const feature = (key: string) => ({
		key,
		name: key,
		kind: "metered" as const,
		meterKind: "consumable" as const,
		unit: "request",
		creditScale: 0,
		filterDimensions: ["region"],
	});
	return {
		features: [feature("api_requests"), feature("tokens")],
		plans,
		topups: [],
		rateCards: [],
	};
}

async function publish(intent: CatalogIntent): Promise<void> {
	const project = integrationProjectContext();
	const actor = "integration-scopes-report";
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

async function entity(billingAccountId: string, externalId: string) {
	await context.sql`
		INSERT INTO entities (project_id, customer_id, external_id, kind)
		SELECT customers.project_id, customers.id, ${externalId}, 'workspace'
		FROM customers
		JOIN projects ON projects.id = customers.project_id AND projects.key = 'acme'
		WHERE customers.billing_account_id = ${billingAccountId}
	`;
}

/** A Stripe subscription pinned to the plan's first published version. */
async function subscribe(billingAccountId: string, planKey: string) {
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
		JOIN plans ON plans.project_id = customers.project_id AND plans.key = ${planKey}
		JOIN plan_versions version
			ON version.project_id = plans.project_id AND version.plan_id = plans.id AND version.version = 1
		JOIN products ON products.project_id = customers.project_id AND products.key = 'premium_monthly'
		JOIN store_products ON store_products.project_id = products.project_id
			AND store_products.product_id = products.id
			AND store_products.provider = 'stripe'
		WHERE customers.billing_account_id = ${billingAccountId}
	`;
}
