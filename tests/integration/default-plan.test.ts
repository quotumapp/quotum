import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";
import { readProjectionBalances } from "../../src/db/repository/entitlements";
import type { QueryExecutor } from "../../src/db/repository/types";
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
			starts_at: Date;
			ends_at: Date | null;
			superseded_by_subscription_id: string | null;
			superseded_by_plan_grant_id: string | null;
		}>
	>`
		SELECT g.id, g.origin, g.status, version.version AS plan_version, g.entitlement_keys,
			g.starts_at, g.ends_at,
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

async function allowanceRows(billingAccountId: string) {
	const rows = await context.sql<
		Array<{ plan_grant_id: string; period_start_at: Date; consumed: string; live: boolean }>
	>`
		SELECT a.plan_grant_id, a.period_start_at, a.consumed_quantity::text AS consumed,
			(a.expires_at IS NULL OR a.expires_at > now()) AS live
		FROM balance_allocations a
		JOIN customers c ON c.id = a.customer_id
		WHERE c.billing_account_id = ${billingAccountId} AND a.plan_grant_id IS NOT NULL
		ORDER BY a.period_start_at, a.id
	`;
	return rows.map((row) => ({ ...row }));
}

/** Customers recorded before the catalog marked a default plan. */
async function seedCustomers(accounts: string[]): Promise<void> {
	await context.sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, account FROM projects, unnest(string_to_array(${accounts.join(",")}, ',')) AS account
		WHERE key = 'acme'
	`;
}

const idle = {
	expiredPlanGrants: 0,
	defaultPlanGrants: 0,
	defaultPlanSkipped: 0,
	defaultPlanFailedSlices: 0,
};

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

	it("gives way to a paid base plan and resumes the window's allowance when it lapses", async () => {
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
		// Same anchor, and the window's allowance carries on from what was spent before.
		expect(after[1]?.starts_at).toEqual(after[0]?.starts_at);
		expect(await balance("paying_user")).toMatchObject({ granted: "100", available: "99" });
		expect((await allowanceRows("paying_user")).map((row) => row.plan_grant_id)).toEqual([
			after[1]?.id,
		]);
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
		expect(await balance("trial_user")).toMatchObject({ available: "99" });
	});

	it("opens the current window on a confirmation, so its balance counts what the account holds", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("confirmer", 1, "confirm-start");
		const hold = await context.repository.reserveUsage(project, {
			billingAccountId: "confirmer",
			featureKey: "model_tokens",
			quantity: "200",
			idempotencyKey: "confirm-hold",
			expiresInSeconds: 300,
		});
		if (hold.reservationId === null) throw new Error("Expected a reservation");
		// The trial's allowance window has not been opened by any write yet.
		await context.repository.planGrants.startTrial(project, {
			billingAccountId: "confirmer",
			planKey: "premium",
			durationDays: 7,
			metadata: {},
			idempotencyKey: "confirm-trial",
			actor: null,
		});

		const confirmed = await context.repository.confirmUsageReservation(project, {
			billingAccountId: "confirmer",
			reservationId: hold.reservationId,
			quantity: "200",
			idempotencyKey: "confirm-after-trial",
		});

		const read = await balance("confirmer");
		expect(Number(read.available)).toBeGreaterThan(0);
		expect(confirmed.balance?.available).toBe(read.available);
	});

	it("backfills existing accounts in slices and leaves paying accounts alone", async () => {
		await publish(catalog(null));
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, account FROM projects, unnest(ARRAY['a_user', 'b_user', 'c_user']) AS account
			WHERE key = 'acme'
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
		// Restarting within the window resumes it; version 3's quantity applies from the next one.
		expect(await balance("mover")).toMatchObject({ granted: "100", available: "70" });
	});

	it("creates no allowance until the account spends, however many resets pass", async () => {
		await publish(catalog(null));
		await seedCustomers(["idle_user"]);
		await publish(catalog(freePlan(1, "100")));
		expect(await runWorker(25)).toEqual({ ...idle, defaultPlanGrants: 1 });

		expect(await allowanceRows("idle_user")).toEqual([]);
		expect(await balance("idle_user")).toMatchObject({ granted: "100", available: "100" });
		const [customer] = await context.sql<Array<{ id: string }>>`
			SELECT id FROM customers WHERE billing_account_id = 'idle_user'
		`;
		const projected = async () =>
			await readProjectionBalances(
				context.db as unknown as QueryExecutor,
				project.projectInstanceId,
				customer?.id ?? "",
			);
		expect(await projected()).toMatchObject([{ featureKey: "ai_credits", available: "100" }]);

		// Two resets later nothing was written, and the worker has nothing to do.
		await context.sql`
			UPDATE plan_grants SET starts_at = starts_at - interval '2 months 1 day'
			WHERE origin = 'default'
		`;
		expect(await runWorker(25)).toEqual(idle);
		expect(await allowanceRows("idle_user")).toEqual([]);
		expect(await balance("idle_user")).toMatchObject({ available: "100" });

		await consume("idle_user", 10, "spend-1");
		const [grant] = await grants("idle_user");
		const rows = await allowanceRows("idle_user");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.period_start_at.getTime()).toBeGreaterThan(grant?.starts_at.getTime() ?? 0);
		expect(await balance("idle_user")).toMatchObject({ granted: "100", available: "90" });
		expect(await projected()).toMatchObject([{ featureKey: "ai_credits", available: "90" }]);
		expect(
			(await context.repository.getCustomerBillingSummary(project, "idle_user")).balances,
		).toMatchObject([{ featureKey: "ai_credits", available: "90" }]);
	});

	it("reads an account the pass has not reached as on the default plan, and its write starts it", async () => {
		await publish(catalog(null));
		await seedCustomers(["late_user"]);
		await publish(catalog(freePlan(1, "100")));

		expect(await balance("late_user")).toMatchObject({ granted: "100", available: "100" });
		expect(
			await context.repository.checkUsage(project, {
				billingAccountId: "late_user",
				featureKey: "model_tokens",
				quantity: "2000",
			}),
		).toMatchObject({ allowed: true });
		expect(await entitlements("late_user")).toEqual([
			{
				key: "free_tier",
				active: true,
				expiresAt: null,
				metadata: { source: "plan_grant", origin: "default", status: "active", planKey: "free" },
			},
		]);
		expect(
			(await context.repository.getCustomerBillingSummary(project, "late_user")).balances,
		).toMatchObject([{ featureKey: "ai_credits", available: "100" }]);
		expect(await grants("late_user")).toEqual([]);

		await consume("late_user", 10, "spend-1");
		const [grant] = await grants("late_user");
		expect(grant).toMatchObject({ origin: "default", status: "active" });
		expect(await balance("late_user")).toMatchObject({ available: "90" });
		const jobs = await context.sql<Array<{ idempotency_key: string }>>`
			SELECT idempotency_key FROM projection_sync_jobs
		`;
		expect(jobs.map((job) => job.idempotency_key)).toContain(`plan_grant:${grant?.id}:started`);
		expect(await runWorker(25)).toEqual(idle);
	});

	it("records an elapsed trial on the next write and resumes the default plan's window", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("lapsed_user", 1, "spend-1");
		const started = await context.repository.planGrants.startTrial(project, {
			billingAccountId: "lapsed_user",
			planKey: "premium",
			durationDays: 7,
			metadata: {},
			idempotencyKey: "trial-1",
			actor: null,
		});
		// The trial ended a moment ago, and the worker has not recorded it yet.
		await context.sql`
			UPDATE plan_grants
			SET starts_at = starts_at - interval '7 days 1 minute', ends_at = ends_at - interval '7 days 1 minute'
			WHERE id = ${started.trial.id}::uuid
		`;

		expect(await balance("lapsed_user")).toMatchObject({ granted: "100", available: "99" });
		await consume("lapsed_user", 1, "spend-2");

		expect((await grants("lapsed_user")).map((row) => [row.origin, row.status])).toEqual([
			["default", "superseded"],
			["trial", "expired"],
			["default", "active"],
		]);
		expect(await balance("lapsed_user")).toMatchObject({ granted: "100", available: "98" });
		expect(await runWorker(25)).toEqual(idle);
	});

	it("keeps counting the meter-limit window when the account falls back to it", async () => {
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
		const tokens = (quantity: string) =>
			context.repository.checkUsage(project, {
				billingAccountId: "metered_user",
				featureKey: "model_tokens",
				quantity,
			});
		expect(
			await context.repository.consumeUsage(project, {
				billingAccountId: "metered_user",
				featureKey: "model_tokens",
				quantity: "600",
				idempotencyKey: "spend-1",
			}),
		).toMatchObject({ allowed: true });
		const started = await context.repository.planGrants.startTrial(project, {
			billingAccountId: "metered_user",
			planKey: "premium",
			durationDays: 7,
			metadata: {},
			idempotencyKey: "trial-1",
			actor: null,
		});
		await context.repository.planGrants.endTrial(project, {
			billingAccountId: "metered_user",
			trialId: started.trial.id,
			reason: null,
			idempotencyKey: "end-1",
			actor: null,
		});

		expect(await tokens("600")).toMatchObject({ allowed: false, reason: "insufficient_balance" });
		expect(await tokens("400")).toMatchObject({ allowed: true });
	});

	it("leaves an account whose change fails behind, records it and finishes the pass", async () => {
		await publish(catalog(null));
		await seedCustomers(["a_user", "b_user", "c_user"]);
		const [broken] = await context.sql<Array<{ id: string }>>`
			SELECT id FROM customers WHERE billing_account_id = 'b_user'
		`;
		await context.sql.unsafe(`
			CREATE FUNCTION refuse_default_plan_grant() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.customer_id = '${broken?.id}'::uuid THEN
					RAISE EXCEPTION 'grant refused for this account';
				END IF;
				RETURN NEW;
			END $$;
			CREATE TRIGGER refuse_default_plan_grant BEFORE INSERT ON plan_grants
				FOR EACH ROW EXECUTE FUNCTION refuse_default_plan_grant();
		`);
		try {
			await publish(catalog(freePlan(1, "100")));
			expect(await runWorker(25)).toEqual({
				...idle,
				defaultPlanGrants: 2,
				defaultPlanSkipped: 1,
			});
		} finally {
			await context.sql.unsafe(`
				DROP TRIGGER refuse_default_plan_grant ON plan_grants;
				DROP FUNCTION refuse_default_plan_grant();
			`);
		}

		const [pass] = await context.sql<
			Array<{
				status: string;
				grants_changed: number;
				customers_skipped: number;
				last_skipped_customer_id: string | null;
				last_skip_error: string | null;
			}>
		>`
			SELECT status, grants_changed, customers_skipped, last_skipped_customer_id, last_skip_error
			FROM default_plan_reconciliations
			WHERE status <> 'superseded'
		`;
		expect({ ...pass }).toEqual({
			status: "completed",
			grants_changed: 2,
			customers_skipped: 1,
			last_skipped_customer_id: broken?.id ?? null,
			last_skip_error: "P0001: grant refused for this account",
		});
		expect(await grants("a_user")).toMatchObject([{ origin: "default", status: "active" }]);
		expect(await grants("b_user")).toEqual([]);
		expect(await grants("c_user")).toMatchObject([{ origin: "default", status: "active" }]);

		// The account still reads as on the default plan, and its first write starts it.
		expect(await balance("b_user")).toMatchObject({ available: "100" });
		await consume("b_user", 1, "spend-1");
		expect(await grants("b_user")).toMatchObject([{ origin: "default", status: "active" }]);
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
