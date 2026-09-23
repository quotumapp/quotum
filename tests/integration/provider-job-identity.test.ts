import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../../src/app";
import { EntitlementService } from "../../src/billing/entitlements";
import { MeteringService } from "../../src/billing/metering";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../../src/billing/recurring";
import type { BillingProvider } from "../../src/billing/types";
import { createWorkerProviderSelectors } from "../../src/composition/worker-providers";
import type { ClaimedUsageInvoiceJob } from "../../src/db/repository";
import type { StripeBillingEnv } from "../../src/env";
import type { RuntimeConnectionResolver } from "../../src/projects/connections";
import { createProviderRegistry } from "../../src/providers/registry";
import {
	RecurringBillingWorker,
	type RecurringBillingWorkerAdapter,
} from "../../src/workers/recurring-billing";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createFakeStripeBillingClient,
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeSubscriptionObject,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	linkStripeCustomer,
	seedPhase3CatalogMigration,
	seedPhase3ControlCatalog,
} from "./helpers/phase3-fixtures";
import { integrationProjectCredential } from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const identities = ["acct_1IdentityDurable", null] as const;
let context: LocalPostgresContext;

interface IdentityRow {
	provider: BillingProvider;
	provider_account_id: string | null;
}

localDescribe("Provider job identity integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("claims immediate changes with a skewed host clock while preserving period-end previews", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		const input = {
			billingAccountId: "migration-stripe",
			externalSubscriptionId: "sub_migrate_stripe",
			targetPlanKey: "migration-plan",
			quantities: { licensed_seats: 7 },
		};
		const preview = await context.repository.previewSubscriptionChange(project, input);
		setSystemTime(new Date(Date.now() + 60_000));
		try {
			const repeated = await context.repository.previewSubscriptionChange(project, input);
			expect(repeated.stateFingerprint).toBe(preview.stateFingerprint);
			const periodEnd = await context.repository.previewSubscriptionChange(project, {
				...input,
				effectiveMode: "period_end",
			});
			const [subscription] = await context.sql<{ current_period_end: Date }[]>`
				SELECT current_period_end FROM subscriptions
				WHERE project_id=${project.projectInstanceId} AND external_subscription_id='sub_migrate_stripe'
			`;
			expect(periodEnd.effectiveAt).toBe(subscription?.current_period_end.toISOString());
			const change = await context.repository.prepareSubscriptionChange(project, {
				...input,
				idempotencyKey: "skewed-immediate-change",
				expectedStateFingerprint: preview.stateFingerprint,
			});
			const [clock] = await context.sql<{ now: Date }[]>`SELECT now() AS now`;
			expect(
				new Date(change.effectiveAt).getTime(),
				`effectiveAt=${change.effectiveAt}, database=${clock?.now.toISOString()}, host=${new Date().toISOString()}`,
			).toBeLessThanOrEqual(clock?.now.getTime() ?? 0);
			expect(await context.repository.claimSubscriptionChanges("skewed-clock-worker", 25)).toEqual([
				expect.objectContaining({ changeId: change.changeId }),
			]);
		} finally {
			setSystemTime();
		}
	});

	for (const identity of identities) {
		const label = identity === null ? "without" : "with";

		it(`stores the connection identity on Checkout requests and new customers ${label} one`, async () => {
			const fixture = identityApp(identity);

			const response = await testRequest(
				fixture.app,
				"/v1/billing-accounts/identity_checkout/providers/stripe/checkout-sessions",
				{
					method: "POST",
					headers: {
						...authHeaders(),
						"content-type": "application/json",
						"idempotency-key": "identity-checkout",
					},
					body: JSON.stringify({ productKey: "echo_credits_10" }),
				},
			);

			expect(response.status).toBe(200);
			expect(await identityRows(context.sql, "checkout_requests")).toEqual([
				{ provider: "stripe", provider_account_id: identity },
			]);
			expect(await identityRows(context.sql, "provider_customers")).toEqual([
				{ provider: "stripe", provider_account_id: identity },
			]);
		});

		it(`stores the connection identity on customers created by credit purchase webhooks ${label} one`, async () => {
			const deliver = async (accountIdentity: string | null, suffix: string) => {
				const eventId = `evt_identity_credit_${suffix}`;
				const paymentIntentId = `pi_identity_credit_${suffix}`;
				const session = stripeCheckoutSessionObject({
					id: `cs_identity_credit_${suffix}`,
					charge: `ch_${paymentIntentId}`,
					latest_charge: `ch_${paymentIntentId}`,
					payment_intent: {
						id: paymentIntentId,
						latest_charge: `ch_${paymentIntentId}`,
						metadata: { billingAccountId: "integration_user" },
					},
				});
				const fixture = identityApp(accountIdentity, {
					event: stripeEvent("checkout.session.completed", session, eventId),
				});
				const response = await testRequest(fixture.app, "/v1/projects/voysee/webhooks/stripe", {
					method: "POST",
					headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
					body: JSON.stringify({
						id: eventId,
						type: "checkout.session.completed",
						data: { object: {} },
					}),
				});
				expect(response.status).toBe(200);
				expect((await response.json()).data.status).toBe("processed");
				return await identityRows(context.sql, "provider_customers");
			};

			expect(await deliver(identity, "first")).toEqual([
				{ provider: "stripe", provider_account_id: identity },
			]);
			// A later purchase fills a missing identity but never overwrites a stored one.
			expect(await deliver("acct_1IdentityCreditLater", "second")).toEqual([
				{ provider: "stripe", provider_account_id: identity ?? "acct_1IdentityCreditLater" },
			]);
		});

		it(`copies the subscription identity onto a requested change and its claim ${label} one`, async () => {
			await seedPhase3ControlCatalog(context.sql);
			await seedPhase3CatalogMigration(context.sql);
			await setSubscriptionIdentity(context.sql, "sub_migrate_stripe", identity);
			// The live connection reports another account: jobs must keep the subscription's identity.
			const fixture = identityApp("acct_1IdentityLiveConnection");

			const response = await testRequest(
				fixture.app,
				"/v1/billing-accounts/migration-stripe/subscriptions/sub_migrate_stripe/changes",
				{
					method: "POST",
					headers: {
						...authHeaders(),
						"content-type": "application/json",
						"idempotency-key": "identity-change",
					},
					body: JSON.stringify({
						targetPlanKey: "migration-plan",
						quantities: { licensed_seats: 7 },
					}),
				},
			);

			expect(response.status).toBe(202);
			const change = (await response.json()).data;
			expect(change).toMatchObject({ status: "pending", effectiveMode: "immediate" });
			expect(change).not.toHaveProperty("provider");
			expect(change).not.toHaveProperty("providerAccountId");
			expect(await identityRows(context.sql, "subscription_changes")).toEqual([
				{ provider: "stripe", provider_account_id: identity },
			]);
			// The claim must return the identity the change stored, not the subscription's current one.
			await setSubscriptionIdentity(context.sql, "sub_migrate_stripe", "acct_1IdentityLater");

			const selectors = createWorkerProviderSelectors(fixture.registry);
			const selected: BillingProvider[] = [];
			const applied: Array<
				Pick<SubscriptionChangeOperation, "changeId" | "provider" | "providerAccountId">
			> = [];
			const worker = new RecurringBillingWorker({
				projectContextResolver: context.projectContextResolver,
				workerId: "identity-change-worker",
				repository: context.repository,
				async adapterForJob(jobProject, provider) {
					selected.push(provider);
					return recordingChanges(
						await selectors.recurringBilling(jobProject, provider),
						(operation) =>
							applied.push({
								changeId: operation.changeId,
								provider: operation.provider,
								providerAccountId: operation.providerAccountId,
							}),
					);
				},
				logger: {
					error(_message, error) {
						throw error;
					},
				},
			});

			expect(await worker.runOnce()).toMatchObject({ subscriptionChangesApplied: 1, failed: 0 });
			expect(selected).toEqual(["stripe"]);
			expect(applied).toEqual([
				{ changeId: change.changeId, provider: "stripe", providerAccountId: identity },
			]);
			expect(fixture.stripe.subscriptionUpdates).toHaveLength(1);
		});

		it(`copies the subscription identity onto staged catalog migration changes ${label} one`, async () => {
			await seedPhase3ControlCatalog(context.sql);
			await seedPhase3CatalogMigration(context.sql);
			await setSubscriptionIdentity(context.sql, "sub_migrate_stripe", identity);
			const fixture = identityApp("acct_1IdentityLiveConnection");
			const operator = {
				...authHeaders(),
				"content-type": "application/json",
				"x-billing-actor": "identity-test",
				"x-billing-operator-key": "billing-integration-operator-key",
			};
			const intent = {
				fromPlanKey: "migration-plan",
				fromVersion: 1,
				toPlanKey: "migration-plan",
				toVersion: 2,
				effectiveMode: "immediate",
			};

			const preview = await testRequest(fixture.app, "/v1/admin/catalog-migrations/preview", {
				method: "POST",
				headers: operator,
				body: JSON.stringify(intent),
			});
			expect(preview.status).toBe(200);
			const { previewToken } = (await preview.json()).data;
			const publish = await testRequest(fixture.app, "/v1/admin/catalog-migrations/publish", {
				method: "POST",
				headers: operator,
				body: JSON.stringify({ ...intent, previewToken }),
			});
			expect(publish.status).toBe(200);

			const claimed = await context.repository.claimSubscriptionChanges("identity-migration", 10);
			expect(claimed).toHaveLength(1);
			const [claimedChange] = claimed;
			if (claimedChange === undefined) throw new Error("Expected a claimed migration change");
			const change = await context.repository.loadClaimedSubscriptionChange(
				claimedChange.projectInstanceId,
				claimedChange.changeId,
				"identity-migration",
			);
			expect(change).toMatchObject({
				externalSubscriptionId: "sub_migrate_stripe",
				provider: "stripe",
				providerAccountId: identity,
			});
			expect(await identityRows(context.sql, "subscription_changes")).toEqual([
				{ provider: "stripe", provider_account_id: identity },
			]);
		});

		it(`copies the subscription identity onto usage invoice periods from both materializers ${label} one`, async () => {
			await seedPhase3ControlCatalog(context.sql);
			await seedMeteredOverageSubscriptions(
				context.sql,
				[
					{ billingAccountId: "identity-period", provider: "stripe" },
					{ billingAccountId: "identity-correction", provider: "stripe" },
				],
				identity,
			);
			const periodUsage = await consumeOverage("identity-period");
			const correctedUsage = await consumeOverage("identity-correction");
			expect(periodUsage).toMatchObject({ allowed: true });
			expect(correctedUsage).toMatchObject({ allowed: true });
			await closeUsageWindows(context.sql);

			if (correctedUsage.usageEventId === null || correctedUsage.recordedAt === null) {
				throw new Error("Expected an accepted usage event to correct");
			}
			await context.repository.correctUsage(project, {
				billingAccountId: "identity-correction",
				originalUsageEventId: correctedUsage.usageEventId,
				originalRecordedAt: new Date(correctedUsage.recordedAt),
				quantity: "100",
				reason: "identity correction",
				actor: "identity-test",
				idempotencyKey: "identity-correction:correct",
			});
			// The correction closed its period before the worker's materializer ran.
			expect(await periodIdentityRows(context.sql)).toEqual([
				{ account: "identity-correction", provider: "stripe", provider_account_id: identity },
			]);
			// Claims of the stored period and its adjustment must keep the identity the period stored.
			await setSubscriptionIdentity(context.sql, "sub_identity-correction", "acct_1IdentityLater");

			const workerId = "identity-usage-worker";
			const claim = await context.repository.materializeAndClaimUsageInvoicePeriods(workerId, 10);
			expect(claim.materialized).toBe(1);
			expect(await periodIdentityRows(context.sql)).toEqual([
				{ account: "identity-correction", provider: "stripe", provider_account_id: identity },
				{ account: "identity-period", provider: "stripe", provider_account_id: identity },
			]);
			const jobs = await loadClaimedUsageJobs(claim.jobs, workerId);
			expect(jobIdentities(jobs)).toEqual([
				{ jobKind: "period", account: "identity-correction", identity: ["stripe", identity] },
				{ jobKind: "period", account: "identity-period", identity: ["stripe", identity] },
			]);

			for (const job of jobs) {
				await context.repository.markUsageInvoiceSucceeded(
					project.projectInstanceId,
					job.jobKind,
					job.jobId,
					`in_${job.billingAccountId}`,
					workerId,
				);
			}
			// The adjustment keeps no identity of its own; its claim reads the closed period's.
			const adjustments = await context.repository.materializeAndClaimUsageInvoicePeriods(
				workerId,
				10,
			);
			expect(jobIdentities(await loadClaimedUsageJobs(adjustments.jobs, workerId))).toEqual([
				{ jobKind: "adjustment", account: "identity-correction", identity: ["stripe", identity] },
			]);
		});

		it(`copies the provider customer identity onto auto top-up jobs ${label} one`, async () => {
			await seedPhase3ControlCatalog(context.sql);
			const account = "identity-topup";
			await context.repository.grantAllocation(project, {
				billingAccountId: account,
				featureKey: "ai_credits",
				quantity: "10",
				sourceKind: "operator",
				sourceKey: "fixture:identity-topup",
			});
			await linkStripeCustomer(context.sql, account, "cus_identity_topup");
			await context.sql`
				UPDATE provider_customers SET provider_account_id = ${identity}
				WHERE project_id = ${project.projectInstanceId}::uuid
					AND external_customer_id = 'cus_identity_topup'
			`;
			await context.repository.controlsEnterprise.upsertAutoTopupPolicy(project, {
				billingAccountId: account,
				featureKey: "ai_credits",
				topupKey: "credits_10",
				provider: "stripe",
				thresholdQuantity: "5",
				cooldownSeconds: 30,
				limitIntervalSeconds: 86_400,
				maxPurchasesPerInterval: 2,
				maxSpendMinor: 1_000,
				maxConsecutiveFailures: 3,
				actor: "identity-test",
			});

			const usage = await context.repository.consumeUsage(project, {
				billingAccountId: account,
				featureKey: "ai_credits",
				quantity: "6",
				idempotencyKey: "identity-topup:trigger",
			});

			expect(usage.allowed).toBe(true);
			expect(await identityRows(context.sql, "auto_topup_jobs")).toEqual([
				{ provider: "stripe", provider_account_id: identity },
			]);
			// The claim must return the identity the job stored, not the provider customer's current one.
			await context.sql`
				UPDATE provider_customers SET provider_account_id = 'acct_1IdentityLater'
				WHERE project_id = ${project.projectInstanceId}::uuid
					AND external_customer_id = 'cus_identity_topup'
			`;
			const claimed = await context.repository.claimAutoTopupJobs(
				"identity-topup-worker",
				10,
				new Date(Date.now() - 300_000),
			);
			expect(claimed).toHaveLength(1);
			expect(claimed[0]).toMatchObject({
				billingAccountId: account,
				provider: "stripe",
				providerAccountId: identity,
			});
		});
	}

	it("fails a usage period stored for another provider on its own instead of stalling the claim", async () => {
		await seedPhase3ControlCatalog(context.sql);
		// The Apple subscriber also has a Stripe customer, so its period builds a job.
		await seedMeteredOverageSubscriptions(
			context.sql,
			[
				{ billingAccountId: "identity-apple", provider: "apple" },
				{ billingAccountId: "identity-stripe", provider: "stripe" },
			],
			null,
		);
		expect(await consumeOverage("identity-apple")).toMatchObject({ allowed: true });
		expect(await consumeOverage("identity-stripe")).toMatchObject({ allowed: true });
		await closeUsageWindows(context.sql);
		const selectors = createWorkerProviderSelectors(identityApp(null).registry);
		const failures: string[] = [];
		const worker = new RecurringBillingWorker({
			projectContextResolver: context.projectContextResolver,
			workerId: "identity-apple-usage-worker",
			repository: context.repository,
			adapterForJob: (jobProject, provider) => selectors.recurringBilling(jobProject, provider),
			logger: {
				error(_message, error) {
					failures.push(error instanceof Error ? error.message : String(error));
				},
			},
		});

		expect(await worker.runOnce()).toMatchObject({
			materializedUsagePeriods: 2,
			usageInvoicesCreated: 1,
			failed: 1,
		});
		expect(failures).toEqual([
			`Apple StoreKit is not configured for ${project.projectInstanceKey}`,
		]);
		expect(
			await context.sql<Array<{ account: string; provider: BillingProvider; status: string }>>`
				SELECT customer.billing_account_id AS account, period.provider, period.status
				FROM usage_invoice_periods period
				JOIN customers customer
					ON customer.project_id = period.project_id AND customer.id = period.customer_id
				WHERE period.project_id = ${project.projectInstanceId}::uuid
				ORDER BY account
			`,
		).toEqual([
			{ account: "identity-apple", provider: "apple", status: "pending" },
			{ account: "identity-stripe", provider: "stripe", status: "invoiced" },
		]);
	});

	it("fills a missing subscription identity from webhooks and never overwrites a stored one", async () => {
		const deliver = async (accountIdentity: string | null, type: string, eventId: string) => {
			const fixture = identityApp(accountIdentity, {
				event: stripeEvent(type, stripeSubscriptionObject(), eventId),
			});
			const response = await testRequest(fixture.app, "/v1/projects/voysee/webhooks/stripe", {
				method: "POST",
				headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
				body: JSON.stringify({ id: eventId, type, data: { object: {} } }),
			});
			expect(response.status).toBe(200);
			expect((await response.json()).data.status).toBe("processed");
			return {
				subscriptions: await identityRows(context.sql, "subscriptions"),
				customers: await identityRows(context.sql, "provider_customers"),
			};
		};
		const stored = (providerAccountId: string | null): IdentityRow[] => [
			{ provider: "stripe", provider_account_id: providerAccountId },
		];

		expect(await deliver(null, "customer.subscription.created", "evt_identity_created")).toEqual({
			subscriptions: stored(null),
			customers: stored(null),
		});
		expect(
			await deliver("acct_1IdentityFirst", "customer.subscription.updated", "evt_identity_first"),
		).toEqual({
			subscriptions: stored("acct_1IdentityFirst"),
			customers: stored("acct_1IdentityFirst"),
		});
		expect(
			await deliver("acct_1IdentitySecond", "customer.subscription.updated", "evt_identity_second"),
		).toEqual({
			subscriptions: stored("acct_1IdentityFirst"),
			customers: stored("acct_1IdentityFirst"),
		});
	});
});

const stripeConnection: StripeBillingEnv = {
	secretKey: "sk_test_provider_job_identity",
	webhookSecret: "whsec_provider_job_identity",
	checkoutSuccessUrl:
		"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://app.integration.test/billing",
	portalReturnUrl: "https://app.integration.test/account/billing",
	taxMode: "disabled",
};

/** The runtime wiring: one registry over a Stripe connection that reports `accountIdentity`. */
function identityApp(
	accountIdentity: string | null,
	options: { event?: ReturnType<typeof stripeEvent> } = {},
) {
	const stripe = createFakeStripeBillingClient({ event: options.event });
	const connections = {
		async resolve(candidate, kind) {
			if (kind !== "stripe" || candidate.projectInstanceKey !== project.projectInstanceKey) {
				return null;
			}
			return { ...stripeConnection, accountIdentity };
		},
	} as RuntimeConnectionResolver;
	const registry = createProviderRegistry({
		connections,
		getRepository: () => context.repository,
		clientFactories: { stripe: () => stripe.client },
	});
	const app = withOpenApiAssertions(
		createApp({
			env: context.env,
			entitlementService: new EntitlementService(context.repository),
			meteringService: new MeteringService(context.repository),
			controlsEnterpriseService: context.repository.controlsEnterprise,
			promotionService: context.repository.promotions,
			catalogControlPlane: {
				getPublished: (...args) => context.repository.getPublishedCatalog(...args),
				preview: (...args) => context.repository.previewCatalog(...args),
				publish: (...args) => context.repository.publishCatalog(...args),
			},
			providerRegistry: registry,
		}),
	);
	return { app, registry, stripe };
}

async function loadClaimedUsageJobs(
	claimed: readonly ClaimedUsageInvoiceJob[],
	workerId: string,
): Promise<UsageInvoiceJob[]> {
	const jobs: UsageInvoiceJob[] = [];
	for (const job of claimed) {
		const loaded = await context.repository.loadClaimedUsageInvoiceJob(
			job.projectInstanceId,
			job.jobKind,
			job.jobId,
			workerId,
		);
		if (loaded === null) throw new Error(`Expected to load claimed ${job.jobKind} ${job.jobId}`);
		jobs.push(loaded);
	}
	return jobs;
}

function jobIdentities(jobs: readonly UsageInvoiceJob[]) {
	return jobs
		.map((job) => ({
			jobKind: job.jobKind,
			account: job.billingAccountId,
			identity: [job.provider, job.providerAccountId],
		}))
		.sort((left, right) => left.account.localeCompare(right.account));
}

function authHeaders(): Record<string, string> {
	return { authorization: `Bearer ${integrationProjectCredential()}` };
}

function recordingChanges(
	adapter: RecurringBillingWorkerAdapter,
	record: (operation: SubscriptionChangeOperation) => void,
): RecurringBillingWorkerAdapter {
	const changes = adapter.changes;
	if (changes === undefined) throw new Error("Expected the Stripe adapter to apply changes");
	return {
		settlement: adapter.settlement,
		changes: {
			apply(operation) {
				record(operation);
				return changes.apply(operation);
			},
		},
	};
}

async function identityRows(
	sql: SQL,
	table:
		| "checkout_requests"
		| "provider_customers"
		| "subscriptions"
		| "subscription_changes"
		| "auto_topup_jobs",
): Promise<IdentityRow[]> {
	// The table name comes from the fixed union above, never from input.
	return await sql.unsafe<IdentityRow[]>(
		`SELECT provider, provider_account_id FROM ${table}
		WHERE project_id = $1::uuid
		ORDER BY created_at, provider_account_id`,
		[project.projectInstanceId],
	);
}

async function periodIdentityRows(sql: SQL) {
	return await sql<Array<IdentityRow & { account: string }>>`
		SELECT customer.billing_account_id AS account, period.provider, period.provider_account_id
		FROM usage_invoice_periods period
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE period.project_id = ${project.projectInstanceId}::uuid
		ORDER BY account
	`;
}

async function setSubscriptionIdentity(
	sql: SQL,
	externalSubscriptionId: string,
	providerAccountId: string | null,
): Promise<void> {
	await sql`
		UPDATE subscriptions SET provider_account_id = ${providerAccountId}
		WHERE project_id = ${project.projectInstanceId}::uuid
			AND external_subscription_id = ${externalSubscriptionId}
	`;
}

async function consumeOverage(billingAccountId: string) {
	return await context.repository.consumeUsage(project, {
		billingAccountId,
		featureKey: "api_calls_identity",
		quantity: "275",
		idempotencyKey: `${billingAccountId}:usage`,
	});
}

/**
 * A plan whose meter limit bills postpaid overage through a Stripe web price. Every subscriber has a
 * Stripe customer and subscribes through its provider's store product.
 */
async function seedMeteredOverageSubscriptions(
	sql: SQL,
	subscribers: ReadonlyArray<{ billingAccountId: string; provider: "apple" | "stripe" }>,
	providerAccountId: string | null,
): Promise<void> {
	await sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'api_calls_identity', 'API calls', 'metered', 'consumable', 'call', 1
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
			SELECT project_id, 'identity_usage', 'Identity usage' FROM target
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
			JOIN features feature
				ON feature.project_id = version.project_id AND feature.key = 'api_calls_identity'
			RETURNING id, project_id, plan_version_id
		), price AS (
			INSERT INTO price_components (
				project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing,
				currency, unit_amount_minor, billing_units, billing_interval, pricing_model
			)
			SELECT project_id, plan_version_id, id, 'overage', 'metered_overage', 'in_arrears',
				'USD', 5, 10, 'month', 'flat'
			FROM item
			RETURNING id
		)
		SELECT count(*) FROM price
	`;
	await sql`
		UPDATE plans SET active_version_id = version.id
		FROM plan_versions version
		WHERE plans.project_id = version.project_id AND plans.id = version.plan_id
			AND plans.key = 'identity_usage' AND version.version = 1
	`;
	await sql`
		INSERT INTO products (project_id, key, entitlement_key, credit_amount, name, type, active)
		SELECT id, 'identity_usage', 'identity_usage', 0, 'Identity usage', 'subscription', true
		FROM projects WHERE key = 'voysee'
	`;
	await sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id,
			external_price_id, billing_period, currency, price_amount, active
		)
		SELECT project.id, product.id, 'stripe', 'web', 'prod_identity_usage',
			'price_identity_usage', 'month', 'USD', 0, true
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = 'identity_usage'
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id,
			external_price_id, billing_period, currency, price_amount, active
		)
		SELECT project.id, product.id, 'apple', 'ios', 'com.identity.usage.monthly',
			NULL, 'month', 'USD', 0, true
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = 'identity_usage'
		WHERE project.key = 'voysee'
	`;
	await sql`
		INSERT INTO provider_price_bindings (
			project_id, price_component_id, store_product_id, provider, channel, status
		)
		SELECT price.project_id, price.id, store.id, 'stripe', 'web', 'published'
		FROM price_components price
		JOIN plan_versions version
			ON version.project_id = price.project_id AND version.id = price.plan_version_id
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN store_products store ON store.project_id = price.project_id
			AND store.external_price_id = 'price_identity_usage'
		WHERE plan.key = 'identity_usage'
	`;
	for (const { billingAccountId, provider } of subscribers) {
		const channel = provider === "apple" ? "ios" : "web";
		await linkStripeCustomer(sql, billingAccountId, `cus_${billingAccountId.replace("-", "_")}`);
		await sql`
			INSERT INTO subscriptions (
				project_id, customer_id, product_id, store_product_id, provider, channel,
				provider_account_id, external_subscription_id, external_product_id, external_price_id,
				status, starts_at, current_period_start, current_period_end, auto_renew,
				plan_version_id, catalog_revision_id
			)
			SELECT project.id, customer.id, product.id, store.id, ${provider}, ${channel},
				${providerAccountId}, ${`sub_${billingAccountId}`}, store.external_product_id,
				store.external_price_id, 'active', now() - interval '1 day', now() - interval '1 day',
				now() + interval '29 days', true, version.id, version.catalog_revision_id
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
				AND customer.billing_account_id = ${billingAccountId}
			JOIN products product ON product.project_id = project.id AND product.key = 'identity_usage'
			JOIN store_products store ON store.project_id = product.project_id
				AND store.product_id = product.id AND store.provider = ${provider}
			JOIN plans plan ON plan.project_id = project.id AND plan.key = 'identity_usage'
			JOIN plan_versions version
				ON version.project_id = plan.project_id AND version.id = plan.active_version_id
			WHERE project.key = 'voysee'
		`;
	}
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
