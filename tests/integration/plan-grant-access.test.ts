import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CatalogIntent } from "../../src/catalog/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/** The metering catalog with a blocked monthly API-call limit on the premium plan. */
const grantCatalog: CatalogIntent = {
	...aiCreditsCatalog,
	features: [
		...aiCreditsCatalog.features,
		{
			key: "api_calls",
			name: "API calls",
			kind: "metered",
			meterKind: "consumable",
			unit: "call",
			creditScale: 0,
			filterDimensions: [],
		},
	],
	plans: aiCreditsCatalog.plans.map((plan) => ({
		...plan,
		items: [
			...plan.items,
			{
				featureKey: "api_calls",
				itemKind: "meter_limit",
				quantity: "100",
				resetInterval: "month",
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
			},
		],
	})),
};

localDescribe("Plan grant access integration", () => {
	const project = integrationProjectContext();

	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		const preview = await context.repository.previewCatalog(project, {
			expectedRevision: null,
			actor: "plan-grant-access",
			catalog: grantCatalog,
		});
		await context.repository.publishCatalog(project, {
			expectedRevision: null,
			actor: "plan-grant-access",
			previewToken: preview.previewToken,
			catalog: grantCatalog,
		});
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("grants the plan's entitlements and blocked limits until a paid subscription takes over", async () => {
		const grant = await seedTrialGrant("grant_user", { startsInMs: -86_400_000, daysLong: 14 });

		const snapshot = await context.repository.recomputeCustomerEntitlements(project, "grant_user");
		expect(snapshot.entitlements).toEqual([
			{
				key: "premium",
				active: true,
				expiresAt: grant.endsAt.toISOString(),
				metadata: {
					source: "plan_grant",
					origin: "trial",
					status: "active",
					planKey: "premium",
					planGrantId: grant.id,
					trialStartsAt: grant.startsAt.toISOString(),
					trialEndsAt: grant.endsAt.toISOString(),
				},
			},
		]);

		const check = (quantity: string) =>
			context.repository.checkUsage(project, {
				billingAccountId: "grant_user",
				featureKey: "api_calls",
				quantity,
			});
		expect((await check("100")).allowed).toBe(true);
		await context.repository.consumeUsage(project, {
			billingAccountId: "grant_user",
			featureKey: "api_calls",
			quantity: "100",
			idempotencyKey: "grant-consume",
		});
		const exhausted = await check("1");
		expect({ allowed: exhausted.allowed, reason: exhausted.reason }).toEqual({
			allowed: false,
			reason: "insufficient_balance",
		});
		expect(exhausted.balance.granted).toBe("100");
		const grantBalances = await context.repository.buildUsageProjection(
			project.projectInstanceId,
			grant.customerId,
		);
		expect(grantBalances.balances.find((row) => row.featureKey === "api_calls")).toEqual({
			featureKey: "api_calls",
			unit: "call",
			available: "0",
			held: "0",
			periodEndsAt: grant.endsAt.toISOString(),
		});

		// A paid App Store subscription on the same plan wins even though the grant runs longer.
		const paidEnd = new Date(Math.floor(Date.now() / 1000) * 1000 + 5 * 86_400_000);
		await context.repository.recordStoreKitTransactionAndEnqueueProjection(project, {
			billingAccountId: "grant_user",
			appAccountToken: null,
			channel: "ios",
			externalProductId: "premium_monthly",
			purchaseKind: "subscription",
			transactionId: "grant_paid_1",
			originalTransactionId: "grant_paid",
			webOrderLineItemId: "grant_paid_line",
			purchaseStatus: "completed",
			subscriptionStatus: "active",
			purchasedAt: new Date(paidEnd.getTime() - 30 * 86_400_000),
			expiresAt: paidEnd,
			autoRenew: true,
			invalidatedAt: null,
			invalidationReason: null,
			rawPayload: { fixture: "grant_paid" },
			eventType: "SUBSCRIBED",
			externalEventId: "grant_paid_event",
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: "grant_paid:projection",
		});
		const paid = await context.repository.getEntitlementSnapshot(project, "grant_user");
		expect(paid.entitlements[0]).toMatchObject({
			key: "premium",
			active: true,
			expiresAt: paidEnd.toISOString(),
			metadata: { source: "subscription", provider: "apple" },
		});
		const afterPaid = await check("1");
		expect(afterPaid.allowed).toBe(true);
		const paidBalances = await context.repository.buildUsageProjection(
			project.projectInstanceId,
			grant.customerId,
		);
		expect(
			paidBalances.balances.find((row) => row.featureKey === "api_calls")?.periodEndsAt,
		).not.toBe(grant.endsAt.toISOString());
	});

	it("stops an elapsed grant at its end before any sweep marks it", async () => {
		await seedTrialGrant("elapsed_user", { startsInMs: -15 * 86_400_000, daysLong: 14 });

		const snapshot = await context.repository.recomputeCustomerEntitlements(
			project,
			"elapsed_user",
		);
		expect(snapshot.entitlements).toEqual([]);
		const check = await context.repository.checkUsage(project, {
			billingAccountId: "elapsed_user",
			featureKey: "api_calls",
			quantity: "1",
		});
		expect({ allowed: check.allowed, granted: check.balance.granted }).toEqual({
			allowed: false,
			granted: "0",
		});
	});

	it("admits a reward allocation only from a promotion redemption or a plan grant", async () => {
		const grant = await seedTrialGrant("reward_user", { startsInMs: 0, daysLong: 14 });
		const insertReward = (planGrantId: string | null) => context.sql`
			INSERT INTO balance_allocations (
				project_id, customer_id, feature_id, source_kind, source_key, quantity, plan_grant_id
			)
			SELECT ${project.projectInstanceId}::uuid, ${grant.customerId}::uuid, f.id, 'reward',
				${`plan_grant:${planGrantId ?? "none"}`}, 10, ${planGrantId}::uuid
			FROM features f
			WHERE f.project_id = ${project.projectInstanceId}::uuid AND f.key = 'ai_credits'
		`;

		await insertReward(grant.id);
		let failure: unknown = null;
		try {
			await insertReward(null);
		} catch (error) {
			failure = error;
		}
		expect(String((failure as Error | null)?.message)).toContain(
			"balance_allocations_reward_provenance_check",
		);
	});
});

async function seedTrialGrant(
	billingAccountId: string,
	input: { startsInMs: number; daysLong: number },
): Promise<{ id: string; customerId: string; startsAt: Date; endsAt: Date }> {
	const project = integrationProjectContext();
	const startsAt = new Date(Math.floor(Date.now() / 1000) * 1000 + input.startsInMs);
	const endsAt = new Date(startsAt.getTime() + input.daysLong * 86_400_000);
	const [customer] = await context.sql<{ id: string }[]>`
		INSERT INTO customers (project_id, billing_account_id)
		VALUES (${project.projectInstanceId}::uuid, ${billingAccountId})
		RETURNING id
	`;
	if (customer === undefined) throw new Error("customer was not seeded");
	const [grant] = await context.sql<{ id: string }[]>`
		INSERT INTO plan_grants (
			project_id, customer_id, plan_id, plan_version_id, plan_kind, origin, status,
			duration_unit, duration_count, starts_at, ends_at, entitlement_keys, next_period_at,
			actor, idempotency_key, request_hash
		)
		SELECT p.project_id, ${customer.id}::uuid, p.id, pv.id, pv.plan_kind, 'trial', 'active',
			'day', ${input.daysLong}, ${startsAt.toISOString()}::timestamptz,
			${endsAt.toISOString()}::timestamptz, ARRAY['premium'], NULL,
			'plan-grant-access', ${`seed:${billingAccountId}`}, repeat('0', 64)
		FROM plans p
		JOIN plan_versions pv ON pv.project_id = p.project_id AND pv.id = p.active_version_id
		WHERE p.project_id = ${project.projectInstanceId}::uuid AND p.key = 'premium'
		RETURNING id
	`;
	if (grant === undefined) throw new Error("plan grant was not seeded");
	return { id: grant.id, customerId: customer.id, startsAt, endsAt };
}
