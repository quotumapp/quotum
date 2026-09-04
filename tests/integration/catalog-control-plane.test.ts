import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("catalog control plane", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("previews and atomically publishes the exact versioned catalog intent", async () => {
		const errors: unknown[] = [];
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			logger: recordingErrorLogger(errors),
		});
		const headers = operatorHeaders(authHeaders());
		const intent = catalogIntent(1, "0.005");
		const preview = await app.request("/v1/admin/catalog/preview", {
			method: "POST",
			headers,
			body: JSON.stringify({ expectedRevision: null, catalog: intent }),
		});

		expect(preview.status).toBe(200);
		const previewData = (await preview.json()).data;
		expect(previewData).toMatchObject({
			baseRevision: null,
			nextRevision: 1,
			impact: {
				featuresCreated: 2,
				plansCreated: 1,
				planVersionsCreated: 1,
				topupOptionsCreated: 1,
				providerBindingsValidated: 6,
			},
		});
		expect(previewData.intentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(previewData.previewToken).toMatch(/^[a-f0-9]{64}$/);

		const publishBody = {
			expectedRevision: null,
			previewToken: previewData.previewToken,
			catalog: intent,
		};
		const publish = await app.request("/v1/admin/catalog/publish", {
			method: "POST",
			headers,
			body: JSON.stringify(publishBody),
		});
		if (publish.status !== 200) throw errors[0] ?? new Error(await publish.clone().text());
		expect(publish.status).toBe(200);
		const published = (await publish.json()).data;
		expect(published).toMatchObject({
			revision: 1,
			intentHash: previewData.intentHash,
			duplicate: false,
		});

		const duplicate = await app.request("/v1/admin/catalog/publish", {
			method: "POST",
			headers,
			body: JSON.stringify(publishBody),
		});
		expect(duplicate.status).toBe(200);
		expect((await duplicate.json()).data).toMatchObject({
			revisionId: published.revisionId,
			revision: 1,
			duplicate: true,
		});

		const [state] = await context.sql<
			Array<{
				revision: number;
				plans: number;
				bindings: number;
				provider_operations: number;
				ready_provider_operations: number;
				audits: number;
			}>
		>`
			SELECT
				cr.revision,
				(SELECT count(*)::integer FROM plan_versions pv WHERE pv.project_id = p.id) AS plans,
				(SELECT count(*)::integer FROM provider_plan_bindings ppb WHERE ppb.project_id = p.id) AS bindings,
				(SELECT count(*)::integer FROM catalog_provider_operations operations
					WHERE operations.project_id = p.id) AS provider_operations,
				(SELECT count(*)::integer FROM catalog_provider_operations operations
					WHERE operations.project_id = p.id AND operations.status = 'ready') AS ready_provider_operations,
				(SELECT count(*)::integer FROM catalog_audit_log cal WHERE cal.project_id = p.id) AS audits
			FROM projects p
			JOIN catalog_revisions cr ON cr.id = p.published_catalog_revision_id
			WHERE p.key = 'voysee'
		`;
		expect(state).toEqual({
			revision: 1,
			plans: 1,
			bindings: 3,
			provider_operations: 6,
			ready_provider_operations: 6,
			audits: 1,
		});
	});

	it("rejects stale previews and intent changes without moving active pointers", async () => {
		const errors: unknown[] = [];
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			logger: recordingErrorLogger(errors),
		});
		const headers = operatorHeaders(authHeaders());
		const firstIntent = catalogIntent(1, "0.005");
		const firstPreview = await previewCatalog(app, headers, null, firstIntent);
		const stalePreview = await previewCatalog(app, headers, null, catalogIntent(2, "0.004"));
		await publishCatalog(app, headers, null, firstPreview.previewToken, firstIntent, errors);

		const stale = await app.request("/v1/admin/catalog/publish", {
			method: "POST",
			headers,
			body: JSON.stringify({
				expectedRevision: null,
				previewToken: stalePreview.previewToken,
				catalog: catalogIntent(2, "0.004"),
			}),
		});
		expect(stale.status).toBe(409);
		expect((await stale.json()).error.code).toBe("CATALOG_REVISION_CONFLICT");

		const secondPreview = await previewCatalog(app, headers, 1, catalogIntent(2, "0.004"));
		const mismatch = await app.request("/v1/admin/catalog/publish", {
			method: "POST",
			headers,
			body: JSON.stringify({
				expectedRevision: 1,
				previewToken: secondPreview.previewToken,
				catalog: catalogIntent(2, "0.006"),
			}),
		});
		expect(mismatch.status).toBe(409);
		expect((await mismatch.json()).error.code).toBe("CATALOG_PREVIEW_MISMATCH");
	});

	it("requires explicit retirement and keeps existing subscriptions pinned", async () => {
		const errors: unknown[] = [];
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			logger: recordingErrorLogger(errors),
		});
		const headers = operatorHeaders(authHeaders());
		const firstIntent = catalogIntent(1, "0.005");
		const firstPreview = await previewCatalog(app, headers, null, firstIntent);
		await publishCatalog(app, headers, null, firstPreview.previewToken, firstIntent, errors);
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, 'retirement-account' FROM projects WHERE key = 'voysee'
		`;
		await context.sql`
			INSERT INTO subscriptions (
				project_id, customer_id, product_id, store_product_id, provider, channel,
				external_subscription_id, external_product_id, external_price_id, status,
				starts_at, auto_renew, plan_version_id, catalog_revision_id
			)
			SELECT
				project.id, customer.id, product.id, store.id, 'stripe', 'web',
				'sub_retired_plan', store.external_product_id, store.external_price_id, 'active',
				now(), true, plan.active_version_id, version.catalog_revision_id
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
			JOIN products product
				ON product.project_id = project.id AND product.key = 'premium_monthly'
			JOIN store_products store
				ON store.project_id = product.project_id AND store.product_id = product.id
				AND store.provider = 'stripe'
			JOIN plans plan ON plan.project_id = project.id AND plan.key = 'premium'
			JOIN plan_versions version ON version.id = plan.active_version_id
			WHERE project.key = 'voysee' AND customer.billing_account_id = 'retirement-account'
		`;

		const omittedPlan = { ...firstIntent, plans: [] };
		const omission = await app.request("/v1/admin/catalog/preview", {
			method: "POST",
			headers,
			body: JSON.stringify({ expectedRevision: 1, catalog: omittedPlan }),
		});
		expect(omission.status).toBe(400);
		expect((await omission.json()).error.message).toContain("explicitly retired");

		const retirementIntent = {
			...omittedPlan,
			retiredPlanKeys: ["premium"],
		};
		const retirementPreview = await previewCatalog(app, headers, 1, retirementIntent);
		expect(retirementPreview.impact).toMatchObject({
			planVersionsCreated: 0,
			plansRetired: 1,
			existingSubscriptionsGrandfathered: 1,
		});
		await publishCatalog(app, headers, 1, retirementPreview.previewToken, retirementIntent, errors);

		const [state] = await context.sql<
			Array<{
				active: boolean;
				active_version_id: string;
				subscription_plan_version_id: string;
			}>
		>`
			SELECT
				plan.active,
				plan.active_version_id::text,
				subscription.plan_version_id::text AS subscription_plan_version_id
			FROM plans plan
			JOIN projects project ON project.id = plan.project_id
			JOIN subscriptions subscription
				ON subscription.project_id = plan.project_id
				AND subscription.external_subscription_id = 'sub_retired_plan'
			WHERE project.key = 'voysee' AND plan.key = 'premium'
		`;
		expect(state.active).toBe(false);
		expect(state.subscription_plan_version_id).toBe(state.active_version_id);

		const adminCatalog = await app.request("/v1/admin/catalog", { headers });
		expect(adminCatalog.status).toBe(200);
		expect((await adminCatalog.json()).data.catalog).toMatchObject({
			plans: [],
			retiredPlanKeys: ["premium"],
		});
		const publicCatalog = await app.request("/v1/catalog?provider=stripe&channel=web", {
			headers: authHeaders("voysee"),
		});
		expect(publicCatalog.status).toBe(200);
		expect((await publicCatalog.json()).data.plans).toEqual([]);
	});

	it("publishes fixed, licensed-seat, and metered-overage prices as immutable components", async () => {
		await seedPhaseTwoStripePrices();
		const { app, authHeaders, stripe } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = operatorHeaders(authHeaders());
		const catalog = phaseTwoCatalogIntent();
		const preview = await app.request("/v1/admin/catalog/preview", {
			method: "POST",
			headers,
			body: JSON.stringify({ expectedRevision: null, catalog }),
		});
		expect(preview.status).toBe(200);
		const previewData = (await preview.json()).data;
		expect(previewData.impact.providerBindingsValidated).toBe(4);
		const publish = await app.request("/v1/admin/catalog/publish", {
			method: "POST",
			headers,
			body: JSON.stringify({
				expectedRevision: null,
				previewToken: previewData.previewToken,
				catalog,
			}),
		});
		expect(publish.status).toBe(200);

		const components = await context.sql<
			Array<{
				key: string;
				component_kind: string;
				charge_timing: string;
				unit_amount_minor: number;
				billing_units: string;
			}>
		>`
			SELECT pc.key, pc.component_kind, pc.charge_timing,
				pc.unit_amount_minor::integer, pc.billing_units::text
			FROM price_components pc
			JOIN projects project ON project.id = pc.project_id
			WHERE project.key = 'voysee'
			ORDER BY pc.id
		`;
		expect(components).toEqual([
			{
				key: "base",
				component_kind: "base",
				charge_timing: "in_advance",
				unit_amount_minor: 999,
				billing_units: "1.000000000",
			},
			{
				key: "seat",
				component_kind: "licensed",
				charge_timing: "in_advance",
				unit_amount_minor: 200,
				billing_units: "1.000000000",
			},
			{
				key: "api-overage",
				component_kind: "metered_overage",
				charge_timing: "in_arrears",
				unit_amount_minor: 50,
				billing_units: "1000.000000000",
			},
			{
				key: "support-base",
				component_kind: "base",
				charge_timing: "in_advance",
				unit_amount_minor: 300,
				billing_units: "1.000000000",
			},
		]);
		const publicCatalog = await app.request("/v1/catalog?provider=stripe&channel=web", {
			headers: authHeaders("voysee"),
		});
		expect(publicCatalog.status).toBe(200);
		expect((await publicCatalog.json()).data).toMatchObject({
			schemaVersion: 1,
			plans: [
				{
					key: "pro",
					kind: "base",
					version: 1,
					trialDays: 14,
					trialRequiresPaymentMethod: false,
					trialEndBehavior: "pause",
					upgradeProrationBehavior: "always_invoice",
					components: [
						{ key: "base", kind: "base", unitAmountMinor: 999 },
						{
							key: "seat",
							kind: "licensed",
							featureKey: "seats",
							minimumQuantity: 1,
							maximumQuantity: 500,
						},
						{
							key: "api-overage",
							kind: "metered_overage",
							featureKey: "api_calls",
							includedQuantity: "10000.000000000",
							billingUnits: "1000.000000000",
							unitAmountMinor: 50,
						},
					],
				},
				{ key: "priority-support", kind: "addon" },
			],
			oneTimePurchases: [{ key: "echo_credits_10", kind: "topup" }],
		});
		const checkout = await app.request(
			"/v1/billing-accounts/phase2-account/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: { ...authHeaders("voysee"), "content-type": "application/json" },
				body: JSON.stringify({ planKey: "pro", quantities: { seats: 5 } }),
			},
		);
		expect(checkout.status).toBe(200);
		expect(stripe.checkoutSessionParams.at(-1)).toMatchObject({
			mode: "subscription",
			line_items: [
				{ price: "price_premium_monthly", quantity: 1 },
				{ price: "price_pro_seat", quantity: 5 },
			],
			payment_method_collection: "if_required",
			subscription_data: {
				trial_period_days: 14,
				trial_settings: { end_behavior: { missing_payment_method: "pause" } },
				metadata: { planKey: "pro" },
			},
		});

		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, 'phase2-metered-account' FROM projects WHERE key = 'voysee'
		`;
		await context.sql`
			INSERT INTO provider_customers (project_id, customer_id, provider, external_customer_id)
			SELECT project.id, customer.id, 'stripe', 'cus_phase2_metered'
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
			WHERE project.key = 'voysee' AND customer.billing_account_id = 'phase2-metered-account'
		`;
		await context.sql`
			INSERT INTO subscriptions (
				project_id, customer_id, product_id, store_product_id, provider, channel,
				external_subscription_id, external_product_id, external_price_id, status,
				starts_at, current_period_start, current_period_end, auto_renew,
				plan_version_id, catalog_revision_id
			)
			SELECT
				project.id, customer.id, product.id, store.id, 'stripe', 'web',
				'sub_phase2_metered', store.external_product_id, store.external_price_id, 'active',
				now() - interval '1 day', now() - interval '1 day', now() + interval '29 days', true,
				plan.active_version_id, version.catalog_revision_id
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
			JOIN products product ON product.project_id = project.id AND product.key = 'premium_monthly'
			JOIN store_products store
				ON store.project_id = product.project_id AND store.product_id = product.id
				AND store.provider = 'stripe'
			JOIN plans plan ON plan.project_id = project.id AND plan.key = 'pro'
			JOIN plan_versions version ON version.id = plan.active_version_id
			WHERE project.key = 'voysee' AND customer.billing_account_id = 'phase2-metered-account'
		`;
		const addonCheckout = await app.request(
			"/v1/billing-accounts/phase2-metered-account/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: { ...authHeaders("voysee"), "content-type": "application/json" },
				body: JSON.stringify({ planKey: "priority-support", quantities: {} }),
			},
		);
		expect(addonCheckout.status).toBe(200);
		expect(stripe.checkoutSessionParams.at(-1)).toMatchObject({
			mode: "subscription",
			line_items: [{ price: "price_priority_support", quantity: 1 }],
			metadata: { planKey: "priority-support" },
		});
		await context.sql`
			INSERT INTO subscription_items (
				project_id, subscription_id, price_component_id, provider_subscription_item_id,
				quantity, unit_amount_minor, currency, starts_at
			)
			SELECT
				project.id, subscription.id, price.id,
				CASE price.component_kind WHEN 'base' THEN 'si_base' ELSE 'si_seat' END,
				CASE price.component_kind WHEN 'base' THEN 1 ELSE 5 END,
				price.unit_amount_minor, price.currency, now() - interval '1 day'
			FROM projects project
			JOIN subscriptions subscription
				ON subscription.project_id = project.id AND subscription.external_subscription_id = 'sub_phase2_metered'
			JOIN price_components price
				ON price.project_id = subscription.project_id AND price.plan_version_id = subscription.plan_version_id
			WHERE project.key = 'voysee' AND price.component_kind IN ('base', 'licensed')
		`;
		const changeResponse = await app.request(
			"/v1/billing-accounts/phase2-metered-account/subscriptions/sub_phase2_metered/changes",
			{
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
					"idempotency-key": "phase2-seat-change",
				},
				body: JSON.stringify({
					targetPlanKey: "pro",
					quantities: { seats: 6 },
					effectiveMode: "immediate",
				}),
			},
		);
		expect(changeResponse.status).toBe(202);
		const quantityChange = (await changeResponse.json()).data;
		expect(quantityChange).toMatchObject({
			status: "pending",
			changeKind: "quantity",
			effectiveMode: "immediate",
			prorationBehavior: "always_invoice",
			externalSubscriptionId: "sub_phase2_metered",
			items: [
				{
					providerSubscriptionItemId: "si_base",
					externalPriceId: "price_premium_monthly",
					quantity: 1,
				},
				{
					providerSubscriptionItemId: "si_seat",
					externalPriceId: "price_pro_seat",
					quantity: 6,
				},
			],
		});
		const usage = await context.repository.consumeUsage(integrationProjectContext(), {
			billingAccountId: "phase2-metered-account",
			featureKey: "api_calls",
			quantity: "11000",
			idempotencyKey: "phase2-overage-consume",
		});
		expect(usage.allowed).toBe(true);
		expect(usage.balance.available).toBe("0");
		if (usage.usageEventId === null || usage.recordedAt === null) {
			throw new Error("Expected accepted overage usage event");
		}
		await context.sql`
			UPDATE usage_windows AS uw
			SET window_start_at = now() - interval '30 days', window_end_at = now() - interval '1 second'
			FROM customers customer, projects project
			WHERE uw.project_id = project.id AND uw.customer_id = customer.id
				AND customer.project_id = project.id AND project.key = 'voysee'
				AND customer.billing_account_id = 'phase2-metered-account'
		`;
		await context.sql`
			UPDATE usage_events event
			SET metadata = event.metadata || jsonb_build_object(
				'usageWindowStartAt', uw.window_start_at,
				'usageWindowEndAt', uw.window_end_at
			)
			FROM usage_windows uw
			WHERE event.project_id = uw.project_id
				AND event.metadata->>'usageWindowId' = uw.id::text
				AND event.id = ${usage.usageEventId}
		`;
		const invoiceClaim = await context.repository.materializeAndClaimUsageInvoicePeriods(
			"phase2-worker",
			10,
		);
		expect(invoiceClaim.materialized).toBe(1);
		expect(invoiceClaim.jobs).toHaveLength(1);
		expect(invoiceClaim.jobs[0]).toMatchObject({
			jobKind: "period",
			billingAccountId: "phase2-metered-account",
			externalCustomerId: "cus_phase2_metered",
			externalSubscriptionId: "sub_phase2_metered",
			featureKey: "api_calls",
			usageQuantity: "11000.000000000",
			includedQuantity: "10000.000000000",
			billableQuantity: "1000.000000000",
			amountMinor: 50,
			currency: "usd",
		});
		const periodJob = invoiceClaim.jobs[0];
		if (periodJob === undefined) throw new Error("Expected a usage invoice period job");
		await expect(
			context.repository.markUsageInvoiceSucceeded(
				integrationProjectContext("wiseley").projectInstanceId,
				periodJob.jobKind,
				periodJob.jobId,
				"in_wrong_project",
				"phase2-worker",
			),
		).rejects.toThrow("was not owned by worker");
		await expect(
			context.repository.markUsageInvoiceSucceeded(
				integrationProjectContext().projectInstanceId,
				periodJob.jobKind,
				periodJob.jobId,
				"in_stale_worker",
				"stale-worker",
			),
		).rejects.toThrow("was not owned by worker");
		await context.repository.markUsageInvoiceSucceeded(
			integrationProjectContext().projectInstanceId,
			periodJob.jobKind,
			periodJob.jobId,
			"in_phase2_usage",
			"phase2-worker",
		);
		await context.repository.correctUsage(integrationProjectContext(), {
			billingAccountId: "phase2-metered-account",
			originalUsageEventId: usage.usageEventId,
			originalRecordedAt: new Date(usage.recordedAt),
			quantity: "2000",
			reason: "late usage correction",
			actor: "phase2-test",
			idempotencyKey: "phase2-overage-correction",
		});
		const adjustmentClaim = await context.repository.materializeAndClaimUsageInvoicePeriods(
			"phase2-worker",
			10,
		);
		expect(adjustmentClaim.materialized).toBe(0);
		expect(adjustmentClaim.jobs).toHaveLength(1);
		expect(adjustmentClaim.jobs[0]).toMatchObject({
			jobKind: "adjustment",
			periodId: periodJob.periodId,
			adjustmentQuantity: "-2000.000000000",
			amountMinor: -50,
			currency: "usd",
		});
	});
});

async function seedPhaseTwoStripePrices() {
	for (const price of [
		{
			key: "pro_seat",
			externalProductId: "prod_pro_seat",
			externalPriceId: "price_pro_seat",
			amount: 200,
		},
		{
			key: "api_overage",
			externalProductId: "prod_api_overage",
			externalPriceId: "price_api_overage",
			amount: 50,
		},
		{
			key: "priority_support",
			externalProductId: "prod_priority_support",
			externalPriceId: "price_priority_support",
			amount: 300,
		},
	]) {
		await context.sql`
			INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type, active)
			SELECT id, ${price.key}, ${price.key}, 0, ${price.key}, 'subscription', true
			FROM projects WHERE key = 'voysee'
		`;
		await context.sql`
			INSERT INTO store_products (
				project_id, product_id, provider, channel, external_product_id,
				external_price_id, billing_period, currency, price_amount, active
			)
			SELECT project.id, product.id, 'stripe', 'web', ${price.externalProductId},
				${price.externalPriceId}, 'month', 'usd', ${price.amount}, true
			FROM projects project
			JOIN products product ON product.project_id = project.id AND product.key = ${price.key}
			WHERE project.key = 'voysee'
		`;
	}
}

function phaseTwoCatalogIntent() {
	const stripePrice = (
		key: string,
		productKey: string,
		unitAmountMinor: number,
		billingUnits: string,
	) => ({
		key,
		currency: "USD",
		unitAmountMinor,
		billingUnits,
		billingInterval: "month",
		minimumQuantity: 1,
		maximumQuantity: key === "seat" ? 500 : null,
		taxBehavior: "exclusive",
		providerBindings: [{ productKey, provider: "stripe", channel: "web" }],
	});
	return {
		features: [
			{
				key: "seats",
				name: "Seats",
				kind: "metered",
				meterKind: "non_consumable",
				unit: "seat",
				creditScale: 0,
				filterDimensions: [],
			},
			{
				key: "api_calls",
				name: "API calls",
				kind: "metered",
				meterKind: "consumable",
				unit: "call",
				creditScale: 0,
				filterDimensions: [],
			},
			{
				key: "priority_support_access",
				name: "Priority support",
				kind: "boolean",
				meterKind: null,
				unit: "access",
				creditScale: 0,
				filterDimensions: [],
			},
		],
		plans: [
			{
				key: "pro",
				name: "Pro",
				version: 1,
				currency: "USD",
				baseAmountMinor: 999,
				billingInterval: "month",
				trialDays: 14,
				kind: "base",
				tierRank: 20,
				trialRequiresPaymentMethod: false,
				trialEndBehavior: "pause",
				upgradeProrationBehavior: "always_invoice",
				downgradeProrationBehavior: "none",
				basePrice: stripePrice("base", "premium_monthly", 999, "1"),
				items: [
					{
						featureKey: "seats",
						itemKind: "licensed_quantity",
						quantity: "1",
						resetInterval: null,
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
						price: stripePrice("seat", "pro_seat", 200, "1"),
					},
					{
						featureKey: "api_calls",
						itemKind: "meter_limit",
						quantity: "10000",
						resetInterval: "month",
						expiresAfterSeconds: null,
						overagePolicy: "allowed",
						price: stripePrice("api-overage", "api_overage", 50, "1000"),
					},
				],
				providerBindings: [],
			},
			{
				key: "priority-support",
				name: "Priority support",
				version: 1,
				currency: "USD",
				baseAmountMinor: 300,
				billingInterval: "month",
				trialDays: null,
				kind: "addon",
				tierRank: 0,
				basePrice: stripePrice("support-base", "priority_support", 300, "1"),
				items: [
					{
						featureKey: "priority_support_access",
						itemKind: "access",
						quantity: null,
						resetInterval: null,
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
					},
				],
				providerBindings: [],
			},
		],
		topups: [],
		rateCards: [],
	};
}

function catalogIntent(version: number, ratePerUnit: string) {
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
				filterDimensions: ["model"],
			},
		],
		plans: [
			{
				key: "premium",
				name: "Premium",
				version,
				currency: "USD",
				baseAmountMinor: 999,
				billingInterval: "month",
				trialDays: null,
				items: [
					{
						featureKey: "ai_credits",
						itemKind: "allocation",
						quantity: "1000",
						resetInterval: "month",
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
					},
				],
				providerBindings: [
					{ productKey: "premium_monthly", provider: "apple", channel: "ios" },
					{ productKey: "premium_monthly", provider: "google", channel: "android" },
					{ productKey: "premium_monthly", provider: "stripe", channel: "web" },
				],
			},
		],
		topups: [
			{
				key: "ai_credits_10",
				featureKey: "ai_credits",
				quantity: "10",
				expiresAfterSeconds: 315_360_000,
				providerBindings: [
					{ productKey: "echo_credits_10", provider: "apple", channel: "ios" },
					{ productKey: "echo_credits_10", provider: "google", channel: "android" },
					{ productKey: "echo_credits_10", provider: "stripe", channel: "web" },
				],
			},
		],
		rateCards: [
			{
				meterFeatureKey: "model_tokens",
				walletFeatureKey: "ai_credits",
				ratePerUnit,
			},
		],
	};
}

async function previewCatalog(
	app: ReturnType<typeof createIntegrationApp>["app"],
	headers: HeadersInit,
	expectedRevision: number | null,
	catalog: ReturnType<typeof catalogIntent>,
) {
	const response = await app.request("/v1/admin/catalog/preview", {
		method: "POST",
		headers,
		body: JSON.stringify({ expectedRevision, catalog }),
	});
	expect(response.status).toBe(200);
	return (await response.json()).data;
}

async function publishCatalog(
	app: ReturnType<typeof createIntegrationApp>["app"],
	headers: HeadersInit,
	expectedRevision: number | null,
	previewToken: string,
	catalog: ReturnType<typeof catalogIntent>,
	errors: unknown[] = [],
) {
	const response = await app.request("/v1/admin/catalog/publish", {
		method: "POST",
		headers,
		body: JSON.stringify({ expectedRevision, previewToken, catalog }),
	});
	if (response.status !== 200) throw errors[0] ?? new Error(await response.clone().text());
	expect(response.status).toBe(200);
	return (await response.json()).data;
}

function recordingErrorLogger(errors: unknown[]) {
	return {
		info() {},
		warn() {},
		error(_message: string, error: unknown) {
			errors.push(error);
		},
	};
}

function operatorHeaders(authHeaders: HeadersInit): HeadersInit {
	return {
		...authHeaders,
		"content-type": "application/json",
		"x-billing-actor": "catalog-integration-test",
		"x-billing-operator-key": context.env.operatorApiKey ?? "",
	};
}
