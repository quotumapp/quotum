import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { runAutoTopupWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

localDescribe("Phase 3 controls and automatic top-ups", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedControlCatalog(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("persists threshold crossings once, rearms after a correction, and crosses again", async () => {
		await context.repository.grantAllocation(project, {
			billingAccountId: "alert-account",
			featureKey: "ai_credits",
			quantity: "20",
			sourceKind: "operator",
			sourceKey: "fixture:alert-account",
		});
		await context.repository.controlsEnterprise.createUsageAlert(project, {
			billingAccountId: "alert-account",
			featureKey: "ai_credits",
			thresholdType: "absolute",
			thresholdValue: "5",
			interval: "lifetime",
			actor: "integration-test",
		});

		await consume("alert-account", "3", "alert:1");
		const crossing = await consume("alert-account", "3", "alert:2");
		await consume("alert-account", "1", "alert:3");
		expect(
			await context.repository.controlsEnterprise.listUsageAlertEvents(
				project,
				"alert-account",
				100,
			),
		).toHaveLength(1);

		await context.repository.correctUsage(project, {
			billingAccountId: "alert-account",
			originalUsageEventId: crossing.usageEventId ?? "",
			originalRecordedAt: new Date(crossing.recordedAt ?? ""),
			quantity: "3",
			idempotencyKey: "alert:correction",
			actor: "integration-test",
			reason: "rearm threshold",
		});
		await consume("alert-account", "2", "alert:4");

		const events = await context.repository.controlsEnterprise.listUsageAlertEvents(
			project,
			"alert-account",
			100,
		);
		expect(events.map((event) => event.eventType).reverse()).toEqual([
			"threshold_crossed",
			"threshold_rearmed",
			"threshold_crossed",
		]);
		const [state] = await context.sql<
			Array<{ current_value: string; crossed: boolean; crossing_sequence: number }>
		>`
			SELECT current_value::text, crossed, crossing_sequence FROM usage_alert_states
		`;
		expect(state).toEqual({
			current_value: "6.000000000",
			crossed: true,
			crossing_sequence: 2,
		});
	});

	it("reserves the safety budget before Stripe and grants the purchased allocation atomically", async () => {
		await prepareAutoTopupAccount("topup-account");
		await context.repository.grantAllocation(project, {
			billingAccountId: "topup-account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:topup-account",
		});
		await context.repository.controlsEnterprise.upsertAutoTopupPolicy(project, {
			billingAccountId: "topup-account",
			featureKey: "ai_credits",
			topupKey: "credits_10",
			provider: "stripe",
			thresholdQuantity: "5",
			cooldownSeconds: 30,
			limitIntervalSeconds: 86_400,
			maxPurchasesPerInterval: 2,
			maxSpendMinor: 1_000,
			maxConsecutiveFailures: 3,
			actor: "integration-test",
		});
		await consume("topup-account", "6", "topup:trigger");

		const [scheduled] = await context.sql<
			Array<{ status: string; amount_minor: string; external_price_id: string }>
		>`
			SELECT job.status, job.amount_minor::text, store.external_price_id
			FROM auto_topup_jobs job
			JOIN store_products store ON store.id = job.store_product_id
		`;
		expect(scheduled).toEqual({
			status: "pending",
			amount_minor: "499",
			external_price_id: "price_credits_10",
		});

		const [job] = await context.repository.claimAutoTopupJobs(
			"auto-worker",
			10,
			new Date(Date.now() - 300_000),
		);
		expect(job).toMatchObject({
			billingAccountId: "topup-account",
			externalCustomerId: "cus_auto_topup",
			externalPriceId: "price_credits_10",
			amountMinor: 499,
			maximumChargeMinor: 1000,
			currency: "USD",
		});
		expect(
			await context.repository.claimAutoTopupJobs(
				"other-worker",
				10,
				new Date(Date.now() - 300_000),
			),
		).toEqual([]);
		const [reserved] = await context.sql<
			Array<{ purchases: number; spend: string; reserved: boolean }>
		>`
			SELECT state.purchases_in_interval AS purchases,
				state.spend_minor_in_interval::text AS spend,
				job.budget_reserved_at IS NOT NULL AS reserved
			FROM auto_topup_states state
			JOIN auto_topup_jobs job ON job.project_id = state.project_id AND job.policy_id = state.policy_id
		`;
		expect(reserved).toEqual({ purchases: 1, spend: "499", reserved: true });

		expect(
			await context.repository.markAutoTopupSucceeded(job.projectId, job.jobId, "auto-worker", {
				status: "succeeded",
				externalInvoiceId: "in_auto_1",
				externalPaymentId: "pi_auto_1",
				amountPaidMinor: 499,
				currency: "USD",
			}),
		).toEqual({ circuitOpened: false });
		expect(
			await context.repository.markAutoTopupSucceeded(job.projectId, job.jobId, "auto-worker", {
				status: "succeeded",
				externalInvoiceId: "in_auto_1",
				externalPaymentId: "pi_auto_1",
				amountPaidMinor: 499,
				currency: "USD",
			}),
		).toEqual({ circuitOpened: false });

		expect(
			await context.repository.getMeteringBalance(project, "topup-account", "ai_credits"),
		).toMatchObject({ granted: "20", consumed: "6", available: "14" });
		const [durable] = await context.sql<
			Array<{
				job_status: string;
				purchases: number;
				spend: string;
				allocations: number;
				purchases_recorded: number;
				invoices: number;
				projections: number;
			}>
		>`
			SELECT
				(SELECT status FROM auto_topup_jobs LIMIT 1) AS job_status,
				(SELECT purchases_in_interval FROM auto_topup_states LIMIT 1) AS purchases,
				(SELECT spend_minor_in_interval::text FROM auto_topup_states LIMIT 1) AS spend,
				(SELECT count(*)::integer FROM balance_allocations WHERE source_kind = 'topup') AS allocations,
				(SELECT count(*)::integer FROM purchases WHERE transaction_id = 'pi_auto_1') AS purchases_recorded,
				(SELECT count(*)::integer FROM billing_invoices WHERE external_invoice_id = 'in_auto_1') AS invoices,
				(SELECT count(*)::integer FROM projection_sync_jobs WHERE idempotency_key LIKE 'auto-topup:%') AS projections
		`;
		expect(durable).toEqual({
			job_status: "succeeded",
			purchases: 1,
			spend: "499",
			allocations: 1,
			purchases_recorded: 1,
			invoices: 1,
			projections: 1,
		});
	});

	it("retries a Stripe 429 auto top-up through the worker and then charges once", async () => {
		await prepareAutoTopupAccount("topup-account");
		await context.repository.grantAllocation(project, {
			billingAccountId: "topup-account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:topup-account",
		});
		await context.repository.controlsEnterprise.upsertAutoTopupPolicy(project, {
			billingAccountId: "topup-account",
			featureKey: "ai_credits",
			topupKey: "credits_10",
			provider: "stripe",
			thresholdQuantity: "5",
			cooldownSeconds: 30,
			limitIntervalSeconds: 86_400,
			maxPurchasesPerInterval: 2,
			maxSpendMinor: 1_000,
			maxConsecutiveFailures: 3,
			actor: "integration-test",
		});
		await consume("topup-account", "6", "topup:trigger");
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const stripeService = new StripeBillingService({
			config: {
				projectKey: "voysee",
				checkoutSuccessUrl: "https://app.integration.test/billing/success",
				checkoutCancelUrl: "https://app.integration.test/billing",
				portalReturnUrl: "https://app.integration.test/account/billing",
			},
			client: fixture.stripe.client,
			repository: context.repository.forProject(project),
		});
		fixture.stripe.failNext(
			"payInvoice",
			Object.assign(new Error("Rate limited"), { statusCode: 429 }),
		);
		const failed = await runAutoTopupWorkerOnce({
			repository: context.repository,
			provider: stripeService,
			workerId: "auto-worker",
		});
		expect(failed).toMatchObject({ claimed: 1, succeeded: 0, retryScheduled: 1 });
		const [retrying] = await context.sql<
			Array<{ status: string; reserved: boolean; purchases: number }>
		>`
			SELECT job.status, job.budget_reserved_at IS NOT NULL AS reserved,
				state.purchases_in_interval AS purchases
			FROM auto_topup_jobs job
			JOIN auto_topup_states state
				ON state.project_id = job.project_id AND state.policy_id = job.policy_id
		`;
		expect(retrying).toEqual({ status: "pending", reserved: false, purchases: 0 });
		await context.sql`
			UPDATE auto_topup_jobs SET next_attempt_at = now() - INTERVAL '1 second'
		`;
		const succeeded = await runAutoTopupWorkerOnce({
			repository: context.repository,
			provider: stripeService,
			workerId: "auto-worker",
		});
		expect(succeeded).toMatchObject({ claimed: 1, succeeded: 1 });
		const [invoices] = await context.sql<Array<{ count: number }>>`
			SELECT count(*)::integer AS count FROM billing_invoices
		`;
		expect(invoices.count).toBe(1);
	});

	it("releases reserved budget on failure and suspends after provider action is required", async () => {
		await prepareAutoTopupAccount("failure-account");
		await context.repository.grantAllocation(project, {
			billingAccountId: "failure-account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:failure-account",
		});
		await context.repository.controlsEnterprise.upsertAutoTopupPolicy(project, {
			billingAccountId: "failure-account",
			featureKey: "ai_credits",
			topupKey: "credits_10",
			provider: "stripe",
			thresholdQuantity: "5",
			maxPurchasesPerInterval: 2,
			maxSpendMinor: 1_000,
			maxConsecutiveFailures: 3,
			actor: "integration-test",
		});
		await consume("failure-account", "6", "failure:trigger");
		const [first] = await context.repository.claimAutoTopupJobs(
			"auto-worker",
			10,
			new Date(Date.now() - 300_000),
		);
		const retryAt = new Date(Date.now() - 1_000);
		expect(
			await context.repository.markAutoTopupFailed(first.projectId, first.jobId, "auto-worker", {
				kind: "retryable",
				error: "temporary network failure",
				nextAttemptAt: retryAt,
			}),
		).toEqual({ retryScheduled: true, circuitOpened: false });
		const [afterRetry] = await context.sql<
			Array<{ purchases: number; spend: string; failures: number; status: string }>
		>`
			SELECT purchases_in_interval AS purchases, spend_minor_in_interval::text AS spend,
				consecutive_failures AS failures, status FROM auto_topup_states
		`;
		expect(afterRetry).toEqual({ purchases: 0, spend: "0", failures: 1, status: "cooldown" });

		const [second] = await context.repository.claimAutoTopupJobs(
			"auto-worker",
			10,
			new Date(Date.now() - 300_000),
		);
		expect(
			await context.repository.markAutoTopupFailed(second.projectId, second.jobId, "auto-worker", {
				kind: "action_required",
				error: "saved payment method requires authentication",
				nextAttemptAt: null,
				externalInvoiceId: "in_action",
				externalPaymentId: "pi_action",
			}),
		).toEqual({ retryScheduled: false, circuitOpened: true });
		const [terminal] = await context.sql<
			Array<{
				job_status: string;
				state_status: string;
				purchases: number;
				spend: string;
				failures: number;
				circuit_open: boolean;
			}>
		>`
			SELECT job.status AS job_status, state.status AS state_status,
				state.purchases_in_interval AS purchases, state.spend_minor_in_interval::text AS spend,
				state.consecutive_failures AS failures, state.circuit_opened_at IS NOT NULL AS circuit_open
			FROM auto_topup_jobs job
			JOIN auto_topup_states state ON state.project_id = job.project_id AND state.policy_id = job.policy_id
		`;
		expect(terminal).toEqual({
			job_status: "provider_action_required",
			state_status: "suspended",
			purchases: 0,
			spend: "0",
			failures: 2,
			circuit_open: true,
		});
	});

	it("grandfathers subscriptions until an approved migration stages a provider-safe change", async () => {
		await seedCatalogMigration(context.sql);
		const before = await context.sql<Array<{ provider: string; version: number }>>`
			SELECT subscription.provider, version.version
			FROM subscriptions subscription
			JOIN plan_versions version ON version.id = subscription.plan_version_id
			WHERE subscription.external_subscription_id IN ('sub_migrate_stripe', 'sub_migrate_apple')
			ORDER BY subscription.provider
		`;
		expect(before).toEqual([
			{ provider: "apple", version: 1 },
			{ provider: "stripe", version: 1 },
		]);

		const preview = await context.repository.controlsEnterprise.previewCatalogMigration(project, {
			fromPlanKey: "migration-plan",
			fromVersion: 1,
			toPlanKey: "migration-plan",
			toVersion: 2,
			effectiveMode: "immediate",
			actor: "integration-test",
		});
		expect(preview.matchingSubscriptions).toBe(2);
		const published = await context.repository.controlsEnterprise.publishCatalogMigration(project, {
			fromPlanKey: "migration-plan",
			fromVersion: 1,
			toPlanKey: "migration-plan",
			toVersion: 2,
			effectiveMode: "immediate",
			actor: "integration-test",
			previewToken: preview.previewToken,
		});
		expect(published).toMatchObject({ queued: 2, duplicate: false });

		const [change] = await context.repository.claimSubscriptionChanges("migration-worker", 10);
		expect(change).toMatchObject({
			status: "processing",
			externalSubscriptionId: "sub_migrate_stripe",
			targetPlanVersionId: preview.toPlanVersionId,
			items: [
				{
					providerSubscriptionItemId: "si_migrate_base",
					externalPriceId: "price_migrate_v2_base",
					quantity: 1,
				},
				{
					providerSubscriptionItemId: "si_migrate_seats",
					externalPriceId: "price_migrate_v2_seats",
					quantity: 7,
				},
			],
		});
		expect(await context.repository.claimSubscriptionChanges("other-worker", 10)).toEqual([]);

		await expect(
			context.repository.markSubscriptionChangeApplied(
				integrationProjectContext("wiseley").projectInstanceId,
				change?.changeId ?? "",
				"sub_migrate_stripe",
				"migration-worker",
			),
		).rejects.toThrow("was not owned by worker");
		await expect(
			context.repository.markSubscriptionChangeApplied(
				project.projectInstanceId,
				change?.changeId ?? "",
				"sub_migrate_stripe",
				"stale-worker",
			),
		).rejects.toThrow("was not owned by worker");
		await context.repository.markSubscriptionChangeApplied(
			project.projectInstanceId,
			change?.changeId ?? "",
			"sub_migrate_stripe",
			"migration-worker",
		);
		const jobs = await context.sql<
			Array<{ provider: string; status: string; last_error: string | null }>
		>`
			SELECT subscription.provider, job.status, job.last_error
			FROM catalog_migration_jobs job
			JOIN subscriptions subscription ON subscription.id = job.subscription_id
			ORDER BY subscription.provider
		`;
		expect(jobs).toEqual([
			{
				provider: "apple",
				status: "skipped",
				last_error: "Provider action required: apple subscriptions cannot be silently migrated",
			},
			{ provider: "stripe", status: "applied", last_error: null },
		]);
	});

	it("versions customer contracts, preserves future schedules, and applies safety precedence", async () => {
		await seedCatalogMigration(context.sql);
		await context.sql`
			UPDATE plan_versions version
			SET visibility = 'customer_specific', customer_id = customer.id
			FROM plans plan, customers customer, projects project
			WHERE version.project_id = project.id AND version.plan_id = plan.id
				AND customer.project_id = project.id
				AND project.key = 'voysee' AND plan.key = 'migration-plan'
				AND version.version = 2 AND customer.billing_account_id = 'migration-stripe'
		`;
		await context.sql`
			INSERT INTO control_policies (
				project_id, source_type, plan_version_id, control_kind, feature_id,
				currency, limit_value, interval, revision, created_by
			)
			SELECT version.project_id, 'plan_default', version.id, control.kind,
				CASE WHEN control.kind = 'usage_limit' THEN feature.id ELSE NULL END,
				CASE WHEN control.kind = 'spend_limit' THEN 'USD' ELSE NULL END,
				control.amount, 'lifetime', 1, 'integration-test'
			FROM plan_versions version
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'ai_credits'
			CROSS JOIN (VALUES ('usage_limit', 100), ('spend_limit', 1000)) AS control(kind, amount)
			WHERE plan.key = 'migration-plan' AND version.version = 1
		`;

		const customPlan = await context.repository.getStripeRecurringCheckoutPlanByKey(
			project,
			"migration-plan",
			"migration-stripe",
		);
		expect(customPlan.planKey).toBe("migration-plan");
		await expect(
			context.repository.getStripeRecurringCheckoutPlanByKey(
				project,
				"migration-plan",
				"migration-apple",
			),
		).rejects.toThrow("Active plan migration-plan was not found");

		const currentIntent = {
			billingAccountId: "migration-stripe",
			contractKey: "negotiated-2026",
			version: 1,
			planKey: "migration-plan",
			effectiveAt: new Date(Date.now() - 60_000),
			replacesCommercialDefaults: true,
			controls: [
				{
					controlKind: "usage_limit" as const,
					featureKey: "ai_credits",
					currency: null,
					limitValue: "150",
					interval: "lifetime" as const,
				},
			],
			actor: "integration-test",
		};
		const currentPreview = await context.repository.controlsEnterprise.previewEnterpriseContract(
			project,
			currentIntent,
		);
		expect(
			await context.repository.controlsEnterprise.previewEnterpriseContract(project, currentIntent),
		).toMatchObject({ previewToken: currentPreview.previewToken });
		const current = await context.repository.controlsEnterprise.publishEnterpriseContract(project, {
			...currentIntent,
			previewToken: currentPreview.previewToken,
		});
		expect(
			await context.repository.controlsEnterprise.listEffectiveControls(
				project,
				"migration-stripe",
			),
		).toMatchObject([
			{
				controlKind: "spend_limit",
				limitValue: "1000",
				source: "plan_default",
			},
			{
				controlKind: "usage_limit",
				limitValue: "150",
				source: "contract",
			},
		]);

		await context.repository.controlsEnterprise.upsertControl(project, {
			billingAccountId: "migration-stripe",
			controlKind: "usage_limit",
			featureKey: "ai_credits",
			limitValue: "120",
			interval: "lifetime",
			actor: "integration-test",
		});
		const tightened = await context.repository.controlsEnterprise.listEffectiveControls(
			project,
			"migration-stripe",
		);
		expect(tightened.find((control) => control.controlKind === "usage_limit")).toMatchObject({
			limitValue: "120",
			source: "account",
		});

		const futureIntent = {
			...currentIntent,
			version: 2,
			effectiveAt: new Date(Date.now() + 86_400_000),
			controls: [{ ...currentIntent.controls[0], limitValue: "200" }],
		};
		const futurePreview = await context.repository.controlsEnterprise.previewEnterpriseContract(
			project,
			futureIntent,
		);
		await context.repository.controlsEnterprise.publishEnterpriseContract(project, {
			...futureIntent,
			previewToken: futurePreview.previewToken,
		});
		expect(
			await context.repository.controlsEnterprise.listEnterpriseContracts(
				project,
				"migration-stripe",
			),
		).toHaveLength(2);
		expect(
			(
				await context.repository.controlsEnterprise.listEffectiveControls(
					project,
					"migration-stripe",
				)
			).find((control) => control.controlKind === "usage_limit"),
		).toMatchObject({ limitValue: "120", source: "account" });

		expect(
			await context.repository.controlsEnterprise.terminateEnterpriseContract(
				project,
				"migration-stripe",
				current.id,
				"integration-test",
			),
		).toMatchObject({ status: "terminated" });
	});

	it("enforces purchased license-pool quantity for entity assignments", async () => {
		await seedCatalogMigration(context.sql);
		await context.repository.controlsEnterprise.createEntity(project, {
			billingAccountId: "migration-stripe",
			externalId: "workspace-a",
			kind: "workspace",
		});
		await context.repository.controlsEnterprise.createEntity(project, {
			billingAccountId: "migration-stripe",
			externalId: "workspace-b",
			kind: "workspace",
		});
		const [pool] = await context.repository.controlsEnterprise.listLicensePools(
			project,
			"migration-stripe",
		);
		expect(pool).toMatchObject({
			featureKey: "licensed_seats",
			quantity: 7,
			assignedQuantity: 0,
			availableQuantity: 7,
			active: true,
		});
		const first = await context.repository.controlsEnterprise.assignLicense(project, {
			billingAccountId: "migration-stripe",
			poolId: pool?.id ?? "",
			entityId: "workspace-a",
			quantity: 3,
			actor: "integration-test",
		});
		expect(
			await context.repository.controlsEnterprise.checkEntityLicense(project, {
				billingAccountId: "migration-stripe",
				entityId: "workspace-a",
				featureKey: "licensed_seats",
				requiredQuantity: 3,
			}),
		).toEqual({
			entityId: "workspace-a",
			featureKey: "licensed_seats",
			requiredQuantity: 3,
			assignedQuantity: 3,
			allowed: true,
		});
		expect(
			await context.repository.controlsEnterprise.checkEntityLicense(project, {
				billingAccountId: "migration-stripe",
				entityId: "workspace-a",
				featureKey: "licensed_seats",
				requiredQuantity: 4,
			}),
		).toMatchObject({ assignedQuantity: 3, allowed: false });
		await expect(
			context.repository.controlsEnterprise.assignLicense(project, {
				billingAccountId: "migration-stripe",
				poolId: pool?.id ?? "",
				entityId: "workspace-b",
				quantity: 5,
				actor: "integration-test",
			}),
		).rejects.toMatchObject({ code: "LICENSE_POOL_EXHAUSTED" });
		await context.repository.controlsEnterprise.assignLicense(project, {
			billingAccountId: "migration-stripe",
			poolId: pool?.id ?? "",
			entityId: "workspace-b",
			quantity: 4,
			actor: "integration-test",
		});
		expect(
			await context.repository.controlsEnterprise.listLicensePools(project, "migration-stripe"),
		).toMatchObject([{ quantity: 7, assignedQuantity: 7, availableQuantity: 0 }]);

		await context.repository.controlsEnterprise.revokeLicense(project, {
			billingAccountId: "migration-stripe",
			assignmentId: first.id,
			actor: "integration-test",
		});
		expect(
			await context.repository.controlsEnterprise.checkEntityLicense(project, {
				billingAccountId: "migration-stripe",
				entityId: "workspace-a",
				featureKey: "licensed_seats",
				requiredQuantity: 1,
			}),
		).toMatchObject({ assignedQuantity: 0, allowed: false });
	});

	async function consume(billingAccountId: string, quantity: string, idempotencyKey: string) {
		return await context.repository.consumeUsage(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity,
			idempotencyKey,
		});
	}

	async function prepareAutoTopupAccount(billingAccountId: string): Promise<void> {
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, ${billingAccountId} FROM projects WHERE key = 'voysee'
		`;
		await context.sql`
			INSERT INTO provider_customers (project_id, customer_id, provider, external_customer_id)
			SELECT project.id, customer.id, 'stripe', 'cus_auto_topup'
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
			WHERE project.key = 'voysee' AND customer.billing_account_id = ${billingAccountId}
		`;
	}
});

async function seedControlCatalog(sql: SQL): Promise<void> {
	await sql`
		INSERT INTO catalog_revisions (project_id, revision, status, intent_hash, created_by, published_at)
		SELECT id, 1, 'published', repeat('a', 64), 'integration-test', now()
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		UPDATE projects SET published_catalog_revision_id = revision.id
		FROM catalog_revisions revision
		WHERE projects.id = revision.project_id AND projects.key = 'voysee'
	`;
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'ai_credits', 'AI credits', 'metered', 'consumable', 'credit', 0
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'model_tokens', 'Model tokens', 'metered', 'consumable', 'token', 0
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		INSERT INTO rate_card_entries (
			project_id, catalog_revision_id, meter_feature_id, wallet_feature_id, rate_per_unit
		)
		SELECT project.id, revision.id, meter.id, wallet.id, 1
		FROM projects project
		JOIN catalog_revisions revision ON revision.project_id = project.id AND revision.revision = 1
		JOIN features meter ON meter.project_id = project.id AND meter.key = 'model_tokens'
		JOIN features wallet ON wallet.project_id = project.id AND wallet.key = 'ai_credits'
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO topup_options (project_id, catalog_revision_id, key, feature_id, quantity)
		SELECT project.id, revision.id, 'credits_10', feature.id, 10
		FROM projects project
		JOIN catalog_revisions revision ON revision.project_id = project.id AND revision.revision = 1
		JOIN features feature ON feature.project_id = project.id AND feature.key = 'ai_credits'
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO provider_topup_bindings (
			project_id, topup_option_id, store_product_id, provider, channel, status
		)
		SELECT project.id, option.id, store.id, 'stripe', 'web', 'published'
		FROM projects project
		JOIN topup_options option ON option.project_id = project.id AND option.key = 'credits_10'
		JOIN store_products store ON store.project_id = project.id
			AND store.provider = 'stripe' AND store.external_price_id = 'price_credits_10'
		WHERE project.key = 'voysee'
	`;
}

async function seedCatalogMigration(sql: SQL): Promise<void> {
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'licensed_seats', 'Licensed seats', 'metered', 'non_consumable', 'seat', 0
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		WITH target AS (
			SELECT project.id AS project_id, revision.id AS revision_id
			FROM projects project
			JOIN catalog_revisions revision ON revision.project_id = project.id
			WHERE project.key = 'voysee' AND revision.revision = 1
		), plan AS (
			INSERT INTO plans (project_id, key, name)
			SELECT project_id, 'migration-plan', 'Migration plan' FROM target
			RETURNING id, project_id
		)
		INSERT INTO plan_versions (
			project_id, plan_id, catalog_revision_id, version, status, currency,
			base_amount_minor, billing_interval, tier_rank
		)
		SELECT plan.project_id, plan.id, target.revision_id, version.number, 'published',
			'USD', version.amount, 'month', version.rank
		FROM plan, target
		CROSS JOIN (VALUES (1, 1000, 10), (2, 1500, 20)) AS version(number, amount, rank)
	`;
	await sql`
		UPDATE plans SET active_version_id = version.id
		FROM plan_versions version
		WHERE plans.project_id = version.project_id AND plans.id = version.plan_id
			AND plans.key = 'migration-plan' AND version.version = 2
	`;
	await sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity,
			reset_interval, allocation_scope
		)
		SELECT version.project_id, version.id, feature.id, 'licensed_quantity', 1, NULL, 'license_pool'
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'licensed_seats'
		WHERE plan.key = 'migration-plan'
	`;
	await sql`
		INSERT INTO price_components (
			project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing,
			currency, unit_amount_minor, billing_units, billing_interval,
			minimum_quantity, maximum_quantity
		)
		SELECT version.project_id, version.id, NULL, 'base', 'base', 'in_advance',
			'USD', version.base_amount_minor, 1, 'month', 1, 1
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		WHERE plan.key = 'migration-plan'
		UNION ALL
		SELECT version.project_id, version.id, item.id, 'seats', 'licensed', 'in_advance',
			'USD', CASE version.version WHEN 1 THEN 100 ELSE 150 END, 1, 'month', 1, 100
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN plan_items item ON item.project_id = version.project_id AND item.plan_version_id = version.id
		WHERE plan.key = 'migration-plan'
	`;
	await sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id,
			external_price_id, billing_period, currency, price_amount
		)
		SELECT project.id, product.id, 'stripe', 'web',
			concat('prod_migrate_v', version.number, '_', component.kind),
			concat('price_migrate_v', version.number, '_', component.kind),
			'month', 'USD', component.amount
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = 'premium_monthly'
		CROSS JOIN (VALUES (1), (2)) AS version(number)
		CROSS JOIN (VALUES ('base', 1000), ('seats', 100)) AS component(kind, amount)
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
			AND store.external_price_id = concat('price_migrate_v', version.version, '_', price.key)
		WHERE plan.key = 'migration-plan'
	`;
	await sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT project.id, account.id
		FROM projects project
		CROSS JOIN (VALUES ('migration-stripe'), ('migration-apple')) AS account(id)
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, current_period_start, current_period_end, auto_renew,
			plan_version_id, catalog_revision_id
		)
		SELECT project.id, customer.id, product.id,
			CASE account.provider
				WHEN 'stripe' THEN stripe_store.id
				ELSE apple_store.id
			END,
			account.provider, account.channel, account.external_subscription_id,
			CASE account.provider
				WHEN 'stripe' THEN stripe_store.external_product_id
				ELSE apple_store.external_product_id
			END,
			CASE account.provider
				WHEN 'stripe' THEN stripe_store.external_price_id
				ELSE apple_store.external_price_id
			END,
			'active', now() - interval '1 day', now() - interval '1 day',
			now() + interval '29 days', true, version.id, version.catalog_revision_id
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = 'premium_monthly'
		JOIN plans plan ON plan.project_id = project.id AND plan.key = 'migration-plan'
		JOIN plan_versions version ON version.project_id = plan.project_id
			AND version.plan_id = plan.id AND version.version = 1
		JOIN store_products stripe_store ON stripe_store.project_id = project.id
			AND stripe_store.external_price_id = 'price_migrate_v1_base'
		JOIN store_products apple_store ON apple_store.project_id = project.id
			AND apple_store.provider = 'apple' AND apple_store.external_product_id = 'premium_monthly'
		CROSS JOIN (VALUES
			('stripe', 'web', 'sub_migrate_stripe', 'migration-stripe'),
			('apple', 'ios', 'sub_migrate_apple', 'migration-apple')
		) AS account(provider, channel, external_subscription_id, billing_account_id)
		JOIN customers customer ON customer.project_id = project.id
			AND customer.billing_account_id = account.billing_account_id
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO subscription_items (
			project_id, subscription_id, price_component_id, provider_subscription_item_id,
			quantity, unit_amount_minor, currency, starts_at
		)
		SELECT subscription.project_id, subscription.id, price.id,
			CASE price.component_kind WHEN 'base' THEN 'si_migrate_base' ELSE 'si_migrate_seats' END,
			CASE price.component_kind WHEN 'base' THEN 1 ELSE 7 END,
			price.unit_amount_minor, price.currency, now() - interval '1 day'
		FROM subscriptions subscription
		JOIN price_components price ON price.project_id = subscription.project_id
			AND price.plan_version_id = subscription.plan_version_id
		WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
	`;
}
