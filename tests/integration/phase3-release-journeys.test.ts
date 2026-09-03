import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { STRIPE_API_VERSION, type StripeBillingConfig } from "../../src/providers/stripe/client";
import { StripeBillingService } from "../../src/providers/stripe/service";
import {
	FakeStripeBillingClient,
	type FakeStripeBillingClientOptions,
} from "../../src/providers/stripe/testing/fake-client";
import { AutoTopupWorker } from "../../src/workers/auto-topup";
import { RecurringBillingWorker } from "../../src/workers/recurring-billing";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	linkStripeCustomer,
	seedPhase3CatalogMigration,
	seedPhase3ControlCatalog,
} from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = { projectKey: "voysee" } as const;
const actor = "phase3-release-test";
let context: LocalPostgresContext;

localDescribe("Phase 3 release journeys", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("drives controls, alerts, correction, and detailed balance through authenticated HTTP", async () => {
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const account = "http-controls";
		await context.repository.grantAllocation(project, {
			billingAccountId: account,
			featureKey: "ai_credits",
			quantity: "20",
			sourceKind: "operator",
			sourceKey: "fixture:http-controls",
		});

		const unauthenticated = await putJson(
			fixture.app,
			`/v1/billing-accounts/${account}/controls`,
			{},
			usageLimitBody("6"),
		);
		expect(unauthenticated.status).toBe(401);
		const missingActor = await putJson(
			fixture.app,
			`/v1/billing-accounts/${account}/controls`,
			fixture.authHeaders(),
			usageLimitBody("6"),
		);
		expect(missingActor.status).toBe(400);

		const headers = actorHeaders(fixture.authHeaders());
		expect(
			(
				await putJson(
					fixture.app,
					`/v1/billing-accounts/${account}/controls`,
					headers,
					usageLimitBody("6"),
				)
			).status,
		).toBe(200);
		expect(
			(
				await postJson(fixture.app, `/v1/billing-accounts/${account}/usage-alerts`, headers, {
					featureKey: "ai_credits",
					thresholdType: "absolute",
					thresholdValue: "5",
					interval: "lifetime",
				})
			).status,
		).toBe(201);

		const first = await consume(fixture, account, "3", "http-controls:1");
		const crossing = await consume(fixture, account, "3", "http-controls:2");
		expect(first.allowed).toBe(true);
		expect(crossing.allowed).toBe(true);
		expect(await consume(fixture, account, "1", "http-controls:denied")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});

		const correction = await postJson(
			fixture.app,
			`/v1/billing-accounts/${account}/usage/events/${crossing.usageEventId}/corrections`,
			{ ...headers, "idempotency-key": "http-controls:correction" },
			{
				originalRecordedAt: crossing.recordedAt,
				quantity: "3",
				reason: "duplicate request batch",
			},
		);
		expect(correction.status).toBe(200);
		expect(await consume(fixture, account, "2", "http-controls:3")).toMatchObject({
			allowed: true,
		});

		const alertEvents = await fixture.app.request(
			`/v1/billing-accounts/${account}/usage-alert-events`,
			{ headers: fixture.authHeaders() },
		);
		expect(alertEvents.status).toBe(200);
		expect(
			(await alertEvents.json()).data.map((event: { eventType: string }) => event.eventType),
		).toEqual(["threshold_crossed", "threshold_rearmed", "threshold_crossed"]);

		const balance = await fixture.app.request(
			`/v1/billing-accounts/${account}/balances/ai_credits`,
			{ headers: fixture.authHeaders() },
		);
		expect(balance.status).toBe(200);
		expect((await balance.json()).data).toMatchObject({
			granted: "20",
			consumed: "5",
			available: "15",
			breakdown: [
				{
					sourceKind: "operator",
					quantity: "20",
					consumed: "5",
					available: "15",
				},
			],
		});
	});

	it("runs automatic top-ups through the real repository, worker, and Stripe service", async () => {
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const account = "worker-topup";
		await context.repository.grantAllocation(project, {
			billingAccountId: account,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:worker-topup",
		});
		await linkStripeCustomer(context.sql, account, "cus_worker_topup");
		const policyResponse = await putJson(
			fixture.app,
			`/v1/billing-accounts/${account}/auto-topup`,
			actorHeaders(fixture.authHeaders()),
			{
				featureKey: "ai_credits",
				topupKey: "credits_10",
				provider: "stripe",
				thresholdQuantity: "5",
				cooldownSeconds: 30,
				limitIntervalSeconds: 86400,
				maxPurchasesPerInterval: 2,
				maxSpendMinor: 1000,
				maxConsecutiveFailures: 3,
			},
		);
		expect(policyResponse.status).toBe(200);
		await consume(fixture, account, "6", "worker-topup:trigger");

		const provider = stripeService();
		const worker = (workerId: string) =>
			new AutoTopupWorker({
				workerId,
				repository: context.repository,
				providerForProject: () => provider,
				logger: { error() {} },
			});
		const runs = await Promise.all([worker("topup-a").runOnce(), worker("topup-b").runOnce()]);
		expect(runs.reduce((sum, run) => sum + run.claimed, 0)).toBe(1);
		expect(runs.reduce((sum, run) => sum + run.succeeded, 0)).toBe(1);

		const balance = await fixture.app.request(
			`/v1/billing-accounts/${account}/balances/ai_credits`,
			{ headers: fixture.authHeaders() },
		);
		expect((await balance.json()).data).toMatchObject({
			granted: "20",
			consumed: "6",
			available: "14",
		});
		const [state] = await context.sql<
			Array<{
				jobs: number;
				purchases: number;
				invoices: number;
				allocations: number;
				projections: number;
			}>
		>`
			SELECT
				(SELECT count(*)::integer FROM auto_topup_jobs WHERE status = 'succeeded') AS jobs,
				(SELECT count(*)::integer FROM purchases) AS purchases,
				(SELECT count(*)::integer FROM billing_invoices) AS invoices,
				(SELECT count(*)::integer FROM balance_allocations WHERE source_kind = 'topup') AS allocations,
				(SELECT count(*)::integer FROM projection_sync_jobs
					WHERE idempotency_key LIKE 'auto-topup:%') AS projections
		`;
		expect(state).toEqual({ jobs: 1, purchases: 1, invoices: 1, allocations: 1, projections: 1 });
		expect((await worker("topup-restart").runOnce()).claimed).toBe(0);

		const actionAccount = "worker-topup-action";
		await context.repository.grantAllocation(project, {
			billingAccountId: actionAccount,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:worker-topup-action",
		});
		await linkStripeCustomer(context.sql, actionAccount, "cus_worker_topup_action");
		const actionPolicy = await putJson(
			fixture.app,
			`/v1/billing-accounts/${actionAccount}/auto-topup`,
			actorHeaders(fixture.authHeaders()),
			{
				featureKey: "ai_credits",
				topupKey: "credits_10",
				provider: "stripe",
				thresholdQuantity: "5",
				maxPurchasesPerInterval: 2,
				maxSpendMinor: 1000,
				maxConsecutiveFailures: 3,
			},
		);
		await consume(fixture, actionAccount, "6", "worker-topup-action:trigger");
		const actionProvider = stripeService({ paymentBehavior: "action_required" });
		const actionRun = await new AutoTopupWorker({
			workerId: "topup-action",
			repository: context.repository,
			providerForProject: () => actionProvider,
			logger: { error() {} },
		}).runOnce();
		expect(actionRun).toMatchObject({ claimed: 1, actionRequired: 1, circuitOpened: 1 });
		const policyId = (await actionPolicy.json()).data.id as string;
		const reset = await postJson(
			fixture.app,
			`/v1/admin/auto-topups/${actionAccount}/${policyId}/reset`,
			operatorHeaders(fixture.authHeaders()),
			{},
		);
		expect(reset.status).toBe(200);
		expect((await reset.json()).data).toMatchObject({ active: true, status: "ready" });
	});

	it("invoices graduated and volume tiers and a late correction through the recurring billing worker", async () => {
		await seedTieredUsageSubscription(context.sql, "graduated-account", "graduated");
		await seedTieredUsageSubscription(context.sql, "volume-account", "volume");
		const activeLimits = await context.sql<
			Array<{ account: string; feature: string; overage: string; status: string }>
		>`
			SELECT customer.billing_account_id AS account, feature.key AS feature,
				item.overage_policy AS overage, subscription.status
			FROM subscriptions subscription
			JOIN customers customer ON customer.project_id = subscription.project_id
				AND customer.id = subscription.customer_id
			JOIN plan_items item ON item.project_id = subscription.project_id
				AND item.plan_version_id = subscription.plan_version_id
			JOIN features feature ON feature.project_id = item.project_id AND feature.id = item.feature_id
			WHERE customer.billing_account_id IN ('graduated-account', 'volume-account')
			ORDER BY account
		`;
		expect(activeLimits).toEqual([
			{
				account: "graduated-account",
				feature: "api_calls_graduated",
				overage: "allowed",
				status: "active",
			},
			{
				account: "volume-account",
				feature: "api_calls_volume",
				overage: "allowed",
				status: "active",
			},
		]);
		const graduated = await context.repository.consumeUsage(project, {
			billingAccountId: "graduated-account",
			featureKey: "api_calls_graduated",
			quantity: "275.5",
			idempotencyKey: "graduated:usage",
		});
		expect(graduated).toMatchObject({ allowed: true });
		const volume = await context.repository.consumeUsage(project, {
			billingAccountId: "volume-account",
			featureKey: "api_calls_volume",
			quantity: "275",
			idempotencyKey: "volume:usage",
		});
		expect(volume.allowed).toBe(true);
		const windowsBeforeClose = await context.sql<
			Array<{
				account: string;
				usage: string;
				subscription_id: string | null;
				plan_item_id: string | null;
			}>
		>`
			SELECT customer.billing_account_id AS account, usage_window.usage::text AS usage,
				usage_window.subscription_id::text,
				usage_window.anchor_plan_item_id::text AS plan_item_id
			FROM usage_windows usage_window
			JOIN customers customer ON customer.project_id = usage_window.project_id
				AND customer.id = usage_window.customer_id
			WHERE customer.billing_account_id IN ('graduated-account', 'volume-account')
			ORDER BY account
		`;
		expect(windowsBeforeClose).toEqual([
			{
				account: "graduated-account",
				usage: "275.500000000",
				subscription_id: expect.any(String),
				plan_item_id: expect.any(String),
			},
			{
				account: "volume-account",
				usage: "275.000000000",
				subscription_id: expect.any(String),
				plan_item_id: expect.any(String),
			},
		]);
		await closeUsageWindows(context.sql);

		const worker = new RecurringBillingWorker({
			workerId: "tier-worker",
			repository: context.repository,
			providerForProject: () => stripeService(),
			logger: { error() {} },
		});
		expect(await worker.runOnce()).toMatchObject({
			materializedUsagePeriods: 2,
			usageInvoicesCreated: 2,
			failed: 0,
		});
		const periods = await context.sql<
			Array<{ account: string; model: string; amount: string; status: string }>
		>`
			SELECT customer.billing_account_id AS account, price.pricing_model AS model,
				period.amount_minor::text AS amount, period.status
			FROM usage_invoice_periods period
			JOIN customers customer ON customer.project_id = period.project_id
				AND customer.id = period.customer_id
			JOIN price_components price ON price.project_id = period.project_id
				AND price.id = period.price_component_id
			ORDER BY account
		`;
		expect(periods).toEqual([
			{ account: "graduated-account", model: "graduated", amount: "406", status: "invoiced" },
			{ account: "volume-account", model: "volume", amount: "340", status: "invoiced" },
		]);

		if (graduated.usageEventId === null || graduated.recordedAt === null) {
			throw new Error("Expected graduated usage receipt");
		}
		await context.repository.correctUsage(project, {
			billingAccountId: "graduated-account",
			originalUsageEventId: graduated.usageEventId,
			originalRecordedAt: new Date(graduated.recordedAt),
			quantity: "100",
			reason: "remove duplicated usage",
			actor,
			idempotencyKey: "graduated:correction",
		});
		expect(await worker.runOnce()).toMatchObject({
			materializedUsagePeriods: 0,
			usageAdjustmentsCreated: 1,
			failed: 0,
		});
		const [adjustment] = await context.sql<Array<{ amount: string; status: string }>>`
			SELECT amount_minor::text AS amount, status FROM usage_invoice_adjustments
		`;
		expect(adjustment).toEqual({ amount: "-125", status: "invoiced" });
	});

	it("uses operator HTTP contracts and migrations and customer HTTP license assignments", async () => {
		await seedPhase3CatalogMigration(context.sql);
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const auth = fixture.authHeaders();
		const contractIntent = {
			billingAccountId: "migration-stripe",
			contractKey: "enterprise-2026",
			version: 1,
			planKey: "migration-plan",
			effectiveAt: new Date(Date.now() - 60_000).toISOString(),
			replacesCommercialDefaults: true,
			controls: [
				{
					controlKind: "usage_limit",
					featureKey: "licensed_seats",
					currency: null,
					limitValue: "7",
					interval: "lifetime",
				},
			],
		};
		expect(
			(await postJson(fixture.app, "/v1/admin/contracts/preview", auth, contractIntent)).status,
		).toBe(401);
		const operator = operatorHeaders(auth);
		const previewResponse = await postJson(
			fixture.app,
			"/v1/admin/contracts/preview",
			operator,
			contractIntent,
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).data;
		const publish = await postJson(fixture.app, "/v1/admin/contracts/publish", operator, {
			...contractIntent,
			previewToken: preview.previewToken,
		});
		expect(publish.status).toBe(200);
		const contracts = await fixture.app.request("/v1/admin/contracts/migration-stripe", {
			headers: operator,
		});
		expect((await contracts.json()).data).toHaveLength(1);

		for (const entityId of ["workspace-a", "workspace-b"]) {
			expect(
				(
					await postJson(fixture.app, "/v1/billing-accounts/migration-stripe/entities", auth, {
						externalId: entityId,
						kind: "workspace",
					})
				).status,
			).toBe(201);
		}
		const pools = await fixture.app.request("/v1/billing-accounts/migration-stripe/license-pools", {
			headers: auth,
		});
		const [pool] = (await pools.json()).data as Array<{ id: string }>;
		const assignment = await postJson(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/license-assignments",
			actorHeaders(auth),
			{ poolId: pool?.id, entityId: "workspace-a", quantity: 7 },
		);
		expect(assignment.status).toBe(201);
		expect(
			(
				await postJson(
					fixture.app,
					"/v1/billing-accounts/migration-stripe/license-assignments",
					actorHeaders(auth),
					{ poolId: pool?.id, entityId: "workspace-b", quantity: 1 },
				)
			).status,
		).toBe(409);
		const check = await fixture.app.request(
			"/v1/billing-accounts/migration-stripe/entities/workspace-a/licenses/licensed_seats?quantity=7",
			{ headers: auth },
		);
		expect((await check.json()).data).toMatchObject({ allowed: true, assignedQuantity: 7 });

		const migrationIntent = {
			fromPlanKey: "migration-plan",
			fromVersion: 1,
			toPlanKey: "migration-plan",
			toVersion: 2,
			effectiveMode: "immediate",
		};
		const migrationPreviewResponse = await postJson(
			fixture.app,
			"/v1/admin/catalog-migrations/preview",
			operator,
			migrationIntent,
		);
		const migrationPreview = (await migrationPreviewResponse.json()).data;
		expect(migrationPreview.matchingSubscriptions).toBe(2);
		expect(
			(
				await postJson(fixture.app, "/v1/admin/catalog-migrations/publish", operator, {
					...migrationIntent,
					previewToken: migrationPreview.previewToken,
				})
			).status,
		).toBe(200);

		const worker = new RecurringBillingWorker({
			workerId: "migration-worker",
			repository: context.repository,
			providerForProject: () => stripeService(),
			logger: { error() {} },
		});
		expect(await worker.runOnce()).toMatchObject({ subscriptionChangesApplied: 1, failed: 0 });
		const migrations = await context.sql<Array<{ provider: string; status: string }>>`
			SELECT subscription.provider, job.status
			FROM catalog_migration_jobs job
			JOIN subscriptions subscription ON subscription.id = job.subscription_id
			ORDER BY subscription.provider
		`;
		expect(migrations).toEqual([
			{ provider: "apple", status: "skipped" },
			{ provider: "stripe", status: "applied" },
		]);
		expect((await worker.runOnce()).subscriptionChangesApplied).toBe(0);
	});
});

function stripeService(options: FakeStripeBillingClientOptions = {}): StripeBillingService {
	const config = stripeConfig();
	return new StripeBillingService({
		config: {
			projectKey: "voysee",
			checkoutSuccessUrl: config.checkoutSuccessUrl,
			checkoutCancelUrl: config.checkoutCancelUrl,
			portalReturnUrl: config.portalReturnUrl,
		},
		client: new FakeStripeBillingClient(config, options),
		repository: context.repository.forProject(project),
	});
}

function stripeConfig(): StripeBillingConfig {
	return {
		apiVersion: STRIPE_API_VERSION,
		secretKey: "sk_test_billing_fake",
		webhookSecret: "whsec_phase3_integration",
		checkoutSuccessUrl:
			"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
		checkoutCancelUrl: "https://app.integration.test/billing",
		portalReturnUrl: "https://app.integration.test/account/billing",
		taxMode: "disabled",
	};
}

async function consume(
	fixture: ReturnType<typeof createIntegrationApp>,
	billingAccountId: string,
	quantity: string,
	idempotencyKey: string,
) {
	const response = await postJson(
		fixture.app,
		`/v1/billing-accounts/${billingAccountId}/usage/consume`,
		{ ...fixture.authHeaders(), "idempotency-key": idempotencyKey },
		{ featureKey: "ai_credits", quantity },
	);
	expect(response.status).toBe(200);
	return (await response.json()).data as {
		allowed: boolean;
		reason: string | null;
		usageEventId: string | null;
		recordedAt: string | null;
	};
}

function usageLimitBody(limitValue: string) {
	return {
		controlKind: "usage_limit",
		featureKey: "ai_credits",
		limitValue,
		interval: "lifetime",
	};
}

function actorHeaders(headers: HeadersInit): HeadersInit {
	return { ...headers, "x-billing-actor": actor };
}

function operatorHeaders(headers: HeadersInit): HeadersInit {
	return {
		...actorHeaders(headers),
		"x-billing-operator-key": "billing-integration-operator-key",
	};
}

async function postJson(
	app: ReturnType<typeof createIntegrationApp>["app"],
	path: string,
	headers: HeadersInit,
	body: unknown,
): Promise<Response> {
	return await app.request(path, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function putJson(
	app: ReturnType<typeof createIntegrationApp>["app"],
	path: string,
	headers: HeadersInit,
	body: unknown,
): Promise<Response> {
	return await app.request(path, {
		method: "PUT",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function seedTieredUsageSubscription(
	sql: SQL,
	billingAccountId: string,
	pricingModel: "graduated" | "volume",
): Promise<void> {
	const featureKey = `api_calls_${pricingModel}`;
	const planKey = `tiered_${pricingModel}`;
	const externalProductId = `prod_usage_${pricingModel}`;
	const externalPriceId = `price_usage_${pricingModel}`;
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, ${featureKey}, ${featureKey}, 'metered', 'consumable', 'call', 1
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		WITH target AS (
			SELECT project.id AS project_id, revision.id AS revision_id
			FROM projects project
			JOIN catalog_revisions revision ON revision.project_id = project.id AND revision.revision = 1
			WHERE project.key = 'voysee'
		), plan AS (
			INSERT INTO plans (project_id, key, name)
			SELECT project_id, ${planKey}, ${planKey} FROM target
			RETURNING id, project_id
		), version AS (
			INSERT INTO plan_versions (
				project_id, plan_id, catalog_revision_id, version, status, currency,
				base_amount_minor, billing_interval
			)
			SELECT plan.project_id, plan.id, target.revision_id, 1, 'published', 'USD', 0, 'month'
			FROM plan, target
			RETURNING id, project_id, plan_id
		), item AS (
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity,
				reset_interval, overage_policy
			)
			SELECT version.project_id, version.id, feature.id, 'meter_limit', 25, 'month', 'allowed'
			FROM version
			JOIN features feature ON feature.project_id = version.project_id AND feature.key = ${featureKey}
			RETURNING id, project_id, plan_version_id
		), price AS (
			INSERT INTO price_components (
				project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing,
				currency, unit_amount_minor, billing_units, billing_interval, pricing_model
			)
			SELECT project_id, plan_version_id, id, 'overage', 'metered_overage', 'in_arrears',
				'USD', 0, 10, 'month', ${pricingModel}
			FROM item
			RETURNING id, project_id, plan_version_id
		)
		UPDATE plans SET active_version_id = version.id
		FROM version WHERE plans.project_id = version.project_id AND plans.id = version.plan_id
	`;
	await sql`
		UPDATE plans SET active_version_id = version.id
		FROM plan_versions version
		WHERE plans.project_id = version.project_id AND plans.id = version.plan_id
			AND plans.key = ${planKey} AND version.version = 1
	`;
	await sql`
		INSERT INTO price_tiers (
			project_id, price_component_id, ordinal, up_to_quantity,
			unit_amount_minor, flat_amount_minor
		)
		SELECT price.project_id, price.id, tier.ordinal, tier.up_to, tier.unit_amount, tier.flat_amount
		FROM price_components price
		JOIN plan_versions version ON version.project_id = price.project_id
			AND version.id = price.plan_version_id
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		CROSS JOIN (
			VALUES
				(0, 100::numeric, 20, CASE WHEN ${pricingModel} = 'graduated' THEN 5 ELSE 0 END),
				(1, CASE WHEN ${pricingModel} = 'graduated' THEN 200::numeric ELSE 500::numeric END,
					CASE WHEN ${pricingModel} = 'graduated' THEN 15 ELSE 12 END,
					CASE WHEN ${pricingModel} = 'volume' THEN 40 ELSE 0 END),
				(2, NULL::numeric, CASE WHEN ${pricingModel} = 'graduated' THEN 10 ELSE 8 END, 0)
		) AS tier(ordinal, up_to, unit_amount, flat_amount)
		WHERE plan.key = ${planKey} AND price.component_kind = 'metered_overage'
	`;
	await sql`
		INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type, active)
		SELECT id, ${`usage_${pricingModel}`}, ${`usage_${pricingModel}`}, 0,
			${`Usage ${pricingModel}`}, 'subscription', true
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id,
			external_price_id, billing_period, currency, price_amount, active
		)
		SELECT project.id, product.id, 'stripe', 'web', ${externalProductId},
			${externalPriceId}, 'month', 'USD', 0, true
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = ${`usage_${pricingModel}`}
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO provider_price_bindings (
			project_id, price_component_id, store_product_id, provider, channel, status
		)
		SELECT price.project_id, price.id, store.id, 'stripe', 'web', 'published'
		FROM price_components price
		JOIN plan_versions version ON version.project_id = price.project_id AND version.id = price.plan_version_id
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN store_products store ON store.project_id = price.project_id
			AND store.external_price_id = ${externalPriceId}
		WHERE plan.key = ${planKey}
	`;
	await linkStripeCustomer(sql, billingAccountId, `cus_${pricingModel}`);
	await sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, current_period_start, current_period_end, auto_renew,
			plan_version_id, catalog_revision_id
		)
		SELECT project.id, customer.id, product.id, store.id, 'stripe', 'web',
			${`sub_${pricingModel}`}, store.external_product_id, store.external_price_id, 'active',
			now() - interval '1 day', now() - interval '1 day', now() + interval '29 days', true,
			version.id, version.catalog_revision_id
		FROM projects project
		JOIN customers customer ON customer.project_id = project.id
			AND customer.billing_account_id = ${billingAccountId}
		JOIN products product ON product.project_id = project.id AND product.key = ${`usage_${pricingModel}`}
		JOIN store_products store ON store.project_id = product.project_id AND store.product_id = product.id
		JOIN plans plan ON plan.project_id = project.id AND plan.key = ${planKey}
		JOIN plan_versions version ON version.project_id = plan.project_id
			AND version.id = plan.active_version_id
		WHERE project.key = 'voysee'
	`;
}

async function closeUsageWindows(sql: SQL): Promise<void> {
	await sql`
		UPDATE usage_windows SET
			window_start_at = now() - interval '30 days',
			window_end_at = now() - interval '1 second'
	`;
	await sql`
		UPDATE usage_events event
		SET metadata = event.metadata || jsonb_build_object(
			'usageWindowStartAt', usage_window.window_start_at,
			'usageWindowEndAt', usage_window.window_end_at
		)
		FROM usage_windows usage_window
		WHERE event.project_id = usage_window.project_id
			AND event.metadata->>'usageWindowId' = usage_window.id::text
	`;
}
