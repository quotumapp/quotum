import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { EntitlementSnapshot } from "../../src/billing/types";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectTableCounts } from "./helpers/db-assertions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("customer entitlement route integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("returns empty entitlement snapshots for new customers", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await testRequest(app, "/v1/billing-accounts/new_customer/entitlements", {
			headers: authHeaders("acme"),
		});

		expect(response.status).toBe(200);
		expectEmptySnapshot((await response.json()).data, "new_customer");
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

	it("scopes entitlement reads by the authenticated project when state exists", async () => {
		const { app, apple, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const tokenResponse = await testRequest(
			app,
			"/v1/billing-accounts/shared_user/providers/apple/account-token",
			{
				headers: authHeaders("acme"),
			},
		);

		expect(tokenResponse.status).toBe(200);
		apple.setAppAccountToken((await tokenResponse.json()).data.appAccountToken);

		const verification = await withIsoDateSqlParameters(() =>
			testRequest(app, "/v1/purchases/verify", {
				method: "POST",
				headers: {
					...authHeaders("acme"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "apple",
					billingAccountId: "shared_user",
					transactionId: "200000000000001",
				}),
			}),
		);
		const acme = await testRequest(app, "/v1/billing-accounts/shared_user/entitlements", {
			headers: authHeaders("acme"),
		});
		const globex = await testRequest(app, "/v1/billing-accounts/shared_user/entitlements", {
			headers: authHeaders("globex"),
		});

		expect(verification.status).toBe(200);
		expect(acme.status).toBe(200);
		expect(globex.status).toBe(200);
		expectActivePremiumSnapshot((await acme.json()).data, "shared_user", "apple", "ios");
		expectEmptySnapshot((await globex.json()).data, "shared_user");
		await expectEntitlementProjectRows(context.sql, [
			{ project_key: "acme", entitlement_count: "1", active_count: "1" },
			{ project_key: "globex", entitlement_count: "0", active_count: "0" },
		]);
	});

	it("keeps cancelled subscriptions active until expiry and rejects null-expiry subscription entitlements", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await seedSubscriptionExpiryFixtures(context.sql);

		const recomputed = await context.repository.recomputeCustomerEntitlements(
			integrationProjectContext(),
			"subscription_lifecycle_user",
		);
		const lifecycleResponse = await testRequest(
			app,
			"/v1/billing-accounts/subscription_lifecycle_user/entitlements",
			{
				headers: authHeaders("acme"),
			},
		);
		const legacyResponse = await testRequest(
			app,
			"/v1/billing-accounts/legacy_null_subscription_user/entitlements",
			{
				headers: authHeaders("acme"),
			},
		);

		expect(lifecycleResponse.status).toBe(200);
		expect(legacyResponse.status).toBe(200);
		expect(recomputed.entitlements).toEqual([
			{
				key: "premium",
				active: true,
				expiresAt: expect.any(String),
				metadata: expect.objectContaining({
					source: "subscription",
					status: "cancelled",
					provider: "google",
					channel: "android",
				}),
			},
		]);
		expect((await lifecycleResponse.json()).data.entitlements).toEqual(recomputed.entitlements);
		// The stored row still says its subscription was active; an inactive entry never reads so.
		expect((await legacyResponse.json()).data.entitlements).toEqual([
			{
				key: "premium",
				active: false,
				expiresAt: null,
				metadata: expect.objectContaining({
					source: "subscription",
					status: "inactive",
					provider: "google",
					channel: "android",
				}),
			},
		]);
		await expectTableCounts(context.sql, {
			customers: 2,
			provider_customers: 0,
			purchases: 0,
			subscriptions: 4,
			entitlements: 2,
			store_events: 0,
			projection_sync_jobs: 0,
		});
	});

	it("reports an ended source's status on an inactive entitlement, and inactive while it runs", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const expiring = await seedPremiumSubscription(context.sql, "expiring_user");
		const lapsing = await seedPremiumSubscription(context.sql, "lapsing_user");
		for (const billingAccountId of ["expiring_user", "lapsing_user"]) {
			expect(
				(
					await context.repository.recomputeCustomerEntitlements(
						integrationProjectContext(),
						billingAccountId,
					)
				).entitlements,
			).toMatchObject([{ key: "premium", active: true, metadata: { status: "active" } }]);
		}
		const read = async (billingAccountId: string) => {
			const response = await testRequest(
				app,
				`/v1/billing-accounts/${billingAccountId}/entitlements`,
				{ headers: authHeaders("acme") },
			);
			expect(response.status).toBe(200);
			return ((await response.json()).data as EntitlementSnapshot).entitlements;
		};
		const storedStatus = async (billingAccountId: string) =>
			(
				await context.sql<Array<{ status: string }>>`
					SELECT e.metadata->>'status' AS status
					FROM entitlements e
					JOIN customers c ON c.id = e.customer_id AND c.project_id = e.project_id
					WHERE c.billing_account_id = ${billingAccountId}
				`
			).map((row) => row.status);

		// The provider reports the subscription expired: the entitlement carries its status.
		await context.sql`
			UPDATE subscriptions SET status = 'expired', expires_at = now() - INTERVAL '1 second'
			WHERE id = ${expiring}
		`;
		await context.repository.recomputeCustomerEntitlements(
			integrationProjectContext(),
			"expiring_user",
		);
		expect(await read("expiring_user")).toMatchObject([
			{ key: "premium", active: false, metadata: { source: "subscription", status: "expired" } },
		]);
		expect(await storedStatus("expiring_user")).toEqual(["expired"]);

		// Its period passed before Quotum recorded a lapse: the subscription still says active, so
		// the entitlement reads inactive, before and after a recompute.
		await context.sql`
			UPDATE subscriptions SET expires_at = now() - INTERVAL '1 second' WHERE id = ${lapsing}
		`;
		await context.sql`
			UPDATE entitlements SET expires_at = now() - INTERVAL '1 second'
			WHERE source_subscription_id = ${lapsing}
		`;
		expect(await read("lapsing_user")).toMatchObject([
			{ key: "premium", active: false, metadata: { source: "subscription", status: "inactive" } },
		]);
		await context.repository.recomputeCustomerEntitlements(
			integrationProjectContext(),
			"lapsing_user",
		);
		expect(await read("lapsing_user")).toMatchObject([
			{ key: "premium", active: false, metadata: { status: "inactive" } },
		]);
		expect(await storedStatus("lapsing_user")).toEqual(["inactive"]);

		// A later recompute keeps the recorded status once the source is gone.
		await context.repository.recomputeCustomerEntitlements(
			integrationProjectContext(),
			"expiring_user",
		);
		expect(await storedStatus("expiring_user")).toEqual(["expired"]);
	});
});

/** An active Google premium subscription for a new account, running for another month. */
async function seedPremiumSubscription(sql: SQL, billingAccountId: string): Promise<string> {
	const [row] = await sql<Array<{ id: string }>>`
		WITH catalog AS (
			SELECT projects.id AS project_id, products.id AS product_id, store_products.id AS store_product_id
			FROM projects
			JOIN products ON products.project_id = projects.id
				AND products.key = 'premium_monthly'
			JOIN store_products ON store_products.project_id = projects.id
				AND store_products.product_id = products.id
				AND store_products.provider = 'google'
				AND store_products.external_product_id = 'premium_monthly'
				AND store_products.external_price_id = 'monthly-base'
			WHERE projects.key = 'acme'
		), customer AS (
			INSERT INTO customers (project_id, billing_account_id)
			SELECT project_id, ${billingAccountId} FROM catalog
			RETURNING id, project_id
		)
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status, starts_at,
			expires_at, auto_renew, raw_state
		)
		SELECT
			catalog.project_id, customer.id, catalog.product_id, catalog.store_product_id, 'google',
			'android', ${`subscription_${billingAccountId}`}, 'premium_monthly', 'monthly-base', 'active',
			now() - INTERVAL '1 day', now() + INTERVAL '30 days', true, '{}'::jsonb
		FROM catalog CROSS JOIN customer
		RETURNING id
	`;
	if (row === undefined) throw new Error(`seeding ${billingAccountId} failed`);
	return row.id;
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
	provider: string,
	channel: string,
): void {
	expect(snapshot.billingAccountId).toBe(billingAccountId);
	expect(snapshot.generatedAt).toEqual(expect.any(String));
	expect(snapshot.entitlements).toHaveLength(1);
	expect(snapshot.entitlements[0]).toEqual({
		key: "premium",
		active: true,
		expiresAt: "2099-06-30T00:00:00.000Z",
		metadata: expect.objectContaining({
			channel,
			provider,
			source: "subscription",
			status: "active",
		}),
	});
}

async function expectEntitlementProjectRows(
	sql: SQL,
	expected: Array<{
		project_key: string;
		entitlement_count: string;
		active_count: string;
	}>,
): Promise<void> {
	const rows = await sql<
		{
			project_key: string;
			entitlement_count: string;
			active_count: string;
		}[]
	>`
		SELECT projects.key AS project_key,
			count(entitlements.id)::text AS entitlement_count,
			count(entitlements.id) FILTER (WHERE entitlements.active)::text AS active_count
		FROM projects
		LEFT JOIN entitlements ON entitlements.project_id = projects.id
		WHERE projects.key IN ('acme', 'globex')
		GROUP BY projects.key
		ORDER BY projects.key
	`;

	expect(rows).toEqual(expected);
}

async function seedSubscriptionExpiryFixtures(sql: SQL): Promise<void> {
	const catalogRows = await sql<
		{
			project_id: string;
			product_id: string;
			store_product_id: string;
		}[]
	>`
		SELECT projects.id AS project_id, products.id AS product_id, store_products.id AS store_product_id
		FROM projects
		JOIN products ON products.project_id = projects.id
			AND products.key = 'premium_monthly'
		JOIN store_products ON store_products.project_id = projects.id
			AND store_products.product_id = products.id
			AND store_products.provider = 'google'
			AND store_products.external_product_id = 'premium_monthly'
			AND store_products.external_price_id = 'monthly-base'
		WHERE projects.key = 'acme'
	`;
	expect(catalogRows).toHaveLength(1);
	const catalog = catalogRows[0];

	const lifecycleCustomers = await sql<{ id: string }[]>`
		INSERT INTO customers (project_id, billing_account_id)
		VALUES (${catalog.project_id}, 'subscription_lifecycle_user')
		RETURNING id
	`;
	const legacyCustomers = await sql<{ id: string }[]>`
		INSERT INTO customers (project_id, billing_account_id)
		VALUES (${catalog.project_id}, 'legacy_null_subscription_user')
		RETURNING id
	`;
	const lifecycleCustomerId = lifecycleCustomers[0].id;
	const legacyCustomerId = legacyCustomers[0].id;

	await sql`
		INSERT INTO subscriptions (
			project_id,
			customer_id,
			product_id,
			store_product_id,
			provider,
			channel,
			external_subscription_id,
			external_product_id,
			external_price_id,
			status,
			starts_at,
			expires_at,
			auto_renew,
			raw_state
		)
		VALUES
			(
				${catalog.project_id},
				${lifecycleCustomerId},
				${catalog.product_id},
				${catalog.store_product_id},
				'google',
				'android',
				'subscription_active_null_expiry',
				'premium_monthly',
				'monthly-base',
				'active',
				now() - INTERVAL '7 days',
				NULL,
				true,
				${JSON.stringify({ fixture: "active_null_expiry" })}::text::jsonb
			),
			(
				${catalog.project_id},
				${lifecycleCustomerId},
				${catalog.product_id},
				${catalog.store_product_id},
				'google',
				'android',
				'subscription_active_expired',
				'premium_monthly',
				'monthly-base',
				'active',
				now() - INTERVAL '14 days',
				now() - INTERVAL '1 hour',
				true,
				${JSON.stringify({ fixture: "active_expired" })}::text::jsonb
			),
			(
				${catalog.project_id},
				${lifecycleCustomerId},
				${catalog.product_id},
				${catalog.store_product_id},
				'google',
				'android',
				'subscription_cancelled_pending_expiry',
				'premium_monthly',
				'monthly-base',
				'cancelled',
				now() - INTERVAL '7 days',
				now() + INTERVAL '14 days',
				false,
				${JSON.stringify({ fixture: "cancelled_pending_expiry" })}::text::jsonb
			)
	`;
	const legacySubscriptions = await sql<{ id: string }[]>`
		INSERT INTO subscriptions (
			project_id,
			customer_id,
			product_id,
			store_product_id,
			provider,
			channel,
			external_subscription_id,
			external_product_id,
			external_price_id,
			status,
			starts_at,
			expires_at,
			auto_renew,
			raw_state
		)
		VALUES (
			${catalog.project_id},
			${legacyCustomerId},
			${catalog.product_id},
			${catalog.store_product_id},
			'google',
			'android',
			'subscription_legacy_null_expiry',
			'premium_monthly',
			'monthly-base',
			'active',
			now() - INTERVAL '7 days',
			NULL,
			true,
			${JSON.stringify({ fixture: "legacy_null_expiry" })}::text::jsonb
		)
		RETURNING id
	`;

	await sql`
		INSERT INTO entitlements (
			project_id,
			customer_id,
			entitlement_key,
			active,
			expires_at,
			source_subscription_id,
			metadata
		)
		VALUES (
			${catalog.project_id},
			${legacyCustomerId},
			'premium',
			true,
			NULL,
			${legacySubscriptions[0].id},
			${JSON.stringify({
				source: "subscription",
				status: "active",
				provider: "google",
				channel: "android",
			})}::text::jsonb
		)
	`;
}

// Pass-through: the repository now serializes all Date SQL params as ISO (src/db/repository.ts),
// so the integration suite exercises the real serialization instead of patching Date.
async function withIsoDateSqlParameters<T>(callback: () => T | Promise<T>): Promise<T> {
	return await callback();
}
