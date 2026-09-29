import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;
let revision: number | null;

function freePlan(version: number, quantity: string): CatalogPlanIntent {
	return {
		key: "free",
		name: "Free",
		version,
		currency: null,
		baseAmountMinor: null,
		billingInterval: null,
		trialDays: null,
		items: [
			{
				featureKey: "ai_credits",
				itemKind: "allocation",
				quantity,
				resetInterval: "month",
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
			},
		],
		providerBindings: [],
	};
}

function catalog(
	plan: CatalogPlanIntent | null,
	entitlementKeys: string[] = ["free_tier"],
): CatalogIntent {
	return {
		...aiCreditsCatalog,
		plans: [...aiCreditsCatalog.plans, ...(plan === null ? [] : [plan])],
		...(plan === null ? {} : { defaultPlan: { planKey: plan.key, entitlementKeys } }),
		retiredPlanKeys: plan === null && revision !== null ? ["free"] : [],
	};
}

async function publish(intent: CatalogIntent): Promise<void> {
	const preview = await context.repository.previewCatalog(project, {
		expectedRevision: revision,
		actor: "default-plan-test",
		catalog: intent,
	});
	const published = await context.repository.publishCatalog(project, {
		expectedRevision: revision,
		actor: "default-plan-test",
		previewToken: preview.previewToken,
		catalog: intent,
	});
	revision = published.revision;
}

/** Plain rows: Bun's result array carries extra properties that object matchers compare. */
async function grants(billingAccountId: string) {
	const rows = await context.sql<
		Array<{
			id: string;
			origin: string;
			status: string;
			plan_version: number;
			entitlement_keys: string[];
			ends_at: Date | null;
			superseded_by_subscription_id: string | null;
			superseded_by_plan_grant_id: string | null;
		}>
	>`
		SELECT g.id, g.origin, g.status, version.version AS plan_version, g.entitlement_keys, g.ends_at,
			g.superseded_by_subscription_id, g.superseded_by_plan_grant_id
		FROM plan_grants g
		JOIN customers c ON c.id = g.customer_id
		JOIN plan_versions version ON version.id = g.plan_version_id
		WHERE c.billing_account_id = ${billingAccountId}
		ORDER BY g.created_at, g.id
	`;
	return rows.map((row) => ({ ...row }));
}

async function consume(billingAccountId: string, credits: number, key: string) {
	return await context.repository.consumeUsage(project, {
		billingAccountId,
		featureKey: "model_tokens",
		quantity: String(credits * 200),
		idempotencyKey: key,
	});
}

async function balance(billingAccountId: string) {
	return await context.repository.getMeteringBalance(project, billingAccountId, "ai_credits");
}

async function entitlements(billingAccountId: string) {
	return (await context.repository.getEntitlementSnapshot(project, billingAccountId)).entitlements;
}

/** A Stripe subscription to the premium plan, as a provider sync records it. */
async function subscribe(billingAccountId: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end,
			plan_version_id, catalog_revision_id
		)
		SELECT
			customer.project_id, customer.id, product.id, store_product.id, 'stripe', 'web',
			${`sub:${billingAccountId}`}, 'prod_stripe_premium', 'price_premium_monthly', 'active',
			now(), now() + INTERVAL '1 month', now(), now() + INTERVAL '1 month',
			version.id, version.catalog_revision_id
		FROM customers customer
		JOIN products product ON product.project_id = customer.project_id AND product.key = 'premium_monthly'
		JOIN store_products store_product
			ON store_product.product_id = product.id AND store_product.provider = 'stripe'
		JOIN plans plan ON plan.project_id = customer.project_id AND plan.key = 'premium'
		JOIN plan_versions version ON version.id = plan.active_version_id
		WHERE customer.billing_account_id = ${billingAccountId}
		RETURNING id
	`;
	if (row === undefined) throw new Error("subscription was not seeded");
	await context.repository.recomputeCustomerEntitlements(project, billingAccountId);
	return row.id;
}

async function runWorker(limit: number) {
	return await context.repository.reconcilePlanGrants(limit);
}

localDescribe("default plan", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		revision = null;
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("starts a new account on the default plan with its keys, allowance and a stored projection", async () => {
		await publish(catalog(freePlan(1, "100")));

		const consumed = await consume("new_user", 10, "spend-1");

		expect(consumed).toMatchObject({ allowed: true, balance: { available: "90" } });
		expect(await grants("new_user")).toMatchObject([
			{
				origin: "default",
				status: "active",
				plan_version: 1,
				entitlement_keys: ["free_tier"],
				ends_at: null,
			},
		]);
		expect(await entitlements("new_user")).toMatchObject([
			{
				key: "free_tier",
				active: true,
				expiresAt: null,
				metadata: { source: "plan_grant", origin: "default", planKey: "free" },
			},
		]);
		const [grant] = await grants("new_user");
		const jobs = await context.sql<Array<{ idempotency_key: string }>>`
			SELECT idempotency_key FROM projection_sync_jobs ORDER BY id
		`;
		expect(jobs.map((job) => job.idempotency_key)).toContain(`plan_grant:${grant?.id}:started`);
	});

	it("gives way to a paid base plan and returns with a new anchor when it lapses", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("paying_user", 1, "spend-1");
		const subscriptionId = await subscribe("paying_user");

		expect(await grants("paying_user")).toMatchObject([
			{ origin: "default", status: "superseded", superseded_by_subscription_id: subscriptionId },
		]);
		expect(await balance("paying_user")).toMatchObject({ available: "0" });
		expect(
			(await entitlements("paying_user")).find((row) => row.key === "free_tier"),
		).toMatchObject({
			active: false,
		});

		await context.sql`UPDATE subscriptions SET status = 'expired', expires_at = now() - INTERVAL '1 second'`;
		await context.repository.recomputeCustomerEntitlements(project, "paying_user");

		const after = await grants("paying_user");
		expect(after.map((row) => [row.origin, row.status])).toEqual([
			["default", "superseded"],
			["default", "active"],
		]);
		expect(await balance("paying_user")).toMatchObject({ available: "100" });
	});

	it("is superseded by a trial, refuses to be trialed and returns when the trial ends", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("trial_user", 1, "spend-1");

		const refused = await context.repository.planGrants
			.startTrial(project, {
				billingAccountId: "trial_user",
				planKey: "free",
				durationDays: 7,
				metadata: {},
				idempotencyKey: "trial-free",
				actor: null,
			})
			.catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "TRIAL_PLAN_NOT_ELIGIBLE" });

		const started = await context.repository.planGrants.startTrial(project, {
			billingAccountId: "trial_user",
			planKey: "premium",
			durationDays: 7,
			metadata: {},
			idempotencyKey: "trial-1",
			actor: null,
		});
		expect(await grants("trial_user")).toMatchObject([
			{ origin: "default", status: "superseded", superseded_by_plan_grant_id: started.trial.id },
			{ origin: "trial", status: "active" },
		]);

		await context.repository.planGrants.endTrial(project, {
			billingAccountId: "trial_user",
			trialId: started.trial.id,
			reason: null,
			idempotencyKey: "end-1",
			actor: null,
		});
		expect((await grants("trial_user")).map((row) => [row.origin, row.status])).toEqual([
			["default", "superseded"],
			["trial", "ended"],
			["default", "active"],
		]);
	});

	it("backfills existing accounts in slices and leaves paying accounts alone", async () => {
		await publish(catalog(null));
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, account FROM projects, unnest(ARRAY['a_user', 'b_user', 'c_user']) AS account
			WHERE key = 'voysee'
		`;
		await context.repository.grantAllocation(project, {
			billingAccountId: "paid_user",
			featureKey: "ai_credits",
			quantity: "1",
			sourceKind: "credit_grant",
			sourceKey: "seed",
		});
		await subscribe("paid_user");
		expect(await context.sql`SELECT id FROM plan_grants`).toHaveLength(0);

		await publish(catalog(freePlan(1, "100")));
		const [job] = await context.sql<Array<{ status: string }>>`
			SELECT status FROM default_plan_reconciliations
		`;
		expect(job?.status).toBe("pending");

		const first = await runWorker(1);
		expect(first.defaultPlanGrants).toBe(3);
		expect(await runWorker(1)).toMatchObject({ defaultPlanGrants: 0 });
		for (const account of ["a_user", "b_user", "c_user"]) {
			expect(await grants(account)).toMatchObject([{ origin: "default", status: "active" }]);
		}
		expect(await grants("paid_user")).toEqual([]);
		const [done] = await context.sql<Array<{ status: string; grants_changed: number }>>`
			SELECT status, grants_changed FROM default_plan_reconciliations
		`;
		expect(done).toEqual({ status: "completed", grants_changed: 3 });
	});

	it("moves to a new version keeping the window's allowance, follows its keys, ends and restarts", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("mover", 30, "spend-1");
		const [original] = await grants("mover");

		await publish(catalog(freePlan(2, "500")));
		await runWorker(25);
		const moved = await grants("mover");
		expect(moved).toMatchObject([{ id: original?.id, status: "active", plan_version: 2 }]);
		// The current window keeps what it gave; the new quantity applies from the next reset.
		expect(await balance("mover")).toMatchObject({
			granted: "100",
			consumed: "30",
			available: "70",
		});

		await publish(catalog(freePlan(2, "500"), ["free_tier", "starter"]));
		await runWorker(25);
		expect((await grants("mover"))[0]?.entitlement_keys).toEqual(["free_tier", "starter"]);
		expect((await entitlements("mover")).map((row) => row.key)).toEqual(["free_tier", "starter"]);

		await publish(catalog(null));
		await runWorker(25);
		expect((await grants("mover")).map((row) => row.status)).toEqual(["ended"]);
		expect(await balance("mover")).toMatchObject({ available: "0" });

		await publish(catalog(freePlan(3, "50")));
		await runWorker(25);
		expect((await grants("mover")).map((row) => [row.status, row.plan_version])).toEqual([
			["ended", 2],
			["active", 3],
		]);
		expect(await balance("mover")).toMatchObject({ available: "50" });
	});

	it("answers an unknown account from the default plan without recording it", async () => {
		const check = (quantity: string) =>
			context.repository.checkUsage(project, {
				billingAccountId: "stranger",
				featureKey: "model_tokens",
				quantity,
			});
		const counts = async () =>
			(
				await context.sql<Array<{ customers: number; grants: number }>>`
					SELECT
						(SELECT count(*)::integer FROM customers WHERE billing_account_id = 'stranger') AS customers,
						(SELECT count(*)::integer FROM plan_grants) AS grants
				`
			)[0];

		await publish(catalog(null));
		expect(await check("2000")).toMatchObject({ allowed: false, balance: { available: "0" } });
		await publish(catalog(freePlan(1, "100")));

		expect(await check("2000")).toMatchObject({
			allowed: true,
			walletQuantity: "10",
			balance: { granted: "100", available: "100" },
		});
		expect(await check("40000")).toMatchObject({ allowed: false, reason: "insufficient_balance" });
		expect(await balance("stranger")).toMatchObject({
			granted: "100",
			consumed: "0",
			available: "100",
		});
		expect(await counts()).toEqual({ customers: 0, grants: 0 });

		await consume("stranger", 10, "first-write");
		expect(await balance("stranger")).toMatchObject({ granted: "100", available: "90" });
	});

	it("applies the default plan's meter limit to an unknown account in a window starting now", async () => {
		const limited = freePlan(1, "100");
		limited.items.push({
			featureKey: "model_tokens",
			itemKind: "meter_limit",
			quantity: "1000",
			resetInterval: "day",
			expiresAfterSeconds: null,
			overagePolicy: "blocked",
		});
		await publish({ ...catalog(limited), rateCards: [] });

		const within = await context.repository.checkUsage(project, {
			billingAccountId: "stranger",
			featureKey: "model_tokens",
			quantity: "600",
		});
		const beyond = await context.repository.checkUsage(project, {
			billingAccountId: "stranger",
			featureKey: "model_tokens",
			quantity: "1200",
		});

		expect(within).toMatchObject({
			allowed: true,
			balance: { granted: "1000", available: "1000" },
		});
		expect(beyond).toMatchObject({ allowed: false, reason: "insufficient_balance" });
		expect(
			await context.sql`SELECT id FROM customers WHERE billing_account_id = 'stranger'`,
		).toHaveLength(0);
	});

	it("gives two concurrent first requests one default grant", async () => {
		await publish(catalog(freePlan(1, "100")));

		const results = await Promise.all([
			consume("racer", 1, "race-1"),
			consume("racer", 1, "race-2"),
		]);

		expect(results.every((result) => result.allowed)).toBe(true);
		expect(await grants("racer")).toHaveLength(1);
		expect(await balance("racer")).toMatchObject({ available: "98" });
	});
});
