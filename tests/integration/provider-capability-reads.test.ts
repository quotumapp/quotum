import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type { RuntimeConnectionResolver } from "../../src/projects/connections";
import type {
	BillingAccountAvailableActions,
	ProviderEnvironmentCapabilities,
	SubscriptionPendingChange,
} from "../../src/providers/capability-read-types";
import { createProviderCapabilityReads } from "../../src/providers/capability-reads";
import { createProviderRegistry } from "../../src/providers/registry";
import type { RuntimeCapabilityVerdict } from "../../src/shared/provider-capabilities";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";
import { integrationProjectCredential } from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const account = "migration-stripe";
let context: LocalPostgresContext;

localDescribe("Provider capability reads integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("lists live subscriptions with their pending change and never calls a provider", async () => {
		const { pending, processing } = await seedAccountSubscriptions();
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });

		const response = await testRequest(
			fixture.app,
			`/v1/billing-accounts/${account}/available-actions`,
			{ headers: fixture.authHeaders() },
		);
		const capabilities = await testRequest(fixture.app, "/v1/admin/providers/capabilities", {
			headers: fixture.authHeaders(),
		});

		expect(response.status).toBe(200);
		const data = ((await response.json()) as { data: BillingAccountAvailableActions }).data;
		expect(data).toMatchObject({ billingAccountId: account, customerExists: true });
		// Expired, refunded or revoked rows and rows past expires_at are not live.
		expect(data.subscriptions.map((entry) => [entry.id, entry.status])).toEqual([
			["sub_migrate_stripe", "active"],
			["sub_actions_grace", "grace_period"],
			["sub_actions_retry", "billing_retry"],
			["sub_actions_cancelled", "cancelled"],
		]);
		const subscription = (id: string) => data.subscriptions.find((entry) => entry.id === id);
		expect(subscription("sub_migrate_stripe")).toMatchObject({
			provider: "stripe",
			channel: "web",
			planKey: "migration-plan",
			currentPeriodEnd: pending.effectiveAt,
			cancelAtPeriodEnd: false,
			pendingChange: pending,
		});
		// A change being applied is reported too; applied and cancelled changes are not.
		expect(subscription("sub_actions_grace")?.pendingChange).toEqual(processing);
		expect(subscription("sub_actions_retry")?.pendingChange).toBeNull();
		expect(subscription("sub_actions_cancelled")).toMatchObject({
			cancelAtPeriodEnd: true,
			pendingChange: null,
		});
		for (const entry of data.subscriptions) {
			// Uncancelling needs a pending cancellation, which only the cancelled subscription has.
			expect(entry.actions.map((action) => [action.operation, action.outcome])).toEqual([
				["subscription.change.preview", "available"],
				["subscription.change.apply", "available"],
				["subscription.change.period_end", "available"],
				["subscription.cancel", "available"],
				["subscription.uncancel", entry.cancelAtPeriodEnd ? "available" : "blocked"],
			]);
		}
		expect(outcome(data.account, "stripe", "checkout.hosted")).toBe("available");
		expect(outcome(data.account, "stripe", "topup.automatic")).toBe("undetermined");

		expect(capabilities.status).toBe(200);
		const environment = ((await capabilities.json()) as { data: ProviderEnvironmentCapabilities })
			.data;
		// Project services replace the connection build, so every provider reads as configured.
		expect(environment.providers.map((entry) => [entry.provider, entry.connection])).toEqual(
			(["apple", "google", "stripe"] as const).map((provider) => [
				provider,
				{
					configured: true,
					enabled: true,
					validated: true,
					validatedAt: null,
					accountIdentity: null,
				},
			]),
		);

		expect(fixture.apple.calls).toEqual([]);
		expect(fixture.google.calls).toEqual([]);
		expect(fixture.stripe.calls).toEqual([]);
	});

	it("reports an unknown billing account without creating a customer", async () => {
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });

		const response = await testRequest(
			fixture.app,
			"/v1/billing-accounts/unknown-actions-account/available-actions",
			{ headers: fixture.authHeaders() },
		);

		expect(response.status).toBe(200);
		const data = ((await response.json()) as { data: BillingAccountAvailableActions }).data;
		expect(data).toMatchObject({
			billingAccountId: "unknown-actions-account",
			customerExists: false,
			subscriptions: [],
		});
		expect(data.account.length).toBeGreaterThan(0);
		const customers = await context.sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM customers WHERE billing_account_id = 'unknown-actions-account'
		`;
		expect(customers[0]?.count).toBe(0);
	});

	it("scopes subscriptions to the calling project", async () => {
		await seedAccountSubscriptions();
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, ${account} FROM projects WHERE key = 'wiseley'
		`;
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });

		const response = await testRequest(
			fixture.app,
			`/v1/billing-accounts/${account}/available-actions`,
			{ headers: fixture.authHeaders("wiseley") },
		);

		expect(response.status).toBe(200);
		const data = ((await response.json()) as { data: BillingAccountAvailableActions }).data;
		expect(data).toMatchObject({ customerExists: true, subscriptions: [] });
	});

	it("reads persisted connection state through the runtime wiring without resolving one", async () => {
		await seedAccountSubscriptions();
		let resolved = 0;
		const connections: RuntimeConnectionResolver = {
			async resolve() {
				resolved += 1;
				throw new Error("capability reads must not resolve connections");
			},
			async describe(_project, kind) {
				if (kind === "google") return null;
				return {
					enabled: kind === "stripe",
					active: true,
					validated: true,
					validatedAt: "2026-09-18T10:00:00.000Z",
					accountIdentity: kind === "stripe" ? "acct_1CapabilityReads" : null,
					settings: {},
				};
			},
		};
		const registry = createProviderRegistry({
			connections,
			getRepository: () => context.repository,
		});
		// As in src/runtime.ts: one read service over the shared registry and billing repository.
		const app = withOpenApiAssertions(
			createApp({
				env: context.env,
				projectContextResolver: context.projectContextResolver,
				providerRegistry: registry,
				providerCapabilityReads: createProviderCapabilityReads({
					registry,
					facts: context.repository,
				}),
			}),
		);
		const headers = { authorization: `Bearer ${integrationProjectCredential()}` };

		const capabilities = await testRequest(app, "/v1/admin/providers/capabilities", { headers });
		const actions = await testRequest(app, `/v1/billing-accounts/${account}/available-actions`, {
			headers,
		});

		expect(capabilities.status).toBe(200);
		expect(actions.status).toBe(200);
		const environment = ((await capabilities.json()) as { data: ProviderEnvironmentCapabilities })
			.data;
		expect(environment.providers.map((entry) => entry.connection)).toEqual([
			{
				configured: true,
				enabled: false,
				validated: true,
				validatedAt: "2026-09-18T10:00:00.000Z",
				accountIdentity: null,
			},
			{
				configured: false,
				enabled: false,
				validated: false,
				validatedAt: null,
				accountIdentity: null,
			},
			{
				configured: true,
				enabled: true,
				validated: true,
				validatedAt: "2026-09-18T10:00:00.000Z",
				accountIdentity: "acct_1CapabilityReads",
			},
		]);
		const data = ((await actions.json()) as { data: BillingAccountAvailableActions }).data;
		expect(data.subscriptions.map((entry) => entry.id)).toEqual([
			"sub_migrate_stripe",
			"sub_actions_grace",
			"sub_actions_retry",
			"sub_actions_cancelled",
		]);
		const apple = data.account.find(
			(entry) => entry.provider === "apple" && entry.operation === "purchase.verify",
		);
		expect(apple?.reasons.map((reason) => reason.code)).toEqual(["CONNECTION_DISABLED"]);
		expect(outcome(data.account, "stripe", "checkout.plan")).toBe("available");
		expect(resolved).toBe(0);
	});
});

function outcome(
	verdicts: readonly RuntimeCapabilityVerdict[],
	provider: RuntimeCapabilityVerdict["provider"],
	operation: RuntimeCapabilityVerdict["operation"],
): RuntimeCapabilityVerdict["outcome"] | undefined {
	return verdicts.find((entry) => entry.provider === provider && entry.operation === operation)
		?.outcome;
}

/**
 * Adds grace-period, billing-retry, cancelled, expired, lapsed, revoked and refunded copies of
 * `sub_migrate_stripe` to its account, a pending and an applied change on the original, a
 * processing change on the grace-period copy and a cancelled change on the cancelled copy.
 * Returns the pending and processing changes as the read reports them.
 */
async function seedAccountSubscriptions(): Promise<{
	pending: SubscriptionPendingChange;
	processing: SubscriptionPendingChange;
}> {
	await context.sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end, auto_renew,
			cancel_at_period_end, plan_version_id, catalog_revision_id, created_at
		)
		SELECT source.project_id, source.customer_id, source.product_id, source.store_product_id,
			source.provider, source.channel, variant.external_subscription_id,
			source.external_product_id, source.external_price_id, variant.status, source.starts_at,
			variant.expires_at, source.current_period_start, source.current_period_end, false,
			variant.cancel_at_period_end, source.plan_version_id, source.catalog_revision_id,
			now() - variant.age
		FROM subscriptions source
		JOIN projects project ON project.id = source.project_id AND project.key = 'voysee'
		CROSS JOIN (VALUES
			('sub_actions_grace', 'grace_period', now() + interval '10 days', false, interval '20 minutes'),
			('sub_actions_retry', 'billing_retry', now() + interval '10 days', false, interval '40 minutes'),
			('sub_actions_cancelled', 'cancelled', now() + interval '10 days', true, interval '1 hour'),
			('sub_actions_expired', 'expired', now() - interval '1 day', false, interval '2 hours'),
			('sub_actions_lapsed', 'active', now() - interval '1 minute', false, interval '3 hours'),
			('sub_actions_revoked', 'revoked', NULL, false, interval '4 hours'),
			('sub_actions_refunded', 'refunded', now() + interval '10 days', false, interval '5 hours')
		) AS variant(external_subscription_id, status, expires_at, cancel_at_period_end, age)
		WHERE source.external_subscription_id = 'sub_migrate_stripe'
	`;
	const changes = await context.sql<{ id: string; status: string; effective_at: Date }[]>`
		INSERT INTO subscription_changes (
			project_id, customer_id, subscription_id, provider, provider_account_id,
			from_plan_version_id, to_plan_version_id, change_kind, effective_mode, effective_at,
			proration_behavior, status, applied_at, idempotency_key, request_hash
		)
		SELECT subscription.project_id, subscription.customer_id, subscription.id,
			subscription.provider, subscription.provider_account_id, from_version.id, to_version.id,
			'upgrade', 'period_end', subscription.current_period_end, 'none', variant.status,
			variant.applied_at, concat('actions:', variant.status), repeat('c', 64)
		FROM subscriptions subscription
		JOIN projects project ON project.id = subscription.project_id AND project.key = 'voysee'
		JOIN plans plan ON plan.project_id = project.id AND plan.key = 'migration-plan'
		JOIN plan_versions from_version
			ON from_version.project_id = plan.project_id AND from_version.plan_id = plan.id
			AND from_version.version = 1
		JOIN plan_versions to_version
			ON to_version.project_id = plan.project_id AND to_version.plan_id = plan.id
			AND to_version.version = 2
		JOIN (VALUES
			('sub_migrate_stripe', 'pending', NULL::timestamptz),
			('sub_migrate_stripe', 'applied', now()),
			('sub_actions_grace', 'processing', NULL),
			('sub_actions_cancelled', 'cancelled', NULL)
		) AS variant(external_subscription_id, status, applied_at)
			ON variant.external_subscription_id = subscription.external_subscription_id
		RETURNING id, status, effective_at
	`;
	expect(changes).toHaveLength(4);
	const reported = (status: "pending" | "processing"): SubscriptionPendingChange => {
		const change = changes.find((entry) => entry.status === status);
		if (change === undefined) throw new Error(`The ${status} change was not seeded`);
		return {
			changeId: change.id,
			status,
			effectiveMode: "period_end",
			effectiveAt: new Date(change.effective_at).toISOString(),
		};
	};
	return { pending: reported("pending"), processing: reported("processing") };
}
