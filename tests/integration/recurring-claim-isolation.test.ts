import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { OperationTiming } from "../../src/providers/contract";
import {
	RecurringBillingWorker,
	type RecurringBillingWorkerAdapter,
} from "../../src/workers/recurring-billing";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	setSubscriptionChangeAttempts,
	setUsageInvoiceAdjustmentAttempts,
	setUsageInvoicePeriodAttempts,
} from "./helpers/job-time-travel";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { linkStripeCustomer, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";
import { seedSubscriptionChanges } from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const timing: OperationTiming = {
	payment: { kind: "uncertain" },
	entitlement: { kind: "awaiting_provider_event" },
};
let context: LocalPostgresContext;

/**
 * Each of these jobs is claimed and then cannot be built. While the claim built its jobs, one of
 * them rolled back the whole claim: no project made progress and the poison job never counted an
 * attempt, so it never reached its terminal state.
 */
localDescribe("Recurring billing claim isolation", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("invoices other periods while a period without a Stripe customer fails on its own", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedOverageSubscriber(context.sql, { account: "iso-apple", provider: "apple" });
		await seedOverageSubscriber(context.sql, { account: "iso-stripe", provider: "stripe" });
		await consumeOverage("iso-apple");
		await consumeOverage("iso-stripe");
		await closeUsageWindows(context.sql);
		const failures: string[] = [];

		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 2,
			usageInvoicesCreated: 1,
			usageAdjustmentsCreated: 0,
			failed: 1,
		});
		const poisoned = await periodId("iso-apple");
		expect(failures).toEqual([`Usage invoice period ${poisoned} cannot be invoiced`]);
		expect(await periodRows()).toEqual([
			{ account: "iso-apple", status: "pending", attempts: 1, last_error: null },
			{ account: "iso-stripe", status: "invoiced", attempts: 1, last_error: null },
		]);

		await setUsageInvoicePeriodAttempts(context.sql, poisoned, 7);
		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 0,
			usageInvoicesCreated: 0,
			failed: 1,
		});
		expect(await periodRows()).toEqual([
			{
				account: "iso-apple",
				status: "failed",
				attempts: 8,
				last_error: `Usage invoice period ${poisoned} cannot be invoiced`,
			},
			{ account: "iso-stripe", status: "invoiced", attempts: 1, last_error: null },
		]);
	});

	it("invoices other adjustments while a positive volume adjustment fails on its own", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedOverageSubscriber(context.sql, { account: "iso-flat", provider: "stripe" });
		await seedOverageSubscriber(context.sql, {
			account: "iso-volume",
			provider: "stripe",
			pricingModel: "volume",
		});
		const flatUsage = await consumeOverage("iso-flat");
		const volumeUsage = await consumeOverage("iso-volume");
		await closeUsageWindows(context.sql);
		const failures: string[] = [];
		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 2,
			usageInvoicesCreated: 2,
			failed: 0,
		});

		// The correction drops the volume usage into a dearer tier, which stores a positive delta.
		await correctOverage("iso-flat", flatUsage);
		await correctOverage("iso-volume", volumeUsage);
		expect(await adjustmentRows()).toEqual([
			{ account: "iso-flat", amount_minor: "-10", status: "pending", attempts: 0 },
			{ account: "iso-volume", amount_minor: "8", status: "pending", attempts: 0 },
		]);

		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 0,
			usageInvoicesCreated: 0,
			usageAdjustmentsCreated: 1,
			failed: 1,
		});
		const poisoned = await adjustmentId("iso-volume");
		expect(failures).toEqual([`Usage invoice adjustment ${poisoned} has an invalid amount`]);
		expect(await adjustmentRows()).toEqual([
			{ account: "iso-flat", amount_minor: "-10", status: "invoiced", attempts: 1 },
			{ account: "iso-volume", amount_minor: "8", status: "pending", attempts: 1 },
		]);

		await setUsageInvoiceAdjustmentAttempts(context.sql, poisoned, 7);
		expect(await runWorkerOnce(failures)).toMatchObject({ usageAdjustmentsCreated: 0, failed: 1 });
		expect(await adjustmentRows()).toEqual([
			{ account: "iso-flat", amount_minor: "-10", status: "invoiced", attempts: 1 },
			{ account: "iso-volume", amount_minor: "8", status: "failed", attempts: 8 },
		]);
	});

	it("applies other changes while a change without a matching binding fails on its own", async () => {
		const [poisonChangeId, healthyChangeId] = await seedSubscriptionChanges(context.sql, 2);
		if (poisonChangeId === undefined || healthyChangeId === undefined) {
			throw new Error("Expected two seeded subscription changes");
		}
		// The target plan publishes Stripe web prices only, so an iOS subscription has no binding.
		await context.sql`
			UPDATE subscriptions
			SET channel = 'ios'
			FROM subscription_changes changes
			WHERE changes.id = ${poisonChangeId}::uuid
				AND subscriptions.project_id = changes.project_id
				AND subscriptions.id = changes.subscription_id
		`;
		const failures: string[] = [];

		expect(await runWorkerOnce(failures)).toMatchObject({
			subscriptionChangesApplied: 1,
			failed: 1,
		});
		expect(failures).toEqual(["Target plan has no Stripe recurring prices"]);
		expect(await changeRow(poisonChangeId)).toEqual({
			status: "pending",
			attempts: 1,
			last_error: null,
		});
		expect(await changeRow(healthyChangeId)).toEqual({
			status: "applied",
			attempts: 1,
			last_error: null,
		});

		await setSubscriptionChangeAttempts(context.sql, poisonChangeId, 7);
		expect(await runWorkerOnce(failures)).toMatchObject({
			subscriptionChangesApplied: 0,
			failed: 1,
		});
		expect(await changeRow(poisonChangeId)).toEqual({
			status: "failed",
			attempts: 8,
			last_error: "Target plan has no Stripe recurring prices",
		});
		expect(await changeRow(healthyChangeId)).toEqual({
			status: "applied",
			attempts: 1,
			last_error: null,
		});
	});
});

/** The provider is out of scope here: every claimed job that loads must finalize. */
function committedAdapter(): RecurringBillingWorkerAdapter {
	return {
		changes: {
			async apply(operation) {
				return { outcome: "committed", providerRequestId: operation.changeId, timing };
			},
		},
		settlement: {
			async collectFinalizedCharge(job) {
				return { outcome: "committed", externalChargeId: `in_${job.jobId}`, timing };
			},
		},
	};
}

async function runWorkerOnce(failures: string[]) {
	failures.length = 0;
	const worker = new RecurringBillingWorker({
		projectContextResolver: context.projectContextResolver,
		workerId: "claim-isolation-worker",
		repository: context.repository,
		adapterForJob: committedAdapter,
		logger: {
			error(_message, error) {
				failures.push(error instanceof Error ? error.message : String(error));
			},
		},
	});
	return await worker.runOnce();
}

async function consumeOverage(billingAccountId: string) {
	const receipt = await context.repository.consumeUsage(project, {
		billingAccountId,
		featureKey: featureKey(billingAccountId),
		quantity: "135",
		idempotencyKey: `${billingAccountId}:usage`,
	});
	expect(receipt).toMatchObject({ allowed: true });
	return receipt;
}

async function correctOverage(
	billingAccountId: string,
	receipt: { usageEventId: string | null; recordedAt: string | null },
): Promise<void> {
	if (receipt.usageEventId === null || receipt.recordedAt === null) {
		throw new Error(`Expected an accepted usage event for ${billingAccountId}`);
	}
	await context.repository.correctUsage(project, {
		billingAccountId,
		originalUsageEventId: receipt.usageEventId,
		originalRecordedAt: new Date(receipt.recordedAt),
		quantity: "20",
		reason: "claim isolation correction",
		actor: "claim-isolation-test",
		idempotencyKey: `${billingAccountId}:correct`,
	});
}

async function periodRows() {
	return await context.sql<
		Array<{ account: string; status: string; attempts: number; last_error: string | null }>
	>`
		SELECT customer.billing_account_id AS account, period.status, period.attempts,
			period.last_error
		FROM usage_invoice_periods period
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE period.project_id = ${project.projectInstanceId}::uuid
		ORDER BY account
	`;
}

async function periodId(account: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		SELECT period.id::text AS id
		FROM usage_invoice_periods period
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE period.project_id = ${project.projectInstanceId}::uuid
			AND customer.billing_account_id = ${account}
	`;
	if (row === undefined) throw new Error(`No usage invoice period for ${account}`);
	return row.id;
}

async function adjustmentRows() {
	return await context.sql<
		Array<{ account: string; amount_minor: string; status: string; attempts: number }>
	>`
		SELECT customer.billing_account_id AS account, adjustment.amount_minor::text AS amount_minor,
			adjustment.status, adjustment.attempts
		FROM usage_invoice_adjustments adjustment
		JOIN usage_invoice_periods period
			ON period.project_id = adjustment.project_id AND period.id = adjustment.closed_period_id
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE adjustment.project_id = ${project.projectInstanceId}::uuid
		ORDER BY account
	`;
}

async function adjustmentId(account: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		SELECT adjustment.id::text AS id
		FROM usage_invoice_adjustments adjustment
		JOIN usage_invoice_periods period
			ON period.project_id = adjustment.project_id AND period.id = adjustment.closed_period_id
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE adjustment.project_id = ${project.projectInstanceId}::uuid
			AND customer.billing_account_id = ${account}
	`;
	if (row === undefined) throw new Error(`No usage invoice adjustment for ${account}`);
	return row.id;
}

async function changeRow(changeId: string) {
	const [row] = await context.sql<
		Array<{ status: string; attempts: number; last_error: string | null }>
	>`
		SELECT status, attempts, last_error
		FROM subscription_changes
		WHERE project_id = ${project.projectInstanceId}::uuid AND id = ${changeId}::uuid
	`;
	if (row === undefined) throw new Error(`No subscription change ${changeId}`);
	return row;
}

function featureKey(billingAccountId: string): string {
	return `calls_${billingAccountId.replace(/-/g, "_")}`;
}

/**
 * One metered-overage plan per subscriber: a meter limit of 25 with postpaid overage billed through
 * a Stripe web price. The Stripe customer is optional, so a period can be claimed and never built.
 */
async function seedOverageSubscriber(
	sql: SQL,
	options: {
		account: string;
		provider: "apple" | "stripe";
		pricingModel?: "flat" | "volume";
	},
): Promise<void> {
	const { account, provider } = options;
	const pricingModel = options.pricingModel ?? "flat";
	const key = account.replace(/-/g, "_");
	const feature = featureKey(account);
	const planKey = `plan_${key}`;
	const productKey = `product_${key}`;
	const channel = provider === "apple" ? "ios" : "web";
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, ${feature}, ${feature}, 'metered', 'consumable', 'call', 1
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
			JOIN features feature ON feature.project_id = version.project_id AND feature.key = ${feature}
			RETURNING id, project_id, plan_version_id
		)
		INSERT INTO price_components (
			project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing,
			currency, unit_amount_minor, billing_units, billing_interval, pricing_model
		)
		SELECT project_id, plan_version_id, id, 'overage', 'metered_overage', 'in_arrears',
			'USD', ${pricingModel === "flat" ? 5 : 0}, 10, 'month', ${pricingModel}
		FROM item
	`;
	await sql`
		UPDATE plans SET active_version_id = version.id
		FROM plan_versions version
		WHERE plans.project_id = version.project_id AND plans.id = version.plan_id
			AND plans.key = ${planKey} AND version.version = 1
	`;
	if (pricingModel === "volume") {
		await sql`
			INSERT INTO price_tiers (
				project_id, price_component_id, ordinal, up_to_quantity,
				unit_amount_minor, flat_amount_minor
			)
			SELECT price.project_id, price.id, tier.ordinal, tier.up_to, tier.unit_amount,
				tier.flat_amount
			FROM price_components price
			JOIN plan_versions version
				ON version.project_id = price.project_id AND version.id = price.plan_version_id
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			CROSS JOIN (
				VALUES (0, 100::numeric, 20, 0), (1, 500::numeric, 12, 40), (2, NULL::numeric, 8, 0)
			) AS tier(ordinal, up_to, unit_amount, flat_amount)
			WHERE plan.key = ${planKey} AND price.component_kind = 'metered_overage'
		`;
	}
	await sql`
		INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type, active)
		SELECT id, ${productKey}, ${productKey}, 0, ${productKey}, 'subscription', true
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id,
			external_price_id, billing_period, currency, price_amount, active
		)
		SELECT project.id, product.id, 'stripe', 'web', ${`prod_${key}`}, ${`price_${key}`},
			'month', 'USD', 0, true
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = ${productKey}
		WHERE project.key = 'voysee'
	`;
	if (provider === "apple") {
		await sql`
			INSERT INTO store_products (
				project_id, product_id, provider, channel, external_product_id,
				external_price_id, billing_period, currency, price_amount, active
			)
			SELECT project.id, product.id, 'apple', 'ios', ${`com.iso.${key}`}, NULL,
				'month', 'USD', 0, true
			FROM projects project
			JOIN products product ON product.project_id = project.id AND product.key = ${productKey}
			WHERE project.key = 'voysee'
		`;
	}
	await sql`
		INSERT INTO provider_price_bindings (
			project_id, price_component_id, store_product_id, provider, channel, status
		)
		SELECT price.project_id, price.id, store.id, 'stripe', 'web', 'published'
		FROM price_components price
		JOIN plan_versions version
			ON version.project_id = price.project_id AND version.id = price.plan_version_id
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN store_products store
			ON store.project_id = price.project_id AND store.external_price_id = ${`price_${key}`}
		WHERE plan.key = ${planKey}
	`;
	if (provider === "apple") {
		// No Stripe customer: the period materializes and is claimed, and only its load fails.
		await sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, ${account} FROM projects WHERE key = 'voysee'
			ON CONFLICT (project_id, billing_account_id) DO NOTHING
		`;
	} else {
		await linkStripeCustomer(sql, account, `cus_${key}`);
	}
	await sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id,
			status, starts_at, current_period_start, current_period_end, auto_renew,
			plan_version_id, catalog_revision_id
		)
		SELECT project.id, customer.id, product.id, store.id, ${provider}, ${channel},
			${`sub_${key}`}, store.external_product_id, store.external_price_id,
			'active', now() - interval '1 day', now() - interval '1 day',
			now() + interval '29 days', true, version.id, version.catalog_revision_id
		FROM projects project
		JOIN customers customer ON customer.project_id = project.id
			AND customer.billing_account_id = ${account}
		JOIN products product ON product.project_id = project.id AND product.key = ${productKey}
		JOIN store_products store ON store.project_id = product.project_id
			AND store.product_id = product.id AND store.provider = ${provider}
		JOIN plans plan ON plan.project_id = project.id AND plan.key = ${planKey}
		JOIN plan_versions version
			ON version.project_id = plan.project_id AND version.id = plan.active_version_id
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
