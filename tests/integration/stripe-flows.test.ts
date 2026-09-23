import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type {
	EntitlementSnapshot,
	ProjectionPayload,
	ProjectionSyncReason,
	ProjectionSyncStatus,
} from "../../src/billing/types";
import type { RecordStripeCreditReversalProjectionInput } from "../../src/db/repository";
import { wrapStripeService } from "../../src/providers/stripe/adapter";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { RecurringBillingWorker } from "../../src/workers/recurring-billing";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	expectCustomer,
	expectProjectionJob,
	expectStoreEvent,
	expectTableCounts,
} from "./helpers/db-assertions";
import {
	createFakeStripeBillingClient,
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeRefundedChargeObject,
	stripeRefundObject,
	stripeSubscriptionObject,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";
import { integrationProjectReadOnlyCredential } from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Stripe route flows integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	// capability: catalog.product.subscription
	// capability: checkout.hosted
	it("creates Stripe Checkout sessions from seeded catalog rows", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const consumable = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					productKey: "echo_credits_10",
					email: "user@example.com",
				}),
			},
		);
		const subscription = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ productKey: "premium_monthly" }),
			},
		);

		expect(consumable.status).toBe(200);
		expect(subscription.status).toBe(200);
		expect(await consumable.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_integration",
				url: "https://checkout.stripe.test/session/cs_test_integration",
				duplicate: false,
			},
		});
		expect(await subscription.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_integration",
				url: "https://checkout.stripe.test/session/cs_test_integration",
				duplicate: false,
			},
		});
		expect(stripe.checkoutSessionParams).toHaveLength(2);
		expect(stripe.checkoutSessionParams[0]).toMatchObject({
			customer: "cus_integration",
			mode: "payment",
			client_reference_id: "integration_user",
			line_items: [{ price: "price_credits_10", quantity: 1 }],
			metadata: {
				billingAccountId: "integration_user",
				productKey: "echo_credits_10",
				purchaseKind: "consumable",
				billingEnvironment: "web",
				externalProductId: "prod_stripe_credits_10",
				externalPriceId: "price_credits_10",
			},
			payment_intent_data: {
				metadata: {
					billingAccountId: "integration_user",
					productKey: "echo_credits_10",
					purchaseKind: "consumable",
					externalProductId: "prod_stripe_credits_10",
					externalPriceId: "price_credits_10",
				},
			},
		});
		expect(stripe.checkoutSessionParams[1]).toMatchObject({
			customer: "cus_integration",
			mode: "subscription",
			client_reference_id: "integration_user",
			line_items: [{ price: "price_premium_monthly", quantity: 1 }],
			metadata: {
				billingAccountId: "integration_user",
				productKey: "premium_monthly",
				purchaseKind: "subscription",
				billingEnvironment: "web",
				externalProductId: "prod_stripe_premium",
				externalPriceId: "price_premium_monthly",
			},
			subscription_data: {
				metadata: {
					billingAccountId: "integration_user",
					productKey: "premium_monthly",
					purchaseKind: "subscription",
					externalProductId: "prod_stripe_premium",
					externalPriceId: "price_premium_monthly",
				},
			},
		});
		expect(stripe.checkoutSessionParams[1].payment_intent_data).toBeUndefined();
		expect(stripe.calls).toEqual([
			"createCustomer:integration_user",
			"createCheckoutSession",
			"createCheckoutSession",
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			store_events: 0,
			projection_sync_jobs: 0,
		});
		await expectProviderCustomerRow(context.sql, {
			billingAccountId: "integration_user",
			provider: "stripe",
			externalCustomerId: "cus_integration",
		});
	});

	it("persists exact commercial previews and binds execution to one idempotency key", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = {
			...authHeaders("voysee"),
			"content-type": "application/json",
		};
		const previewResponse = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: { kind: "checkout_product", productKey: "echo_credits_10" },
				}),
			},
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).data;
		expect(preview).toMatchObject({
			action: "checkout_product",
			billingAccountId: "integration_user",
			estimatedTotalMinor: 499,
			currency: "usd",
			amountStatus: "exact",
			lineItems: [
				expect.objectContaining({ key: "echo_credits_10", quantity: 1, unitAmountMinor: 499 }),
			],
		});
		expect(preview.previewToken).toMatch(/^[0-9a-f-]{36}$/);

		const execute = (idempotencyKey: string) =>
			testRequest(app, "/v1/billing-accounts/integration_user/commercial-actions", {
				method: "POST",
				headers: { ...headers, "idempotency-key": idempotencyKey },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			});
		const first = await execute("commercial:checkout:1");
		const replay = await execute("commercial:checkout:1");
		const conflictingReplay = await execute("commercial:checkout:2");

		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			success: true,
			data: { kind: "checkout", sessionId: "cs_test_integration" },
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			success: true,
			data: { kind: "checkout", sessionId: "cs_test_integration" },
		});
		expect(conflictingReplay.status).toBe(409);
		expect((await conflictingReplay.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
		expect(stripe.checkoutSessionParams).toHaveLength(1);

		const [stored] = await context.sql<
			Array<{
				status: string;
				execution_idempotency_key: string;
				has_result: boolean;
			}>
		>`
			SELECT status, execution_idempotency_key, execution_result IS NOT NULL AS has_result
			FROM commercial_action_previews
			WHERE preview_token = ${preview.previewToken}::uuid
		`;
		expect(stored).toEqual({
			status: "executed",
			execution_idempotency_key: "commercial:checkout:1",
			has_result: true,
		});
	});

	it("carries the Checkout expiration from a commercial intent into the Checkout Session", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = {
			...authHeaders("voysee"),
			"content-type": "application/json",
		};
		const expiresAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
		const previewResponse = await testRequest(
			app,
			"/v1/billing-accounts/expiring_checkout_user/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: { kind: "checkout_product", productKey: "echo_credits_10", expiresAt },
				}),
			},
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).data;

		const executed = await testRequest(
			app,
			"/v1/billing-accounts/expiring_checkout_user/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "commercial:checkout:expiring" },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			},
		);

		expect(executed.status).toBe(200);
		expect(stripe.checkoutSessionParams).toHaveLength(1);
		expect(stripe.checkoutSessionParams[0]?.expires_at).toBe(expiresAt);
		const [stored] = await context.sql<Array<{ intent: { expiresAt?: number } }>>`
			SELECT intent
			FROM commercial_action_previews
			WHERE preview_token = ${preview.previewToken}::uuid
		`;
		expect(stored?.intent.expiresAt).toBe(expiresAt);
	});

	// capability: subscription.change.preview
	it("previews subscription changes through the project-scoped repository", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const response = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					intent: {
						kind: "subscription_change",
						externalSubscriptionId: "sub_migrate_stripe",
						targetPlanKey: "migration-plan",
						quantities: { licensed_seats: 8 },
						effectiveMode: "immediate",
					},
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			data: {
				action: "subscription_change",
				billingAccountId: "migration-stripe",
				effectiveMode: "immediate",
			},
		});
	});

	// capability: subscription.change.period_end
	it("keeps a Stripe downgrade pending until period end, then the worker applies it", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		// Rank the published target version below the subscribed one, so the change is a downgrade.
		await context.sql`
			UPDATE plan_versions version
			SET tier_rank = 5
			FROM plans plan, projects project
			WHERE version.project_id = plan.project_id AND version.plan_id = plan.id
				AND plan.project_id = project.id AND project.key = 'voysee'
				AND plan.key = 'migration-plan' AND version.version = 2
		`;
		const project = integrationProjectContext();
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const requestDowngrade = (idempotencyKey: string) =>
			testRequest(
				app,
				"/v1/billing-accounts/migration-stripe/subscriptions/sub_migrate_stripe/changes",
				{
					method: "POST",
					headers: {
						...authHeaders("voysee"),
						"content-type": "application/json",
						"idempotency-key": idempotencyKey,
					},
					body: JSON.stringify({
						targetPlanKey: "migration-plan",
						quantities: { licensed_seats: 7 },
					}),
				},
			);
		const setPeriodEnd = (periodEnd: string | null) => context.sql`
			UPDATE subscriptions SET current_period_end = ${periodEnd}::timestamptz
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;

		await setPeriodEnd(null);
		const withoutPeriod = await requestDowngrade("period-end-downgrade:no-period");
		expect(withoutPeriod.status).toBe(409);
		expect((await withoutPeriod.json()).error.code).toBe("SUBSCRIPTION_PERIOD_MISSING");

		const periodEnd = new Date(Math.floor(Date.now() / 1000) * 1000 + 29 * 24 * 60 * 60 * 1000);
		await setPeriodEnd(periodEnd.toISOString());
		const requested = await requestDowngrade("period-end-downgrade");
		expect(requested.status).toBe(202);
		const change = (await requested.json()).data;
		expect(change).toMatchObject({
			status: "pending",
			changeKind: "downgrade",
			effectiveMode: "period_end",
			prorationBehavior: "none",
			externalSubscriptionId: "sub_migrate_stripe",
		});
		expect(new Date(change.effectiveAt).toISOString()).toBe(periodEnd.toISOString());
		expect(change).not.toHaveProperty("provider");
		expect(change).not.toHaveProperty("providerAccountId");

		const worker = new RecurringBillingWorker({
			projectContextResolver: context.projectContextResolver,
			workerId: "period-end-worker",
			repository: context.repository,
			adapterForJob: () =>
				wrapStripeService(
					new StripeBillingService({
						config: {
							projectKey: "voysee",
							checkoutSuccessUrl:
								"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
							checkoutCancelUrl: "https://app.integration.test/billing",
							portalReturnUrl: "https://app.integration.test/account/billing",
						},
						client: stripe.client,
						repository: context.repository.forProject(project),
					}),
				),
			logger: {
				error(_message, error) {
					throw error;
				},
			},
		});
		const changeStatus = async () => {
			const [row] = await context.sql<Array<{ status: string }>>`
				SELECT status FROM subscription_changes WHERE id = ${change.changeId}::uuid
			`;
			return row?.status;
		};

		expect(await worker.runOnce()).toMatchObject({ subscriptionChangesApplied: 0, failed: 0 });
		expect(await changeStatus()).toBe("pending");
		expect(stripe.subscriptionUpdates).toEqual([]);

		// Move the stored change's period end into the past, as if the period had ended.
		await context.sql`
			UPDATE subscription_changes SET effective_at = now() - interval '1 second'
			WHERE id = ${change.changeId}::uuid
		`;
		expect(await worker.runOnce()).toMatchObject({ subscriptionChangesApplied: 1, failed: 0 });
		expect(await changeStatus()).toBe("applied");
		expect(stripe.subscriptionUpdates).toHaveLength(1);
		expect(stripe.subscriptionUpdates[0]).toMatchObject({
			subscriptionId: "sub_migrate_stripe",
			params: {
				proration_behavior: "none",
				metadata: { billingChangeId: change.changeId },
			},
			idempotencyKey: `billing:subscription-change:${change.changeId}`,
		});
	});

	// capability: subscription.change.period_end
	it("cancels a due change whose subscription ended before the worker reached it", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		// Rank the published target version below the subscribed one, so the change is a downgrade.
		await context.sql`
			UPDATE plan_versions version
			SET tier_rank = 5
			FROM plans plan, projects project
			WHERE version.project_id = plan.project_id AND version.plan_id = plan.id
				AND plan.project_id = project.id AND project.key = 'voysee'
				AND plan.key = 'migration-plan' AND version.version = 2
		`;
		const project = integrationProjectContext();
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const periodEnd = new Date(Math.floor(Date.now() / 1000) * 1000 + 29 * 24 * 60 * 60 * 1000);
		await context.sql`
			UPDATE subscriptions SET current_period_end = ${periodEnd.toISOString()}::timestamptz
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;
		const requested = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/subscriptions/sub_migrate_stripe/changes",
			{
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
					"idempotency-key": "period-end-downgrade:ended",
				},
				body: JSON.stringify({
					targetPlanKey: "migration-plan",
					quantities: { licensed_seats: 7 },
				}),
			},
		);
		expect(requested.status).toBe(202);
		const change = (await requested.json()).data;
		expect(change).toMatchObject({ status: "pending", effectiveMode: "period_end" });

		// The period ends, and the subscription ends with it: an immediate cancellation here or in
		// the Stripe portal leaves the queued change with nothing left to apply.
		await context.sql`
			UPDATE subscription_changes SET effective_at = now() - interval '1 second'
			WHERE id = ${change.changeId}::uuid
		`;
		await context.sql`
			UPDATE subscriptions SET status = 'expired'
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;

		const worker = new RecurringBillingWorker({
			projectContextResolver: context.projectContextResolver,
			workerId: "ended-subscription-worker",
			repository: context.repository,
			adapterForJob: () =>
				wrapStripeService(
					new StripeBillingService({
						config: {
							projectKey: "voysee",
							checkoutSuccessUrl:
								"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
							checkoutCancelUrl: "https://app.integration.test/billing",
							portalReturnUrl: "https://app.integration.test/account/billing",
						},
						client: stripe.client,
						repository: context.repository.forProject(project),
					}),
				),
			logger: {
				error(_message, error) {
					throw error;
				},
			},
		});

		expect(await worker.runOnce()).toMatchObject({
			subscriptionChangesApplied: 0,
			subscriptionChangesCancelled: 1,
			failed: 0,
		});
		expect(stripe.subscriptionUpdates).toEqual([]);
		const [row] = await context.sql<
			Array<{
				status: string;
				attempts: number;
				last_error: string | null;
				locked_by: string | null;
			}>
		>`
			SELECT status, attempts, last_error, locked_by
			FROM subscription_changes WHERE id = ${change.changeId}::uuid
		`;
		expect(row).toEqual({
			status: "cancelled",
			attempts: 1,
			last_error: "The subscription is expired and can no longer be changed",
			locked_by: null,
		});

		// A cancelled change is terminal: the next poll leaves it alone.
		expect(await worker.runOnce()).toMatchObject({ subscriptionChangesCancelled: 0, failed: 0 });
	});

	// capability: subscription.cancel
	// capability: subscription.uncancel
	it("cancels a Stripe subscription at period end, uncancels it, then ends it immediately", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		const project = integrationProjectContext();
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = { ...authHeaders("voysee"), "content-type": "application/json" };
		const periodEnd = new Date(Math.floor(Date.now() / 1000) * 1000 + 29 * 24 * 60 * 60 * 1000);
		await context.sql`
			UPDATE subscriptions SET current_period_end = ${periodEnd.toISOString()}::timestamptz
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;
		const preview = async (intent: Record<string, unknown>) => {
			const response = await testRequest(
				app,
				"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
				{ method: "POST", headers, body: JSON.stringify({ intent }) },
			);
			return { status: response.status, body: await response.json() };
		};
		const execute = (previewToken: string, idempotencyKey: string) =>
			testRequest(app, "/v1/billing-accounts/migration-stripe/commercial-actions", {
				method: "POST",
				headers: { ...headers, "idempotency-key": idempotencyKey },
				body: JSON.stringify({ previewToken }),
			});

		const periodEndCancel = await preview({
			kind: "cancel",
			externalSubscriptionId: "sub_migrate_stripe",
			effectiveMode: "period_end",
		});
		expect(periodEndCancel.status).toBe(200);
		expect(periodEndCancel.body.data).toMatchObject({
			action: "cancel",
			effectiveMode: "period_end",
			effectiveAt: periodEnd.toISOString(),
			lineItems: [],
			estimatedTotalMinor: 0,
			targetId: "sub_migrate_stripe",
			cancellation: {
				action: "cancel",
				accessEndsAt: periodEnd.toISOString(),
				cancelAtPeriodEnd: true,
				keepsGrantedAllocations: true,
				supersedesChangeId: null,
				activeAddOnSubscriptionIds: [],
			},
		});

		const executed = await execute(periodEndCancel.body.data.previewToken, "cancel:period-end");
		expect(executed.status).toBe(200);
		expect((await executed.json()).data).toMatchObject({
			kind: "subscription_cancellation",
			action: "cancel",
			externalSubscriptionId: "sub_migrate_stripe",
			effectiveMode: "period_end",
			cancelAtPeriodEnd: true,
			supersededChangeId: null,
		});
		expect(stripe.subscriptionUpdates).toHaveLength(1);
		expect(stripe.subscriptionUpdates[0]).toMatchObject({
			subscriptionId: "sub_migrate_stripe",
			params: { cancel_at_period_end: true },
		});
		expect(stripe.subscriptionUpdates[0]?.idempotencyKey).toStartWith(
			"billing:subscription-cancel:commercial:",
		);

		// Replaying the same key returns the stored result; another key is a conflict.
		const replay = await execute(periodEndCancel.body.data.previewToken, "cancel:period-end");
		expect(replay.status).toBe(200);
		expect((await replay.json()).data).toMatchObject({ action: "cancel" });
		const conflicting = await execute(periodEndCancel.body.data.previewToken, "cancel:other-key");
		expect(conflicting.status).toBe(409);
		expect((await conflicting.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
		expect(stripe.subscriptionUpdates).toHaveLength(1);

		// Local state only moves through the webhook, so the cancellation is mirrored here.
		await context.sql`
			UPDATE subscriptions SET cancel_at_period_end = true
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;
		const uncancel = await preview({
			kind: "uncancel",
			externalSubscriptionId: "sub_migrate_stripe",
		});
		expect(uncancel.body.data).toMatchObject({
			action: "uncancel",
			effectiveMode: null,
			effectiveAt: null,
			cancellation: { action: "uncancel", cancelAtPeriodEnd: false },
		});
		const uncancelled = await execute(uncancel.body.data.previewToken, "uncancel:1");
		expect(uncancelled.status).toBe(200);
		expect((await uncancelled.json()).data).toMatchObject({
			kind: "subscription_cancellation",
			action: "uncancel",
			cancelAtPeriodEnd: false,
		});
		expect(stripe.subscriptionUpdates.at(-1)?.params).toEqual({ cancel_at_period_end: false });
		await context.sql`
			UPDATE subscriptions SET cancel_at_period_end = false
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;

		const immediate = await preview({
			kind: "cancel",
			externalSubscriptionId: "sub_migrate_stripe",
			effectiveMode: "immediate",
		});
		expect(immediate.body.data).toMatchObject({
			action: "cancel",
			effectiveMode: "immediate",
			cancellation: { action: "cancel", cancelAtPeriodEnd: false },
		});
		const ended = await execute(immediate.body.data.previewToken, "cancel:immediate");
		expect(ended.status).toBe(200);
		expect((await ended.json()).data).toMatchObject({
			kind: "subscription_cancellation",
			action: "cancel",
			effectiveMode: "immediate",
			cancelAtPeriodEnd: false,
		});
		expect(stripe.subscriptionCancellations).toHaveLength(1);
		expect(stripe.subscriptionCancellations[0]?.subscriptionId).toBe("sub_migrate_stripe");
		expect(stripe.subscriptionCancellations[0]?.idempotencyKey).toStartWith(
			"billing:subscription-cancel:commercial:",
		);
		const [stored] = await context.sql<Array<{ intent_kind: string; status: string }>>`
			SELECT intent_kind, status FROM commercial_action_previews
			WHERE preview_token = ${immediate.body.data.previewToken}::uuid
		`;
		expect(stored).toEqual({ intent_kind: "cancel", status: "executed" });
	});

	// capability: subscription.cancel
	it("supersedes a queued change, refuses an ended subscription and a stale cancellation preview", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		await context.sql`
			UPDATE plan_versions version
			SET tier_rank = 5
			FROM plans plan, projects project
			WHERE version.project_id = plan.project_id AND version.plan_id = plan.id
				AND plan.project_id = project.id AND project.key = 'voysee'
				AND plan.key = 'migration-plan' AND version.version = 2
		`;
		const project = integrationProjectContext();
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = { ...authHeaders("voysee"), "content-type": "application/json" };
		const periodEnd = new Date(Math.floor(Date.now() / 1000) * 1000 + 29 * 24 * 60 * 60 * 1000);
		await context.sql`
			UPDATE subscriptions SET current_period_end = ${periodEnd.toISOString()}::timestamptz
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;
		const queued = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/subscriptions/sub_migrate_stripe/changes",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "downgrade-before-cancel" },
				body: JSON.stringify({
					targetPlanKey: "migration-plan",
					quantities: { licensed_seats: 7 },
				}),
			},
		);
		expect(queued.status).toBe(202);
		const changeId = (await queued.json()).data.changeId as string;

		const previewResponse = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: {
						kind: "cancel",
						externalSubscriptionId: "sub_migrate_stripe",
						effectiveMode: "immediate",
					},
				}),
			},
		);
		const preview = (await previewResponse.json()).data;
		expect(preview.cancellation.supersedesChangeId).toBe(changeId);
		expect(preview.warnings).toContain(`Subscription change ${changeId} will be cancelled.`);

		const executed = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "cancel-supersedes" },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			},
		);
		expect(executed.status).toBe(200);
		expect((await executed.json()).data).toMatchObject({
			kind: "subscription_cancellation",
			action: "cancel",
			supersededChangeId: changeId,
		});
		expect(stripe.subscriptionCancellations).toHaveLength(1);
		const [change] = await context.sql<Array<{ status: string; last_error: string | null }>>`
			SELECT status, last_error FROM subscription_changes WHERE id = ${changeId}::uuid
		`;
		expect(change).toEqual({
			status: "cancelled",
			last_error: "Superseded by the cancellation of subscription sub_migrate_stripe",
		});

		// A preview taken before the state moved cannot be executed afterwards.
		const stale = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: {
						kind: "cancel",
						externalSubscriptionId: "sub_migrate_stripe",
						effectiveMode: "period_end",
					},
				}),
			},
		);
		const staleToken = (await stale.json()).data.previewToken as string;
		await context.sql`
			UPDATE subscriptions SET cancel_at_period_end = true
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;
		const staleExecute = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "cancel-stale" },
				body: JSON.stringify({ previewToken: staleToken }),
			},
		);
		expect(staleExecute.status).toBe(409);
		expect((await staleExecute.json()).error.code).toBe("COMMERCIAL_PREVIEW_STALE");

		// Once Stripe has ended the subscription there is nothing left to cancel.
		await context.sql`
			UPDATE subscriptions SET status = 'expired'
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;
		const ended = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: {
						kind: "cancel",
						externalSubscriptionId: "sub_migrate_stripe",
						effectiveMode: "immediate",
					},
				}),
			},
		);
		expect(ended.status).toBe(409);
		expect(await ended.json()).toMatchObject({
			error: {
				code: "SUBSCRIPTION_NOT_CANCELLABLE",
				details: { subscriptionStatus: "expired" },
			},
		});
	});

	// capability: subscription.cancel
	it("refuses to cancel a base plan while add-on subscriptions are active", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		await seedActiveAddOnSubscription(context.sql, "sub_migrate_stripe", "sub_addon_stripe");
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = { ...authHeaders("voysee"), "content-type": "application/json" };
		const cancelIntent = (externalSubscriptionId: string) =>
			testRequest(app, "/v1/billing-accounts/migration-stripe/commercial-actions/preview", {
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: { kind: "cancel", externalSubscriptionId, effectiveMode: "immediate" },
				}),
			});

		const base = await cancelIntent("sub_migrate_stripe");
		expect(base.status).toBe(409);
		expect(await base.json()).toMatchObject({
			error: {
				code: "ADDON_SUBSCRIPTIONS_ACTIVE",
				details: { addOnSubscriptionIds: ["sub_addon_stripe"] },
			},
		});

		// The add-on itself is cancellable; only the base plan under it is held back.
		const addOn = await cancelIntent("sub_addon_stripe");
		expect(addOn.status).toBe(200);
		expect((await addOn.json()).data).toMatchObject({ action: "cancel" });
	});

	// capability: subscription.cancel
	it("cancels a subscription that is still in its trial", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		const project = integrationProjectContext();
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = { ...authHeaders("voysee"), "content-type": "application/json" };
		// Stripe reports a trialing subscription as active, so only its trial window marks it here.
		await context.sql`
			UPDATE subscriptions
			SET status = 'active', trial_start_at = now() - interval '1 day',
				trial_end_at = now() + interval '13 days'
			WHERE project_id = ${project.projectInstanceId}::uuid
				AND external_subscription_id = 'sub_migrate_stripe'
		`;

		const preview = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: {
						kind: "cancel",
						externalSubscriptionId: "sub_migrate_stripe",
						effectiveMode: "immediate",
					},
				}),
			},
		);
		expect(preview.status).toBe(200);
		const previewToken = (await preview.json()).data.previewToken as string;
		const executed = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "cancel-trial" },
				body: JSON.stringify({ previewToken }),
			},
		);

		expect(executed.status).toBe(200);
		expect((await executed.json()).data).toMatchObject({
			kind: "subscription_cancellation",
			action: "cancel",
			effectiveMode: "immediate",
		});
		expect(stripe.subscriptionCancellations).toHaveLength(1);
	});

	// capability: subscription.cancel
	it("refuses a cancellation from a read-only project credential", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		const { app } = createIntegrationApp({ env: context.env, repository: context.repository });
		const headers = {
			authorization: `Bearer ${integrationProjectReadOnlyCredential("voysee")}`,
			"content-type": "application/json",
		};

		const preview = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: {
						kind: "cancel",
						externalSubscriptionId: "sub_migrate_stripe",
						effectiveMode: "immediate",
					},
				}),
			},
		);
		expect(preview.status).toBe(403);
		expect((await preview.json()).error.code).toBe("READ_ONLY_CREDENTIAL");

		const execute = await testRequest(
			app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "read-only-cancel" },
				body: JSON.stringify({ previewToken: "11111111-1111-4111-8111-111111111111" }),
			},
		);
		expect(execute.status).toBe(403);
		expect((await execute.json()).error.code).toBe("READ_ONLY_CREDENTIAL");
	});

	it("rejects expired, drifted, mismatched, and cross-account commercial previews", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = {
			...authHeaders("voysee"),
			"content-type": "application/json",
		};
		const preview = async (billingAccountId: string) => {
			const response = await testRequest(
				app,
				`/v1/billing-accounts/${billingAccountId}/commercial-actions/preview`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						intent: { kind: "checkout_product", productKey: "echo_credits_10" },
					}),
				},
			);
			expect(response.status).toBe(200);
			return (await response.json()).data.previewToken as string;
		};
		const execute = (billingAccountId: string, previewToken: string, idempotencyKey: string) =>
			testRequest(app, `/v1/billing-accounts/${billingAccountId}/commercial-actions`, {
				method: "POST",
				headers: { ...headers, "idempotency-key": idempotencyKey },
				body: JSON.stringify({ previewToken }),
			});

		const expiredToken = await preview("expired_account");
		await context.sql`
			UPDATE commercial_action_previews
			SET expires_at = now() - interval '1 minute'
			WHERE preview_token = ${expiredToken}::uuid
		`;
		const expired = await execute("expired_account", expiredToken, "commercial:expired:1");
		expect(expired.status).toBe(409);
		expect((await expired.json()).error.code).toBe("COMMERCIAL_PREVIEW_EXPIRED");

		const staleToken = await preview("stale_account");
		await context.sql`
			UPDATE commercial_action_previews
			SET state_fingerprint = repeat('f', 64)
			WHERE preview_token = ${staleToken}::uuid
		`;
		const stale = await execute("stale_account", staleToken, "commercial:stale:1");
		expect(stale.status).toBe(409);
		expect((await stale.json()).error.code).toBe("COMMERCIAL_PREVIEW_STALE");

		const mismatchToken = await preview("mismatch_account");
		await context.sql`
			UPDATE commercial_action_previews
			SET intent_hash = repeat('0', 64)
			WHERE preview_token = ${mismatchToken}::uuid
		`;
		const mismatch = await execute("mismatch_account", mismatchToken, "commercial:mismatch:1");
		expect(mismatch.status).toBe(409);
		expect((await mismatch.json()).error.code).toBe("COMMERCIAL_PREVIEW_MISMATCH");

		const isolatedToken = await preview("preview_owner");
		const isolated = await execute("other_account", isolatedToken, "commercial:isolation:1");
		expect(isolated.status).toBe(409);
		expect((await isolated.json()).error.code).toBe("COMMERCIAL_PREVIEW_NOT_FOUND");
		expect(stripe.checkoutSessionParams).toHaveLength(0);
	});

	it("retries a failed provider call only with the original commercial idempotency key", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeCheckoutSessionFailures: 1,
		});
		const headers = {
			...authHeaders("voysee"),
			"content-type": "application/json",
		};
		const previewResponse = await testRequest(
			app,
			"/v1/billing-accounts/retry_account/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: { kind: "checkout_product", productKey: "echo_credits_10" },
				}),
			},
		);
		const previewToken = (await previewResponse.json()).data.previewToken as string;
		const execute = (idempotencyKey: string) =>
			testRequest(app, "/v1/billing-accounts/retry_account/commercial-actions", {
				method: "POST",
				headers: { ...headers, "idempotency-key": idempotencyKey },
				body: JSON.stringify({ previewToken }),
			});

		const failed = await execute("commercial:provider-retry:1");
		expect(failed.status).toBe(500);
		const [executing] = await context.sql<
			Array<{ status: string; execution_idempotency_key: string; has_result: boolean }>
		>`
			SELECT status, execution_idempotency_key, execution_result IS NOT NULL AS has_result
			FROM commercial_action_previews
			WHERE preview_token = ${previewToken}::uuid
		`;
		expect(executing).toEqual({
			status: "executing",
			execution_idempotency_key: "commercial:provider-retry:1",
			has_result: false,
		});

		const wrongKey = await execute("commercial:provider-retry:2");
		expect(wrongKey.status).toBe(409);
		expect((await wrongKey.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");

		const retry = await execute("commercial:provider-retry:1");
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({
			success: true,
			data: { kind: "checkout", sessionId: "cs_test_integration" },
		});
		expect(stripe.checkoutSessionParams).toHaveLength(2);
	});

	it("replays completed Checkout receipts without creating another Stripe session", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const request = () =>
			testRequest(app, "/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions", {
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
					"idempotency-key": "checkout-receipt-1",
				},
				body: JSON.stringify({ productKey: "echo_credits_10" }),
			});

		const first = await request();
		const replay = await request();

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_integration",
				url: "https://checkout.stripe.test/session/cs_test_integration",
				duplicate: false,
			},
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_integration",
				url: "https://checkout.stripe.test/session/cs_test_integration",
				duplicate: true,
			},
		});
		expect(stripe.checkoutSessionParams).toHaveLength(1);
	});

	it("returns 404 for an unknown Checkout catalog product", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ productKey: "missing_product" }),
			},
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PRODUCT_NOT_FOUND",
				message: "Active Stripe web product missing_product was not found",
			},
		});
		expect(stripe.calls).toEqual([]);
	});

	// capability: portal.session
	it("creates Stripe Portal sessions and links customers", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const first = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/providers/stripe/portal-sessions",
			{
				method: "POST",
				headers: authHeaders("voysee"),
			},
		);
		const second = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/providers/stripe/portal-sessions",
			{
				method: "POST",
				headers: authHeaders("voysee"),
			},
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await first.json()).toEqual({
			success: true,
			data: { url: "https://billing.stripe.test/session/bps_integration" },
		});
		expect(await second.json()).toEqual({
			success: true,
			data: { url: "https://billing.stripe.test/session/bps_integration" },
		});
		expect(stripe.portalSessionParams).toEqual([
			{
				customer: "cus_integration",
				return_url: "https://app.integration.test/account/billing",
			},
			{
				customer: "cus_integration",
				return_url: "https://app.integration.test/account/billing",
			},
		]);
		expect(stripe.calls).toEqual([
			"createCustomer:integration_user",
			"createPortalSession",
			"createPortalSession",
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			store_events: 0,
			projection_sync_jobs: 0,
		});
		await expectProviderCustomerRow(context.sql, {
			billingAccountId: "integration_user",
			provider: "stripe",
			externalCustomerId: "cus_integration",
		});
	});

	it("returns Stripe Checkout session status for owned sessions", async () => {
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/providers/stripe/checkout-sessions/cs_test_integration",
			{
				headers: authHeaders("voysee"),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_integration",
				status: "complete",
				paymentStatus: "paid",
				customerEmail: null,
				productKey: "echo_credits_10",
			},
		});
		expect(stripe.calls).toEqual(["retrieveCheckoutSession:cs_test_integration"]);
		await expectTableCounts(context.sql, {
			customers: 0,
			provider_customers: 0,
			purchases: 0,
			subscriptions: 0,
			entitlements: 0,
			store_events: 0,
			projection_sync_jobs: 0,
		});
	});

	// capability: catalog.product.consumable
	// capability: checkout.hosted
	// capability: webhook.ingest
	it("records Stripe checkout webhooks as credit purchases", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_checkout",
			),
		});

		const response = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_checkout" }),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.status).toBe("processed");
		expect(body.data.eventType).toBe("checkout.session.completed");
		expectEmptySnapshot(body.data.entitlements, "integration_user");
		expect(fixture.stripe.calls).toEqual([
			`constructWebhookEvent:${JSON.stringify({ type: "checkout.session.completed", data: { object: {} }, id: "evt_checkout" })}:sig_test`,
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 1,
			projection_sync_jobs: 1,
			billing_invoices: 1,
		});
		const invoices = await context.sql<
			Array<{
				external_invoice_id: string;
				status: string;
				amount_paid: number | string;
				currency: string;
				subscription_id: string | null;
			}>
		>`
			SELECT external_invoice_id, status, amount_paid, currency, subscription_id
			FROM billing_invoices
		`;
		expect(invoices).toHaveLength(1);
		expect(invoices[0]?.external_invoice_id).toBe("cs_test_integration");
		expect(invoices[0]?.status).toBe("paid");
		expect(Number(invoices[0]?.amount_paid)).toBe(499);
		expect(invoices[0]?.currency).toBe("usd");
		expect(invoices[0]?.subscription_id).toBeNull();
		await expectProviderCustomerRow(context.sql, {
			billingAccountId: "integration_user",
			provider: "stripe",
			externalCustomerId: "cus_integration",
		});
		await expectStripeConsumablePurchaseRows(context.sql, { purchaseStatus: "completed" });
		const storeEvent = await expectStoreEvent(context.sql, {
			provider: "stripe",
			eventType: "checkout.session.completed",
			status: "processed",
		});
		expect(storeEvent.processing_error).toBeNull();
		await expectStripeStoreEventRows(context.sql, {
			eventType: "checkout.session.completed",
			externalEventId: "evt_checkout",
			transactionId: "pi_integration",
			purchaseKind: "consumable",
		});
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "provider_webhook",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe("stripe:payment:pi_integration:projection");
		expectProjectionPurchase(projectionJob.payload);
	});

	// capability: catalog.product.consumable
	// capability: catalog.topup
	// capability: topup.customer_initiated
	it("maps a Stripe one-time price to the published top-up allocation", async () => {
		await publishAiCreditsCatalog(context.repository);
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_catalog_topup",
			),
		});
		const first = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_catalog_topup" }),
		);
		const duplicate = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_catalog_topup" }),
		);

		expect(first.status).toBe(200);
		expect(duplicate.status).toBe(200);
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "10", available: "10" });
		const [count] = await context.sql<Array<{ count: number }>>`
			SELECT count(*)::integer AS count
			FROM balance_allocations
			WHERE source_kind = 'topup'
		`;
		expect(count.count).toBe(1);
	});

	// capability: catalog.product.subscription
	// capability: webhook.ingest
	it("records Stripe subscription-created webhooks as premium entitlements without purchase rows", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"customer.subscription.created",
				stripeSubscriptionObject(),
				"evt_subscription_created",
			),
		});

		const response = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_subscription_created" }),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.status).toBe("processed");
		expect(body.data.eventType).toBe("customer.subscription.created");
		expectActivePremiumSnapshot(body.data.entitlements, "integration_user");
		expect(body.data.entitlements.entitlements[0].metadata).not.toHaveProperty("trialEndsAt");
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 0,
			subscriptions: 1,
			entitlements: 1,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectProviderCustomerRow(context.sql, {
			billingAccountId: "integration_user",
			provider: "stripe",
			externalCustomerId: "cus_integration",
		});
		await expectStripeSubscriptionRows(context.sql, {
			subscriptionStatus: "active",
			entitlementActive: true,
		});
		const storeEvent = await expectStoreEvent(context.sql, {
			provider: "stripe",
			eventType: "customer.subscription.created",
			status: "processed",
		});
		expect(storeEvent.processing_error).toBeNull();
		await expectStripeStoreEventRows(context.sql, {
			eventType: "customer.subscription.created",
			externalEventId: "evt_subscription_created",
			transactionId: "in_integration",
			purchaseKind: "subscription",
		});
		const projectionJob = await expectProjectionJob(context.sql, {
			billingAccountId: "integration_user",
			reason: "provider_webhook",
			status: "pending",
		});
		expect(projectionJob.idempotency_key).toBe(
			"stripe:subscription:sub_1:customer.subscription.created:evt_subscription_created:projection",
		);
		expect(projectionJob.payload.purchase).toBeUndefined();
		expect(projectionJob.payload.reversal).toBeUndefined();

		const entitlements = await testRequest(
			fixture.app,
			"/v1/billing-accounts/integration_user/entitlements",
			{
				headers: fixture.authHeaders("voysee"),
			},
		);

		expect(entitlements.status).toBe(200);
		expectActivePremiumSnapshot((await entitlements.json()).data, "integration_user");
	});

	it("keeps the upgraded price when a later invoice still carries Checkout metadata", async () => {
		const project = integrationProjectContext("voysee");
		const service = new StripeBillingService({
			config: {
				projectKey: "voysee",
				checkoutSuccessUrl:
					"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.integration.test/billing",
				portalReturnUrl: "https://app.integration.test/account/billing",
			},
			client: createFakeStripeBillingClient().client,
			repository: context.repository.forProject(project),
		});
		await context.sql`
			INSERT INTO store_products (
				project_id, product_id, provider, channel, external_product_id, external_price_id,
				billing_period, currency, price_amount
			)
			SELECT project_id, product_id, provider, channel, 'prod_upgrade', 'price_upgrade',
				billing_period, currency, 1999
			FROM store_products
			WHERE external_price_id = 'price_premium_monthly'
		`;
		const periodStart = Math.floor(Date.now() / 1000) - 86_400;
		const periodEnd = periodStart + 30 * 86_400;
		// Stripe keeps the Checkout metadata on the subscription after the price change.
		const upgraded = await service.handleVerifiedAppEvent({
			id: "evt_upgrade_subscription",
			type: "customer.subscription.updated",
			created: periodStart + 100,
			data: {
				object: stripeSubscriptionObject({
					current_period_start: periodStart,
					current_period_end: periodEnd,
					items: {
						data: [
							{
								id: "si_integration",
								quantity: 1,
								price: { id: "price_upgrade", product: "prod_upgrade" },
								current_period_start: periodStart,
								current_period_end: periodEnd,
							},
						],
					},
				}),
			},
		});
		expect(upgraded.status).toBe("processed");
		const subscriptionRow = () => context.sql<
			Array<{ external_price_id: string; external_product_id: string; store_price: string }>
		>`
			SELECT subscription.external_price_id, subscription.external_product_id,
				store.external_price_id AS store_price
			FROM subscriptions subscription
			JOIN store_products store ON store.id = subscription.store_product_id
			WHERE subscription.external_subscription_id = 'sub_1'
		`;
		expect((await subscriptionRow())[0]).toEqual({
			external_price_id: "price_upgrade",
			external_product_id: "prod_upgrade",
			store_price: "price_upgrade",
		});

		const invoiced = await service.handleVerifiedAppEvent({
			id: "evt_upgrade_invoice",
			type: "invoice.paid",
			created: periodStart + 101,
			data: {
				object: {
					id: "in_upgrade",
					object: "invoice",
					customer: "cus_integration",
					subscription: "sub_1",
					status: "paid",
					created: periodStart,
					amount_paid: 1999,
					currency: "usd",
					parent: {
						subscription_details: {
							subscription: "sub_1",
							metadata: stripeSubscriptionObject().metadata,
						},
					},
					lines: {
						data: [
							{
								id: "il_upgrade",
								parent: {
									subscription_item_details: {
										subscription: "sub_1",
										subscription_item: "si_integration",
										proration: false,
									},
								},
								pricing: { price_details: { product: "prod_upgrade", price: "price_upgrade" } },
								period: { start: periodStart, end: periodEnd },
							},
						],
					},
				},
			},
		});
		expect(invoiced.status).toBe("processed");
		expect((await subscriptionRow())[0]).toEqual({
			external_price_id: "price_upgrade",
			external_product_id: "prod_upgrade",
			store_price: "price_upgrade",
		});
		await expectTableCounts(context.sql, { subscriptions: 1, billing_invoices: 1 });
	});

	// capability: refund.sync
	it("records Stripe refunds as reversal projection context", async () => {
		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_checkout",
			),
		});
		const refund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent("refund.created", stripeRefundObject(), "evt_refund"),
		});

		const checkoutResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(checkout, { id: "evt_checkout" }),
		);
		const refundResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(refund, { id: "evt_refund" }),
		);
		const refundBody = await refundResponse.json();

		expect(checkoutResponse.status).toBe(200);
		expect(refundResponse.status).toBe(200);
		expect(refundBody.success).toBe(true);
		expect(refundBody.data.status).toBe("processed");
		expect(refundBody.data.eventType).toBe("refund.created");
		expectEmptySnapshot(refundBody.data.entitlements, "integration_user");
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 2,
			projection_sync_jobs: 2,
		});
		await expectStripeConsumablePurchaseRows(context.sql, {
			purchaseStatus: "refunded",
			reversedAmount: "499",
			reversedCreditAmount: 10,
		});
		await expectStripeStoreEventRows(context.sql, {
			eventType: "refund.created",
			externalEventId: "evt_refund",
			transactionId: "re_integration",
			purchaseKind: "consumable",
		});
		const projectionJob = await expectProjectionJobByKey(
			context.sql,
			"stripe:refund:re_integration:reversal",
		);
		expect(projectionJob.reason).toBe("provider_webhook");
		expectProjectionReversal(projectionJob.payload);
	});

	it("records an invoice delivered after a newer subscription event", async () => {
		const service = new StripeBillingService({
			config: {
				projectKey: "voysee",
				checkoutSuccessUrl:
					"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.integration.test/billing",
				portalReturnUrl: "https://app.integration.test/account/billing",
			},
			client: createFakeStripeBillingClient().client,
			repository: context.repository.forProject(integrationProjectContext("voysee")),
		});
		const start = Math.floor(Date.now() / 1000) - 86_400;
		const end = start + 30 * 86_400;
		const metadata = {
			billingAccountId: "integration_user",
			externalProductId: "prod_stripe_premium",
			externalPriceId: "price_premium_monthly",
			productKey: "premium_monthly",
			purchaseKind: "subscription",
		};
		const invoiceEvent = (id: string, created: number, amountPaid: number) => ({
			id,
			type: "invoice.paid",
			created,
			data: {
				object: {
					id: "in_out_of_order",
					object: "invoice",
					customer: "cus_integration",
					subscription: "sub_1",
					status: "paid",
					created,
					amount_paid: amountPaid,
					currency: "usd",
					parent: { subscription_details: { subscription: "sub_1", metadata } },
					lines: {
						data: [
							{
								id: "il_out_of_order",
								parent: {
									subscription_item_details: {
										subscription: "sub_1",
										subscription_item: "si_integration",
									},
								},
								pricing: {
									price_details: { product: "prod_stripe_premium", price: "price_premium_monthly" },
								},
								period: { start, end },
							},
						],
					},
				},
			},
		});
		const readSubscription = async () => {
			const [row] = await context.sql<
				Array<{ id: string; last_provider_event_created: string; current_period_end: Date }>
			>`
				SELECT id, last_provider_event_created::text, current_period_end
				FROM subscriptions
				WHERE external_subscription_id = 'sub_1'
			`;
			if (row === undefined) throw new Error("Expected the Stripe subscription row");
			return row;
		};
		const readInvoices = () =>
			context.sql<
				Array<{
					subscription_id: string | null;
					status: string;
					amount_paid: number;
					last_provider_event_created: string;
				}>
			>`
				SELECT subscription_id, status, amount_paid::integer AS amount_paid,
					last_provider_event_created::text
				FROM billing_invoices
				WHERE external_invoice_id = 'in_out_of_order'
			`;

		const newer = await service.handleVerifiedAppEvent({
			id: "evt_newer_subscription",
			type: "customer.subscription.updated",
			created: start + 200,
			data: {
				object: stripeSubscriptionObject({
					current_period_start: start,
					current_period_end: end,
				}),
			},
		});
		expect(newer.status).toBe("processed");
		const before = await readSubscription();
		expect(before.last_provider_event_created).toBe(String(start + 200));

		// The invoice event is older than the stored subscription state, so the subscription
		// snapshot is kept, but the invoice itself is a fact that belongs in the history.
		const older = await service.handleVerifiedAppEvent(
			invoiceEvent("evt_older_invoice", start + 100, 999),
		);
		expect(older.status).toBe("processed");
		expect(await readInvoices()).toEqual([
			{
				subscription_id: before.id,
				status: "paid",
				amount_paid: 999,
				last_provider_event_created: String(start + 100),
			},
		]);
		expect(await readSubscription()).toEqual(before);

		// Redelivering the same event id is idempotent.
		await service.handleVerifiedAppEvent(invoiceEvent("evt_older_invoice", start + 100, 999));
		expect(await readInvoices()).toHaveLength(1);

		// A newer event for the same invoice updates it; a later-delivered older one does not.
		await service.handleVerifiedAppEvent(invoiceEvent("evt_newest_invoice", start + 300, 1099));
		const newest = {
			subscription_id: before.id,
			status: "paid",
			amount_paid: 1099,
			last_provider_event_created: String(start + 300),
		};
		expect(await readInvoices()).toEqual([newest]);
		await service.handleVerifiedAppEvent(invoiceEvent("evt_stale_invoice", start + 150, 500));
		expect(await readInvoices()).toEqual([newest]);
	});

	// capability: catalog.product.non_consumable
	// capability: refund.sync
	it("grants and fully refunds a Stripe non-consumable one-time purchase", async () => {
		await context.sql`
			INSERT INTO products (
				project_id, key, entitlement_key, credit_amount, name, type, active
			)
			SELECT id, 'lifetime_access', 'lifetime_access', 0, 'Lifetime access',
				'non_consumable', true
			FROM projects WHERE key = 'voysee'
		`;
		await context.sql`
			INSERT INTO store_products (
				project_id, product_id, provider, channel, external_product_id,
				external_price_id, billing_period, currency, price_amount, active
			)
			SELECT project.id, product.id, 'stripe', 'web', 'prod_lifetime_access',
				'price_lifetime_access', 'one_time', 'usd', 1999, true
			FROM projects project
			JOIN products product
				ON product.project_id = project.id AND product.key = 'lifetime_access'
			WHERE project.key = 'voysee'
		`;
		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					id: "cs_lifetime",
					payment_intent: "pi_lifetime",
					amount_total: 1999,
					metadata: {
						billingAccountId: "lifetime_user",
						productKey: "lifetime_access",
						purchaseKind: "non_consumable",
						externalProductId: "prod_lifetime_access",
						externalPriceId: "price_lifetime_access",
					},
				}),
				"evt_lifetime_checkout",
			),
		});
		const purchase = await withIsoDateSqlParameters(() =>
			postStripeWebhook(checkout, { id: "evt_lifetime_checkout" }),
		);
		expect(purchase.status).toBe(200);
		expect((await purchase.json()).data.entitlements).toMatchObject({
			billingAccountId: "lifetime_user",
			entitlements: [{ key: "lifetime_access", active: true }],
		});
		const refund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"refund.created",
				stripeRefundObject({
					id: "re_lifetime",
					payment_intent: "pi_lifetime",
					amount: 1999,
				}),
				"evt_lifetime_refund",
			),
		});
		const reversal = await withIsoDateSqlParameters(() =>
			postStripeWebhook(refund, { id: "evt_lifetime_refund" }),
		);
		expect(reversal.status).toBe(200);
		expect((await reversal.json()).data.entitlements).toMatchObject({
			billingAccountId: "lifetime_user",
			entitlements: [{ key: "lifetime_access", active: false }],
		});
		const [row] = await context.sql<
			Array<{ purchase_kind: string; status: string; reversed_amount: string }>
		>`
			SELECT purchase_kind, status, reversed_amount::text
			FROM purchases WHERE transaction_id = 'pi_lifetime'
		`;
		expect(row).toEqual({
			purchase_kind: "non_consumable",
			status: "refunded",
			reversed_amount: "1999",
		});
	});

	// capability: refund.sync
	it("records partial Stripe refunds as proportional reversal projection context", async () => {
		await publishAiCreditsCatalog(context.repository);
		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_checkout",
			),
		});
		const refund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"refund.created",
				stripeRefundObject({ id: "re_partial", amount: 250 }),
				"evt_refund_partial",
			),
		});
		const refundUpdated = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"refund.updated",
				stripeRefundObject({ id: "re_partial", amount: 250 }),
				"evt_refund_partial_updated",
			),
		});

		const checkoutResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(checkout, { id: "evt_checkout" }),
		);
		const refundResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(refund, { id: "evt_refund_partial" }),
		);
		const refundBody = await refundResponse.json();
		const updatedResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(refundUpdated, { id: "evt_refund_partial_updated" }),
		);

		expect(checkoutResponse.status).toBe(200);
		expect(refundResponse.status).toBe(200);
		expect(refundBody.success).toBe(true);
		expect(refundBody.data.status).toBe("processed");
		expect(refundBody.data.eventType).toBe("refund.created");
		expect(updatedResponse.status).toBe(200);
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "5", available: "5" });
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 3,
			projection_sync_jobs: 2,
		});
		await expectStripeConsumablePurchaseRows(context.sql, {
			purchaseStatus: "completed",
			reversedAmount: "250",
			reversedCreditAmount: 5,
			reversalId: "re_partial",
		});
		const projectionJob = await expectProjectionJobByKey(
			context.sql,
			"stripe:refund:re_partial:reversal",
		);
		expect(projectionJob.reason).toBe("provider_webhook");
		expectProjectionReversal(projectionJob.payload, {
			transactionId: "re_partial",
			creditAmount: 5,
		});
		const [allocation] = await context.sql<Array<{ reversed_quantity: string }>>`
			SELECT reversed_quantity::text FROM balance_allocations
		`;
		expect(allocation).toEqual({ reversed_quantity: "5.000000000" });
	});

	it("grants credits for a fully discounted Stripe Checkout purchase", async () => {
		await publishAiCreditsCatalog(context.repository);
		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					id: "cs_fully_discounted",
					amount_total: 0,
					charge: null,
					latest_charge: null,
					payment_intent: null,
					payment_status: "no_payment_required",
				}),
				"evt_fully_discounted",
			),
		});

		const response = await withIsoDateSqlParameters(() =>
			postStripeWebhook(checkout, { id: "evt_fully_discounted" }),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).data.status).toBe("processed");
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ granted: "10", available: "10" });
		const purchases = await context.sql<
			Array<{ transaction_id: string; status: string; amount_paid_minor: string; currency: string }>
		>`
			SELECT transaction_id, status, amount_paid_minor::text, currency
			FROM purchases
		`;
		expect(purchases).toEqual([
			{
				transaction_id: "cs_fully_discounted",
				status: "completed",
				amount_paid_minor: "0",
				currency: "usd",
			},
		]);
		await expectProjectionJobByKey(context.sql, "stripe:payment:cs_fully_discounted:projection");
	});

	it("reverses all credits when a discounted Stripe purchase is refunded in full", async () => {
		await publishAiCreditsCatalog(context.repository);
		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({ amount_total: 399 }),
				"evt_discounted_checkout",
			),
		});
		const refund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"refund.created",
				stripeRefundObject({ id: "re_discounted", amount: 399 }),
				"evt_discounted_refund",
			),
		});

		const checkoutResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(checkout, { id: "evt_discounted_checkout" }),
		);
		const refundResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(refund, { id: "evt_discounted_refund" }),
		);

		expect(checkoutResponse.status).toBe(200);
		expect(refundResponse.status).toBe(200);
		expect((await refundResponse.json()).data.status).toBe("processed");
		expect(
			await context.repository.getMeteringBalance(
				integrationProjectContext(),
				"integration_user",
				"ai_credits",
			),
		).toMatchObject({ available: "0" });
		const [purchase] = await context.sql<
			Array<{
				amount_paid_minor: string;
				reversed_amount: string;
				reversed_credit_amount: number;
			}>
		>`
			SELECT amount_paid_minor::text, reversed_amount::text, reversed_credit_amount
			FROM purchases
			WHERE transaction_id = 'pi_integration'
		`;
		expect(purchase).toEqual({
			amount_paid_minor: "399",
			reversed_amount: "399",
			reversed_credit_amount: 10,
		});
	});

	it("ignores cumulative charge.refunded events around incremental refund events", async () => {
		await context.sql`
			UPDATE products
			SET credit_amount = 100
			WHERE project_id = (SELECT id FROM projects WHERE key = 'voysee')
				AND key = 'echo_credits_10'
		`;
		await context.sql`
			UPDATE store_products
			SET price_amount = 1000
			WHERE project_id = (SELECT id FROM projects WHERE key = 'voysee')
				AND provider = 'stripe'
				AND external_product_id = 'prod_stripe_credits_10'
				AND external_price_id = 'price_credits_10'
		`;

		const checkout = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({ amount_total: 1000 }),
				"evt_checkout_cumulative_refund",
			),
		});
		const firstCharge = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"charge.refunded",
				stripeRefundedChargeObject({ amount_refunded: 400 }),
				"evt_charge_refunded_400",
			),
		});
		const firstRefund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"refund.created",
				stripeRefundObject({ id: "re_partial_400", amount: 400 }),
				"evt_refund_400",
			),
		});
		const secondCharge = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"charge.refunded",
				stripeRefundedChargeObject({ amount_refunded: 700 }),
				"evt_charge_refunded_700",
			),
		});
		const secondRefund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"refund.created",
				stripeRefundObject({ id: "re_partial_300", amount: 300 }),
				"evt_refund_300",
			),
		});

		expect(
			(
				await withIsoDateSqlParameters(() =>
					postStripeWebhook(checkout, { id: "evt_checkout_cumulative_refund" }),
				)
			).status,
		).toBe(200);
		const firstChargeResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(firstCharge, { id: "evt_charge_refunded_400" }),
		);
		expect(await firstChargeResponse.json()).toMatchObject({
			success: true,
			data: { status: "ignored", eventType: "charge.refunded", entitlements: null },
		});
		await expectStripeConsumablePurchaseRows(context.sql, {
			purchaseStatus: "completed",
			creditAmount: 100,
			reversedAmount: "0",
			reversedCreditAmount: 0,
		});

		expect(
			(
				await withIsoDateSqlParameters(() =>
					postStripeWebhook(firstRefund, { id: "evt_refund_400" }),
				)
			).status,
		).toBe(200);
		const secondChargeResponse = await withIsoDateSqlParameters(() =>
			postStripeWebhook(secondCharge, { id: "evt_charge_refunded_700" }),
		);
		expect(await secondChargeResponse.json()).toMatchObject({
			success: true,
			data: { status: "ignored", eventType: "charge.refunded", entitlements: null },
		});
		expect(
			(
				await withIsoDateSqlParameters(() =>
					postStripeWebhook(secondRefund, { id: "evt_refund_300" }),
				)
			).status,
		).toBe(200);

		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 3,
			projection_sync_jobs: 3,
		});
		await expectStripeConsumablePurchaseRows(context.sql, {
			purchaseStatus: "completed",
			creditAmount: 100,
			reversedAmount: "700",
			reversedCreditAmount: 70,
			reversalId: "re_partial_300",
		});
		const firstProjection = await expectProjectionJobByKey(
			context.sql,
			"stripe:refund:re_partial_400:reversal",
		);
		expectProjectionReversal(firstProjection.payload, {
			transactionId: "re_partial_400",
			creditAmount: 40,
			totalCreditAmount: 100,
		});
		const secondProjection = await expectProjectionJobByKey(
			context.sql,
			"stripe:refund:re_partial_300:reversal",
		);
		expectProjectionReversal(secondProjection.payload, {
			transactionId: "re_partial_300",
			creditAmount: 30,
			totalCreditAmount: 100,
		});
	});

	it("publishes top-up and reversal state without legacy mutation operations", async () => {
		await withIsoDateSqlParameters(() =>
			context.repository.recordStripeCreditPurchaseAndEnqueueProjection(
				integrationProjectContext(),
				{
					purchaseKind: "consumable",
					billingAccountId: "operation_topup_user",
					stripeCustomerId: "cus_operation_topup",
					externalProductId: "prod_stripe_credits_10",
					externalPriceId: "price_credits_10",
					transactionId: "pi_operation_topup",
					paymentIntentId: "pi_operation_topup",
					chargeId: "ch_operation_topup",
					checkoutSessionId: "cs_operation_topup",
					purchasedAt: new Date("2026-08-01T00:00:00.000Z"),
					rawPayload: { id: "cs_operation_topup" },
					eventType: "checkout.session.completed",
					externalEventId: "evt_operation_topup",
					projectionIdempotencyKey: "stripe:payment:pi_operation_topup:projection",
					projectionContract: "billing_state_v1",
				},
			),
		);
		await withIsoDateSqlParameters(() =>
			context.repository.recordStripeCreditReversalAndEnqueueProjection(
				integrationProjectContext(),
				stripeOperationReversalInput({
					reversalId: "re_operation_topup",
					paymentIntentId: "pi_operation_topup",
					chargeId: "ch_operation_topup",
					externalEventId: "evt_operation_topup_refund",
					projectionIdempotencyKey: "stripe:refund:re_operation_topup:projection",
				}),
			),
		);
		await withIsoDateSqlParameters(() =>
			context.repository.recordStripeCreditReversalAndEnqueueProjection(
				integrationProjectContext(),
				stripeOperationReversalInput({
					reversalReason: "dispute",
					reversalId: "dp_operation_topup",
					paymentIntentId: "pi_operation_topup",
					chargeId: "ch_operation_topup",
					eventType: "charge.dispute.created",
					externalEventId: "evt_operation_topup_dispute",
					projectionIdempotencyKey: "stripe:dispute:dp_operation_topup:projection",
				}),
			),
		);

		const purchaseProjection = await expectProjectionJobByKey(
			context.sql,
			"stripe:payment:pi_operation_topup:projection",
		);
		expect(purchaseProjection.payload).toMatchObject({
			billingAccountId: "operation_topup_user",
			balances: [],
			purchase: { transactionId: "pi_operation_topup" },
		});
		expect("operation" in purchaseProjection.payload).toBe(false);

		const reversalProjection = await expectProjectionJobByKey(
			context.sql,
			"stripe:refund:re_operation_topup:projection",
		);
		expect(reversalProjection.payload).toMatchObject({
			billingAccountId: "operation_topup_user",
			balances: [],
			reversal: { transactionId: "re_operation_topup" },
		});
		expect("operation" in reversalProjection.payload).toBe(false);
	});

	it("rejects missing Stripe signatures before durable writes", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await postStripeWebhook(fixture, {}, null);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "INVALID_REQUEST",
				message: "Stripe signature must not be blank",
			},
		});
		expect(fixture.stripe.calls).toEqual([]);
		await expectNoDurableRows(context.sql);
	});

	// capability: webhook.ingest
	it("rejects invalid Stripe signatures before durable writes", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeConstructWebhookError: new Error("bad sig"),
		});

		const response = await postStripeWebhook(fixture, { id: "evt_bad_sig" });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "STRIPE_WEBHOOK_SIGNATURE_INVALID",
				message: "Stripe webhook signature is invalid",
			},
		});
		expect(fixture.stripe.calls).toEqual([
			`constructWebhookEvent:${JSON.stringify({ type: "checkout.session.completed", data: { object: {} }, id: "evt_bad_sig" })}:sig_test`,
		]);
		await expectNoDurableRows(context.sql);
	});

	it("ignores unsupported Stripe webhook events without granting entitlements", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"payment_intent.succeeded",
				{ id: "pi_unsupported" },
				"evt_unsupported",
			),
		});

		const response = await postStripeWebhook(fixture, { id: "evt_unsupported" });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				status: "ignored",
				eventType: "payment_intent.succeeded",
				entitlements: null,
			},
		});
		expect(fixture.stripe.calls).toEqual([
			`constructWebhookEvent:${JSON.stringify({ type: "checkout.session.completed", data: { object: {} }, id: "evt_unsupported" })}:sig_test`,
		]);
		await expectNoDurableRows(context.sql);
	});

	// capability: webhook.ingest
	it("keeps repeated Stripe webhook event ids idempotent", async () => {
		const fixture = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject(),
				"evt_checkout",
			),
		});

		const first = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_checkout" }),
		);
		const second = await withIsoDateSqlParameters(() =>
			postStripeWebhook(fixture, { id: "evt_checkout" }),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(fixture.stripe.calls).toEqual([
			`constructWebhookEvent:${JSON.stringify({ type: "checkout.session.completed", data: { object: {} }, id: "evt_checkout" })}:sig_test`,
			`constructWebhookEvent:${JSON.stringify({ type: "checkout.session.completed", data: { object: {} }, id: "evt_checkout" })}:sig_test`,
		]);
		await expectTableCounts(context.sql, {
			customers: 1,
			provider_customers: 1,
			purchases: 1,
			subscriptions: 0,
			entitlements: 0,
			store_events: 1,
			projection_sync_jobs: 1,
		});
		await expectStripeConsumablePurchaseRows(context.sql, { purchaseStatus: "completed" });
		const projectionJob = await expectProjectionJobByKey(
			context.sql,
			"stripe:payment:pi_integration:projection",
		);
		expectProjectionPurchase(projectionJob.payload);
	});

	// capability: subscription.sync
	it("keeps cancellation and trial state when a paid invoice arrives", async () => {
		const service = createVerifiedEventService();
		const start = Math.floor(Date.now() / 1000) - 86_400;
		const end = start + 30 * 86_400;

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"customer.subscription.updated",
				stripeSubscriptionObject({
					status: "trialing",
					cancel_at_period_end: true,
					trial_start: start,
					trial_end: end,
					current_period_start: start,
					current_period_end: end,
				}),
				start + 100,
				"evt_trial_cancel",
			),
		);
		expect(await stripeSubscriptionLifecycle(context.sql)).toEqual({
			status: "active",
			provider_status: "trialing",
			cancel_at_period_end: true,
			auto_renew: false,
			trial_start_at: new Date(start * 1000),
			trial_end_at: new Date(end * 1000),
		});

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"invoice.paid",
				stripeSubscriptionInvoiceObject({ start, end }, { amount_paid: 0 }),
				start + 101,
				"evt_trial_invoice",
			),
		);

		expect(await stripeSubscriptionLifecycle(context.sql)).toEqual({
			status: "active",
			provider_status: "trialing",
			cancel_at_period_end: true,
			auto_renew: false,
			trial_start_at: new Date(start * 1000),
			trial_end_at: new Date(end * 1000),
		});
		await expectTableCounts(context.sql, { subscriptions: 1, billing_invoices: 1 });
	});

	// capability: catalog.trial
	// capability: subscription.sync
	it("projects the trial bounds of a subscription entitlement", async () => {
		const service = createVerifiedEventService();
		const now = Math.floor(Date.now() / 1000);
		const trialStart = now - 86_400;
		const trialEnd = now + 13 * 86_400;
		const trialMetadata = (end: number) => ({
			trialStartsAt: new Date(trialStart * 1000).toISOString(),
			trialEndsAt: new Date(end * 1000).toISOString(),
		});

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"customer.subscription.created",
				stripeSubscriptionObject({
					status: "trialing",
					trial_start: trialStart,
					trial_end: trialEnd,
				}),
				now - 120,
				"evt_trial_created",
			),
		);

		const snapshot = await context.repository.getEntitlementSnapshot(
			integrationProjectContext("voysee"),
			"integration_user",
		);
		expect(snapshot.entitlements).toEqual([
			{
				key: "premium",
				active: true,
				expiresAt: "2099-06-30T00:00:00.000Z",
				metadata: expect.objectContaining({ status: "active", ...trialMetadata(trialEnd) }),
			},
		]);
		const created = await expectProjectionJobByKey(
			context.sql,
			"stripe:subscription:sub_1:customer.subscription.created:evt_trial_created:projection",
		);
		expect(created.payload.entitlements.entitlements[0]?.metadata).toMatchObject(
			trialMetadata(trialEnd),
		);

		// Ending the trial early moves trial_end to now; Stripe keeps both bounds on the subscription.
		const endedAt = now - 60;
		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"customer.subscription.updated",
				stripeSubscriptionObject({ trial_start: trialStart, trial_end: endedAt }),
				now - 30,
				"evt_trial_ended",
			),
		);

		const ended = await expectProjectionJobByKey(
			context.sql,
			"stripe:subscription:sub_1:customer.subscription.updated:evt_trial_ended:projection",
		);
		expect(ended.payload.entitlements.entitlements[0]?.metadata).toMatchObject({
			status: "active",
			...trialMetadata(endedAt),
		});
	});

	// capability: subscription.sync
	it("does not revive an expired subscription when an old usage invoice is paid", async () => {
		const service = createVerifiedEventService();
		const start = Math.floor(Date.now() / 1000) - 86_400;
		const oldStart = start - 60 * 86_400;
		const oldEnd = start - 30 * 86_400;

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"customer.subscription.deleted",
				stripeSubscriptionObject({
					status: "canceled",
					current_period_start: oldStart,
					current_period_end: oldEnd,
					items: {
						data: [
							{
								current_period_start: oldStart,
								current_period_end: oldEnd,
								id: "si_integration",
								price: { id: "price_premium_monthly", product: "prod_stripe_premium" },
							},
						],
					},
				}),
				start + 100,
				"evt_expired",
			),
		);
		expect(await stripeSubscriptionLifecycle(context.sql)).toMatchObject({
			status: "expired",
			provider_status: "cancelled",
			auto_renew: false,
		});

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"invoice.paid",
				stripeSubscriptionInvoiceObject(
					{ start: oldStart, end: oldEnd },
					{
						id: "in_old_usage",
						metadata: {
							billingAccountId: "integration_user",
							usageInvoicePeriodId: "period-old-usage",
						},
						lines: {
							data: [
								{
									id: "il_old_usage",
									parent: {
										invoice_item_details: { subscription: "sub_1", invoice_item: "ii_usage" },
									},
									pricing: { price_details: { product: "prod_stripe_premium" } },
									period: { start: oldStart, end: oldEnd },
								},
							],
						},
					},
				),
				start + 101,
				"evt_old_usage_paid",
			),
		);

		const [row] = await context.sql<
			Array<{ status: string; provider_status: string | null; expires_at: Date }>
		>`
			SELECT status, provider_status, expires_at FROM subscriptions
		`;
		expect(row).toEqual({
			status: "expired",
			provider_status: "cancelled",
			expires_at: new Date(oldEnd * 1000),
		});
		await expectTableCounts(context.sql, { subscriptions: 1, billing_invoices: 1 });
	});

	// capability: subscription.sync
	it("moves a live subscription between payment states on invoice outcomes only", async () => {
		const service = createVerifiedEventService();
		const start = Math.floor(Date.now() / 1000) - 86_400;
		const end = start + 30 * 86_400;
		const period = { start, end };

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"customer.subscription.updated",
				stripeSubscriptionObject({ current_period_start: start, current_period_end: end }),
				start + 100,
				"evt_live",
			),
		);
		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"invoice.payment_failed",
				stripeSubscriptionInvoiceObject(period, { id: "in_failed", status: "open" }),
				start + 101,
				"evt_payment_failed",
			),
		);
		expect(await stripeSubscriptionLifecycle(context.sql)).toMatchObject({
			status: "billing_retry",
			provider_status: "past_due",
			cancel_at_period_end: false,
			auto_renew: true,
		});

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"invoice.paid",
				stripeSubscriptionInvoiceObject(period, { id: "in_failed" }),
				start + 102,
				"evt_payment_recovered",
			),
		);
		expect(await stripeSubscriptionLifecycle(context.sql)).toMatchObject({
			status: "active",
			provider_status: "active",
			cancel_at_period_end: false,
			auto_renew: true,
		});

		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"customer.subscription.updated",
				stripeSubscriptionObject({
					cancel_at_period_end: true,
					current_period_start: start,
					current_period_end: end,
				}),
				start + 103,
				"evt_scheduled_cancel",
			),
		);
		await service.handleVerifiedAppEvent(
			verifiedStripeEvent(
				"invoice.payment_failed",
				stripeSubscriptionInvoiceObject(period, { id: "in_failed_again", status: "open" }),
				start + 104,
				"evt_payment_failed_again",
			),
		);
		expect(await stripeSubscriptionLifecycle(context.sql)).toMatchObject({
			status: "billing_retry",
			provider_status: "past_due",
			cancel_at_period_end: true,
			auto_renew: false,
		});
	});
});

function createVerifiedEventService(): StripeBillingService {
	return new StripeBillingService({
		config: {
			projectKey: "voysee",
			checkoutSuccessUrl:
				"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
			checkoutCancelUrl: "https://app.integration.test/billing",
			portalReturnUrl: "https://app.integration.test/account/billing",
		},
		client: createFakeStripeBillingClient().client,
		repository: context.repository.forProject(integrationProjectContext("voysee")),
	});
}

function verifiedStripeEvent(
	type: string,
	object: Record<string, unknown>,
	created: number,
	id: string,
): Record<string, unknown> {
	return { id, type, created, data: { object } };
}

/** A paid subscription invoice for sub_1 carrying the original Checkout metadata. */
function stripeSubscriptionInvoiceObject(
	period: { start: number; end: number },
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const metadata = {
		billingAccountId: "integration_user",
		externalProductId: "prod_stripe_premium",
		externalPriceId: "price_premium_monthly",
		productKey: "premium_monthly",
		purchaseKind: "subscription",
	};
	return {
		id: "in_subscription",
		object: "invoice",
		customer: "cus_integration",
		subscription: "sub_1",
		status: "paid",
		created: period.start,
		amount_paid: 999,
		currency: "usd",
		parent: { subscription_details: { subscription: "sub_1", metadata } },
		lines: {
			data: [
				{
					id: "il_subscription",
					parent: {
						subscription_item_details: {
							subscription: "sub_1",
							subscription_item: "si_integration",
						},
					},
					pricing: {
						price_details: { product: "prod_stripe_premium", price: "price_premium_monthly" },
					},
					period,
				},
			],
		},
		...overrides,
	};
}

async function stripeSubscriptionLifecycle(sql: SQL): Promise<{
	status: string;
	provider_status: string | null;
	cancel_at_period_end: boolean;
	auto_renew: boolean;
	trial_start_at: Date | null;
	trial_end_at: Date | null;
}> {
	const rows = await sql<
		Array<{
			status: string;
			provider_status: string | null;
			cancel_at_period_end: boolean;
			auto_renew: boolean;
			trial_start_at: Date | null;
			trial_end_at: Date | null;
		}>
	>`
		SELECT status, provider_status, cancel_at_period_end, auto_renew, trial_start_at, trial_end_at
		FROM subscriptions
		WHERE provider = 'stripe' AND external_subscription_id = 'sub_1'
	`;
	expect(rows).toHaveLength(1);
	return rows[0];
}

async function postStripeWebhook(
	fixture: ReturnType<typeof createIntegrationApp>,
	body: Record<string, unknown>,
	signature: string | null = "sig_test",
): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (signature !== null) {
		headers["stripe-signature"] = signature;
	}

	return await testRequest(fixture.app, "/v1/projects/voysee/webhooks/stripe", {
		method: "POST",
		headers,
		body: JSON.stringify({
			type: "checkout.session.completed",
			data: { object: {} },
			...body,
		}),
	});
}

function expectEmptySnapshot(snapshot: EntitlementSnapshot, billingAccountId: string): void {
	expect(snapshot).toEqual({
		billingAccountId,
		generatedAt: expect.any(String),
		entitlements: [],
	});
}

function expectActivePremiumSnapshot(
	snapshot: EntitlementSnapshot,
	billingAccountId: string,
): void {
	expect(snapshot.billingAccountId).toBe(billingAccountId);
	expect(snapshot.generatedAt).toEqual(expect.any(String));
	expect(snapshot.entitlements).toHaveLength(1);
	expect(snapshot.entitlements[0]).toEqual({
		key: "premium",
		active: true,
		expiresAt: "2099-06-30T00:00:00.000Z",
		metadata: expect.objectContaining({
			channel: "web",
			provider: "stripe",
			source: "subscription",
			status: "active",
		}),
	});
}

function expectProjectionPurchase(payload: ProjectionPayload): void {
	expect(payload.purchase).toEqual({
		provider: "stripe",
		channel: "web",
		purchaseKind: "consumable",
		transactionId: "pi_integration",
		productKey: "echo_credits_10",
		creditAmount: 10,
		totalCreditAmount: 10,
		quantity: 1,
		purchasedAt: "2026-05-27T00:00:00.000Z",
	});
	expect(payload.reversal).toBeUndefined();
}

function expectProjectionReversal(
	payload: ProjectionPayload,
	expected: { transactionId?: string; creditAmount?: number; totalCreditAmount?: number } = {},
): void {
	expect(payload.purchase).toBeUndefined();
	expect(payload.reversal).toEqual({
		provider: "stripe",
		channel: "web",
		reason: "refund",
		transactionId: expected.transactionId ?? "re_integration",
		originalTransactionId: "pi_integration",
		productKey: "echo_credits_10",
		creditAmount: expected.creditAmount ?? 10,
		totalCreditAmount: expected.totalCreditAmount ?? 10,
		quantity: 1,
		reversedAt: "2026-05-27T00:00:00.000Z",
	});
}

async function expectNoDurableRows(sql: SQL): Promise<void> {
	await expectTableCounts(sql, {
		customers: 0,
		provider_customers: 0,
		purchases: 0,
		subscriptions: 0,
		entitlements: 0,
		store_events: 0,
		projection_sync_jobs: 0,
	});
}

async function expectProviderCustomerRow(
	sql: SQL,
	match: {
		billingAccountId: string;
		provider: string;
		externalCustomerId: string;
	},
): Promise<void> {
	const customer = await expectCustomer(sql, match.billingAccountId);
	const rows = await sql<
		{
			billing_account_id: string;
			provider: string;
			external_customer_id: string;
			project_key: string;
		}[]
	>`
		SELECT customers.billing_account_id, provider_customers.provider,
			provider_customers.external_customer_id, projects.key AS project_key
		FROM provider_customers
		JOIN customers ON customers.id = provider_customers.customer_id
			AND customers.project_id = provider_customers.project_id
		JOIN projects ON projects.id = provider_customers.project_id
		WHERE provider_customers.customer_id = ${customer.id}
			AND provider_customers.provider = ${match.provider}
	`;

	expect(rows).toEqual([
		{
			billing_account_id: match.billingAccountId,
			provider: match.provider,
			external_customer_id: match.externalCustomerId,
			project_key: "voysee",
		},
	]);
}

async function expectStripeConsumablePurchaseRows(
	sql: SQL,
	expected: {
		purchaseStatus: "completed" | "refunded";
		creditAmount?: number;
		reversedAmount?: string;
		reversedCreditAmount?: number;
		reversalId?: string | null;
	},
): Promise<void> {
	const rows = await sql<
		{
			billing_account_id: string;
			purchase_status: string;
			purchase_kind: string;
			transaction_id: string;
			original_transaction_id: string | null;
			invalidated_at: string | null;
			invalidation_reason: string | null;
			product_key: string;
			credit_amount: number;
			reversed_amount: string;
			reversed_credit_amount: number;
			reversal_id: string | null;
		}[]
	>`
		SELECT customers.billing_account_id,
			purchases.status AS purchase_status,
			purchases.purchase_kind,
			purchases.transaction_id,
			purchases.original_transaction_id,
			purchases.invalidated_at::text AS invalidated_at,
			purchases.invalidation_reason,
			products.key AS product_key,
			products.credit_amount,
			purchases.reversed_amount::text AS reversed_amount,
			purchases.reversed_credit_amount,
			purchases.raw_payload->'stripeReversal'->>'id' AS reversal_id
		FROM purchases
		JOIN customers ON customers.id = purchases.customer_id
			AND customers.project_id = purchases.project_id
		JOIN products ON products.id = purchases.product_id
			AND products.project_id = purchases.project_id
		JOIN projects ON projects.id = purchases.project_id
		WHERE projects.key = 'voysee'
			AND purchases.provider = 'stripe'
			AND purchases.purchase_kind = 'consumable'
	`;

	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		billing_account_id: "integration_user",
		purchase_status: expected.purchaseStatus,
		purchase_kind: "consumable",
		transaction_id: "pi_integration",
		original_transaction_id: "ch_integration",
		product_key: "echo_credits_10",
		credit_amount: expected.creditAmount ?? 10,
		reversed_amount: expected.reversedAmount ?? "0",
		reversed_credit_amount: expected.reversedCreditAmount ?? 0,
	});
	if (expected.purchaseStatus === "refunded") {
		expect(rows[0].invalidated_at).toEqual(expect.any(String));
		expect(rows[0].invalidation_reason).toBe("refund");
		expect(rows[0].reversal_id).toBe(expected.reversalId ?? "re_integration");
	} else {
		expect(rows[0].invalidated_at).toBeNull();
		expect(rows[0].invalidation_reason).toBeNull();
		expect(rows[0].reversal_id).toBe(expected.reversalId ?? null);
	}
}

async function expectStripeSubscriptionRows(
	sql: SQL,
	expected: {
		subscriptionStatus: string;
		entitlementActive: boolean;
	},
): Promise<void> {
	const rows = await sql<
		{
			billing_account_id: string;
			subscription_status: string;
			external_subscription_id: string;
			external_price_id: string | null;
			entitlement_key: string;
			entitlement_active: boolean;
		}[]
	>`
		SELECT customers.billing_account_id,
			subscriptions.status AS subscription_status,
			subscriptions.external_subscription_id,
			subscriptions.external_price_id,
			entitlements.entitlement_key,
			entitlements.active AS entitlement_active
		FROM subscriptions
		JOIN customers ON customers.id = subscriptions.customer_id
			AND customers.project_id = subscriptions.project_id
		JOIN entitlements ON entitlements.source_subscription_id = subscriptions.id
			AND entitlements.project_id = subscriptions.project_id
		JOIN projects ON projects.id = subscriptions.project_id
		WHERE projects.key = 'voysee'
			AND subscriptions.provider = 'stripe'
	`;

	expect(rows).toEqual([
		{
			billing_account_id: "integration_user",
			subscription_status: expected.subscriptionStatus,
			external_subscription_id: "sub_1",
			external_price_id: "price_premium_monthly",
			entitlement_key: "premium",
			entitlement_active: expected.entitlementActive,
		},
	]);
}

async function expectStripeStoreEventRows(
	sql: SQL,
	expected: {
		eventType: string;
		externalEventId: string;
		transactionId: string;
		purchaseKind: string;
	},
): Promise<void> {
	const rows = await sql<
		{
			external_event_id: string | null;
			event_type: string;
			transaction_id: string | null;
			purchase_kind: string | null;
			processing_status: string;
		}[]
	>`
		SELECT store_events.external_event_id,
			store_events.event_type,
			store_events.transaction_id,
			store_events.purchase_kind,
			store_events.processing_status
		FROM store_events
		JOIN projects ON projects.id = store_events.project_id
		WHERE projects.key = 'voysee'
			AND store_events.provider = 'stripe'
			AND store_events.external_event_id = ${expected.externalEventId}
	`;

	expect(rows).toEqual([
		{
			external_event_id: expected.externalEventId,
			event_type: expected.eventType,
			transaction_id: expected.transactionId,
			purchase_kind: expected.purchaseKind,
			processing_status: "processed",
		},
	]);
}

interface ProjectionJobByKeyRow {
	id: string;
	project_key: string;
	idempotency_key: string;
	reason: ProjectionSyncReason;
	status: ProjectionSyncStatus;
	payload: ProjectionPayload;
}

function stripeOperationReversalInput(
	overrides: Partial<RecordStripeCreditReversalProjectionInput>,
): RecordStripeCreditReversalProjectionInput {
	return {
		reversalReason: "refund",
		reversalId: "re_operation",
		reversalAmount: 1,
		reversalCurrency: "usd",
		paymentIntentId: "pi_operation",
		chargeId: "ch_operation",
		reversedAt: new Date("2026-08-02T00:00:00.000Z"),
		rawPayload: { id: overrides.reversalId ?? "re_operation" },
		eventType: "refund.created",
		externalEventId: "evt_operation_refund",
		projectionIdempotencyKey: "stripe:operation:reversal",
		projectionContract: "billing_state_v1",
		...overrides,
	};
}

async function expectProjectionJobByKey(
	sql: SQL,
	idempotencyKey: string,
): Promise<ProjectionJobByKeyRow> {
	const rows = await sql<ProjectionJobByKeyRow[]>`
		SELECT jobs.id, projects.key AS project_key, jobs.idempotency_key, jobs.reason,
			jobs.status, jobs.payload
		FROM projection_sync_jobs jobs
		JOIN projects ON projects.id = jobs.project_id
		WHERE projects.key = 'voysee'
			AND jobs.idempotency_key = ${idempotencyKey}
	`;

	expect(rows).toHaveLength(1);
	return rows[0];
}

// Pass-through: the repository now serializes all Date SQL params as ISO (src/db/repository.ts),
// so the integration suite exercises the real serialization instead of patching Date.
async function withIsoDateSqlParameters<T>(callback: () => T | Promise<T>): Promise<T> {
	return await callback();
}

/** One extra Stripe subscription on the same customer, priced by an add-on plan version. */
async function seedActiveAddOnSubscription(
	sql: SQL,
	baseSubscriptionId: string,
	addOnSubscriptionId: string,
): Promise<void> {
	await sql`
		WITH base AS (
			SELECT subscription.*, project.id AS pid, revision.id AS revision_id
			FROM subscriptions subscription
			JOIN projects project ON project.id = subscription.project_id
			JOIN catalog_revisions revision ON revision.project_id = project.id AND revision.revision = 1
			WHERE subscription.external_subscription_id = ${baseSubscriptionId}
		), plan AS (
			INSERT INTO plans (project_id, key, name)
			SELECT pid, 'migration-addon', 'Migration add-on' FROM base
			RETURNING id, project_id
		), version AS (
			INSERT INTO plan_versions (
				project_id, plan_id, catalog_revision_id, version, status, currency,
				base_amount_minor, billing_interval, plan_kind, tier_rank
			)
			SELECT plan.project_id, plan.id, base.revision_id, 1, 'published', 'USD', 500, 'month',
				'addon', 10
			FROM plan, base
			RETURNING id, project_id, plan_id
		)
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, current_period_start, current_period_end, auto_renew,
			plan_version_id, catalog_revision_id
		)
		SELECT base.project_id, base.customer_id, base.product_id, base.store_product_id,
			'stripe', 'web', ${addOnSubscriptionId}, base.external_product_id, base.external_price_id,
			'active', base.starts_at, base.current_period_start, base.current_period_end, true,
			version.id, base.revision_id
		FROM base, version
	`;
}
