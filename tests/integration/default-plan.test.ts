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
			metadata: { source: "plan_grant", origin: "default", status: "superseded" },
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

	it("resumes a feature's allowance within its window when a later version adds it back", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("returner", 30, "spend-1");

		await publish(catalog({ ...freePlan(2, "100"), items: [] }));
		// A read answers as the account's next write will, before and after the pass reaches it.
		expect(await balance("returner")).toMatchObject({ available: "0" });
		await runWorker(25);
		expect(await balance("returner")).toMatchObject({ available: "0" });

		// The window already gave its allowance, so adding the feature back resumes what was left of
		// it with the use kept; version 3's quantity applies from the next reset.
		await publish(catalog(freePlan(3, "500")));
		const resumed = { granted: "100", consumed: "30", available: "70" };
		expect(await balance("returner")).toMatchObject(resumed);
		await runWorker(25);
		expect(await balance("returner")).toMatchObject(resumed);
		expect(await consume("returner", 10, "spend-2")).toMatchObject({
			allowed: true,
			balance: { available: "60" },
		});
		const rows = await allowanceRows("returner");
		expect(rows.map((row) => [Number(row.consumed), row.live])).toEqual([[40, true]]);
	});

	it("counts an open hold once when a later version adds its feature back", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("holder", 20, "spend-1");
		const hold = await context.repository.reserveUsage(project, {
			billingAccountId: "holder",
			featureKey: "model_tokens",
			quantity: "6000",
			idempotencyKey: "hold-1",
			expiresInSeconds: 300,
		});
		expect(hold.allowed).toBe(true);

		await publish(catalog({ ...freePlan(2, "100"), items: [] }));
		await runWorker(25);
		expect(await balance("holder")).toMatchObject({ held: "30", available: "0" });

		// The re-added allowance is the ended row holding the reservation, resumed with its use and
		// hold kept: the read counts it once, as the next write will.
		await publish(catalog(freePlan(3, "100")));
		const resumed = { granted: "100", consumed: "20", held: "30", available: "50" };
		const [customer] = await context.sql<Array<{ id: string }>>`
			SELECT id FROM customers WHERE billing_account_id = 'holder'
		`;
		const reads = async () => ({
			balance: await balance("holder"),
			summary: (await context.repository.getCustomerBillingSummary(project, "holder")).balances,
			projection: await readProjectionBalances(
				context.db as unknown as QueryExecutor,
				project.projectInstanceId,
				customer?.id ?? "",
			),
		});
		const expected = {
			balance: resumed,
			summary: [{ featureKey: "ai_credits", held: "30", available: "50" }],
			projection: [{ featureKey: "ai_credits", held: "30", available: "50" }],
		};
		expect(await reads()).toMatchObject(expected);
		await runWorker(25);
		expect(await reads()).toMatchObject(expected);

		await context.repository.releaseUsageReservation(project, {
			billingAccountId: "holder",
			reservationId: hold.reservationId ?? "",
			idempotencyKey: "release-1",
		});
		expect(await balance("holder")).toMatchObject({
			granted: "100",
			consumed: "20",
			held: "0",
			available: "80",
		});
		// The next usage write reopens that same row with its use kept.
		expect(await consume("holder", 10, "spend-2")).toMatchObject({
			allowed: true,
			balance: { available: "70" },
		});
		const rows = await allowanceRows("holder");
		expect(rows.map((row) => [Number(row.consumed), row.live])).toEqual([[30, true]]);
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

	it("reads a republished reset as the account's next write applies it, before the pass", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("reset_user", 30, "spend-1");
		// Version 2 resets weekly. The account's next write keeps the monthly allowance for the rest of
		// its window and starts the weekly reset where it ends, so a read answers with it already.
		const weekly = freePlan(2, "100");
		weekly.items = weekly.items.map((item) => ({ ...item, resetInterval: "week" as const }));
		await publish(catalog(weekly));

		const kept = { granted: "100", consumed: "30", available: "70" };
		expect(await balance("reset_user")).toMatchObject(kept);
		expect(
			(await context.repository.getCustomerBillingSummary(project, "reset_user")).balances,
		).toMatchObject([{ featureKey: "ai_credits", available: "70" }]);
		const [customer] = await context.sql<Array<{ id: string }>>`
			SELECT id FROM customers WHERE billing_account_id = 'reset_user'
		`;
		expect(
			await readProjectionBalances(
				context.db as unknown as QueryExecutor,
				project.projectInstanceId,
				customer?.id ?? "",
			),
		).toMatchObject([{ featureKey: "ai_credits", available: "70" }]);
		expect(await grants("reset_user")).toMatchObject([{ status: "active", plan_version: 1 }]);

		expect(await consume("reset_user", 10, "spend-2")).toMatchObject({
			allowed: true,
			balance: { granted: "100", available: "60" },
		});
		expect(await grants("reset_user")).toMatchObject([{ status: "active", plan_version: 2 }]);
		expect((await allowanceRows("reset_user")).map((row) => row.live)).toEqual([true]);
	});

	it("keeps a window's allowance through a reset change and starts the new reset at its end", async () => {
		const weekly = freePlan(1, "200");
		weekly.items = weekly.items.map((item) => ({ ...item, resetInterval: "week" as const }));
		await publish(catalog(weekly));
		await consume("reset_change", 169, "spend-1");
		expect(await balance("reset_change")).toMatchObject({ available: "31" });

		// Version 2 resets monthly. Changing the reset never refills the window: the weekly allowance
		// runs to its end, before and after the pass reaches the account.
		await publish(catalog(freePlan(2, "200")));
		const kept = { granted: "200", consumed: "169", available: "31" };
		expect(await balance("reset_change")).toMatchObject(kept);
		await runWorker(25);
		expect(await grants("reset_change")).toMatchObject([{ status: "active", plan_version: 2 }]);
		expect(await balance("reset_change")).toMatchObject(kept);
		expect(await consume("reset_change", 1, "spend-2")).toMatchObject({
			allowed: true,
			balance: { available: "30" },
		});
		expect(await consume("reset_change", 31, "spend-3")).toMatchObject({ allowed: false });
		expect((await allowanceRows("reset_change")).map((row) => row.live)).toEqual([true]);

		// A week later the weekly allowance has ended, and the monthly quantity starts where it ended.
		await context.sql`
			UPDATE plan_grants SET starts_at = starts_at - interval '7 days 1 minute'
			WHERE origin = 'default'
		`;
		await context.sql`
			UPDATE balance_allocations
			SET period_start_at = period_start_at - interval '7 days 1 minute',
				period_end_at = period_end_at - interval '7 days 1 minute',
				expires_at = expires_at - interval '7 days 1 minute'
			WHERE plan_grant_id IS NOT NULL
		`;
		expect(await balance("reset_change")).toMatchObject({
			granted: "200",
			consumed: "0",
			available: "200",
		});
		expect(await consume("reset_change", 10, "spend-4")).toMatchObject({
			allowed: true,
			balance: { available: "190" },
		});
		const [grant] = await grants("reset_change");
		const rows = await allowanceRows("reset_change");
		expect(rows.map((row) => [Number(row.consumed), row.live])).toEqual([
			[170, false],
			[10, true],
		]);
		expect(rows[1]?.period_start_at.getTime()).toBe(
			(grant?.starts_at.getTime() ?? 0) + 7 * 24 * 60 * 60 * 1000,
		);
	});

	it("reads an allowance and keys a republish adds, before the pass reaches the account", async () => {
		await publish(catalog({ ...freePlan(1, "100"), items: [] }));
		await seedCustomers(["adding_user"]);
		await runWorker(25);
		expect(await balance("adding_user")).toMatchObject({ available: "0" });

		await publish(catalog(freePlan(2, "100"), ["free_tier", "starter"]));

		expect(await balance("adding_user")).toMatchObject({ granted: "100", available: "100" });
		expect(
			await context.repository.checkUsage(project, {
				billingAccountId: "adding_user",
				featureKey: "model_tokens",
				quantity: "2000",
			}),
		).toMatchObject({ allowed: true });
		expect(
			(await entitlements("adding_user")).map((row) => [row.key, row.active, row.metadata.origin]),
		).toEqual([
			["free_tier", true, "default"],
			["starter", true, "default"],
		]);
		expect(await grants("adding_user")).toMatchObject([{ plan_version: 1 }]);

		expect(await consume("adding_user", 10, "spend-1")).toMatchObject({
			allowed: true,
			balance: { available: "90" },
		});
		expect((await entitlements("adding_user")).map((row) => [row.key, row.active])).toEqual([
			["free_tier", true],
			["starter", true],
		]);
	});

	it("reads a removed default plan as ended before the pass reaches the account", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("leaving_user", 30, "spend-1");

		await publish(catalog(null));

		expect(await balance("leaving_user")).toMatchObject({ granted: "0", available: "0" });
		expect(
			await context.repository.checkUsage(project, {
				billingAccountId: "leaving_user",
				featureKey: "model_tokens",
				quantity: "200",
			}),
		).toMatchObject({ allowed: false });
		// The write ends the grant, so the read already reports the entitlement as ended.
		const ended = [["free_tier", false, "ended"]];
		const entries = async () =>
			(await entitlements("leaving_user")).map((row) => [row.key, row.active, row.metadata.status]);
		expect(await entries()).toEqual(ended);
		expect(
			(await context.repository.getCustomerBillingSummary(project, "leaving_user")).balances,
		).toEqual([]);
		expect(await grants("leaving_user")).toMatchObject([{ status: "active" }]);

		expect(await consume("leaving_user", 1, "spend-2")).toMatchObject({ allowed: false });
		expect(await grants("leaving_user")).toMatchObject([{ status: "ended" }]);
		expect(await entries()).toEqual(ended);
	});

	it("reads a key the default plan drops as inactive, before and after the pass", async () => {
		await publish(catalog(freePlan(1, "100"), ["free_tier", "starter"]));
		await consume("dropping_user", 1, "spend-1");
		const entries = async () =>
			(await entitlements("dropping_user")).map((row) => [
				row.key,
				row.active,
				row.metadata.status,
			]);
		expect(await entries()).toEqual([
			["free_tier", true, "active"],
			["starter", true, "active"],
		]);

		await publish(catalog(freePlan(1, "100"), ["free_tier"]));
		// The grant keeps running without the key, so the entry reads inactive rather than ended.
		const dropped = [
			["free_tier", true, "active"],
			["starter", false, "inactive"],
		];
		expect(await entries()).toEqual(dropped);
		await runWorker(25);
		expect(await grants("dropping_user")).toMatchObject([
			{ status: "active", entitlement_keys: ["free_tier"] },
		]);
		expect(await entries()).toEqual(dropped);
		const stored = await context.sql<Array<{ key: string; status: string }>>`
			SELECT e.entitlement_key AS key, e.metadata->>'status' AS status
			FROM entitlements e
			JOIN customers c ON c.id = e.customer_id AND c.project_id = e.project_id
			WHERE c.billing_account_id = 'dropping_user'
			ORDER BY e.entitlement_key
		`;
		expect(stored).toEqual([
			{ key: "free_tier", status: "active" },
			{ key: "starter", status: "inactive" },
		]);
	});

	it("checks a republished meter limit and usage limit before the pass reaches the account", async () => {
		const limited = (version: number, meterLimit: string, usageLimit: string) => {
			const plan = freePlan(version, "100");
			plan.items.push({
				featureKey: "model_tokens",
				itemKind: "meter_limit",
				quantity: meterLimit,
				resetInterval: "day",
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
			});
			return {
				...plan,
				controls: [
					{
						controlKind: "usage_limit" as const,
						featureKey: "model_tokens",
						currency: null,
						limitValue: usageLimit,
						interval: "day" as const,
					},
				],
			};
		};
		const tokens = (quantity: string) =>
			context.repository.checkUsage(project, {
				billingAccountId: "tightened",
				featureKey: "model_tokens",
				quantity,
			});
		await publish({ ...catalog(limited(1, "1000", "900")), rateCards: [] });
		expect(
			await context.repository.consumeUsage(project, {
				billingAccountId: "tightened",
				featureKey: "model_tokens",
				quantity: "400",
				idempotencyKey: "spend-1",
			}),
		).toMatchObject({ allowed: true });

		// Version 2 lowers the meter limit below what the window used.
		await publish({ ...catalog(limited(2, "300", "900")), rateCards: [] });
		expect(await tokens("100")).toMatchObject({ allowed: false, reason: "insufficient_balance" });
		expect(
			await context.repository.getMeteringBalance(project, "tightened", "model_tokens"),
		).toMatchObject({ granted: "300", available: "0" });

		// Version 3 lowers the usage limit instead.
		await publish({ ...catalog(limited(3, "1000", "450")), rateCards: [] });
		expect(await tokens("100")).toMatchObject({ allowed: false, reason: "control_limit_exceeded" });
		expect(
			await context.repository.controlsEnterprise.listEffectiveControls(project, "tightened"),
		).toMatchObject([{ featureKey: "model_tokens", limitValue: "450", consumedValue: "400" }]);
		expect(await grants("tightened")).toMatchObject([{ plan_version: 1 }]);

		expect(
			await context.repository.consumeUsage(project, {
				billingAccountId: "tightened",
				featureKey: "model_tokens",
				quantity: "100",
				idempotencyKey: "spend-2",
			}),
		).toMatchObject({ allowed: false, reason: "control_limit_exceeded" });
		expect(await tokens("50")).toMatchObject({ allowed: true });
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

	it("answers an unknown account's billing summary and controls from the default plan", async () => {
		const controlsError = async () => {
			try {
				await context.repository.controlsEnterprise.listEffectiveControls(project, "stranger");
				return null;
			} catch (error) {
				return error;
			}
		};
		await publish(catalog(null));
		expect(await context.repository.getCustomerBillingSummary(project, "stranger")).toMatchObject({
			customerExists: false,
			balances: [],
		});
		expect(await controlsError()).toMatchObject({ code: "BILLING_ACCOUNT_NOT_FOUND" });

		await publish(
			catalog({
				...freePlan(1, "100"),
				controls: [
					{
						controlKind: "usage_limit",
						featureKey: "model_tokens",
						currency: null,
						limitValue: "300",
						interval: "day",
					},
				],
			}),
		);

		const summary = await context.repository.getCustomerBillingSummary(project, "stranger");
		expect(summary).toMatchObject({
			customerExists: false,
			subscriptions: [],
			balances: [{ featureKey: "ai_credits", available: "100", held: "0" }],
		});
		expect(
			await context.repository.controlsEnterprise.listEffectiveControls(project, "stranger"),
		).toMatchObject([
			{
				controlKind: "usage_limit",
				featureKey: "model_tokens",
				limitValue: "300",
				source: "plan_default",
				consumedValue: "0",
				remainingValue: "300",
			},
		]);
		expect(await balance("stranger")).toMatchObject({ granted: "100", available: "100" });
		expect(
			await context.sql`SELECT id FROM customers WHERE billing_account_id = 'stranger'`,
		).toHaveLength(0);
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

	it("applies the default plan's usage limit from an account's first write, and to a check before it", async () => {
		await publish(
			catalog({
				...freePlan(1, "100"),
				controls: [
					{
						controlKind: "usage_limit",
						featureKey: "model_tokens",
						currency: null,
						limitValue: "300",
						interval: "day",
					},
				],
			}),
		);

		const checked = await context.repository.checkUsage(project, {
			billingAccountId: "limited",
			featureKey: "model_tokens",
			quantity: "400",
		});
		expect(checked).toMatchObject({ allowed: false, reason: "control_limit_exceeded" });
		// The first write starts the grant in its own transaction; its controls apply at once.
		expect(await consume("limited", 2, "limited-first")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
		expect(await consume("limited", 1, "limited-second")).toMatchObject({ allowed: true });
		expect(await consume("limited", 1, "limited-third")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
	});

	it("keeps counting the default plan's usage limit when the plan is republished", async () => {
		const limited = (version: number) => ({
			...freePlan(version, "100"),
			controls: [
				{
					controlKind: "usage_limit" as const,
					featureKey: "model_tokens",
					currency: null,
					limitValue: "300",
					interval: "day" as const,
				},
			],
		});
		await publish(catalog(limited(1)));
		// Start the account on the default plan before counting its usage.
		await context.repository.grantAllocation(project, {
			billingAccountId: "steady",
			featureKey: "ai_credits",
			quantity: "1",
			sourceKind: "credit_grant",
			sourceKey: "steady-start",
		});
		expect(await consume("steady", 1, "steady-first")).toMatchObject({ allowed: true });
		expect(await consume("steady", 1, "steady-second")).toMatchObject({ allowed: false });

		// A republish moves the grant to a version whose control is a new policy.
		await publish(catalog(limited(2)));
		await runWorker(25);
		expect(await grants("steady")).toMatchObject([{ status: "active", plan_version: 2 }]);
		expect(await consume("steady", 1, "steady-after-republish")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
	});

	it("keeps an open reservation's exposure when an unchanged default control is republished", async () => {
		const limited = (version: number) => ({
			...freePlan(version, "100"),
			controls: [
				{
					controlKind: "usage_limit" as const,
					featureKey: "model_tokens",
					currency: null,
					limitValue: "100",
					interval: "day" as const,
				},
			],
		});
		await publish(catalog(limited(1)));
		const hold = await context.repository.reserveUsage(project, {
			billingAccountId: "republish-hold",
			featureKey: "model_tokens",
			quantity: "90",
			idempotencyKey: "republish-hold:reserve",
			expiresInSeconds: 300,
		});
		expect(hold.allowed).toBe(true);
		const extra = {
			billingAccountId: "republish-hold",
			featureKey: "model_tokens",
			quantity: "20",
		};
		expect(await context.repository.checkUsage(project, extra)).toMatchObject({ allowed: false });

		await publish(catalog(limited(2)));
		expect(await context.repository.checkUsage(project, extra)).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
		expect(
			await context.repository.consumeUsage(project, {
				...extra,
				idempotencyKey: "republish-hold:extra",
			}),
		).toMatchObject({ allowed: false, reason: "control_limit_exceeded" });
		expect(
			await context.repository.confirmUsageReservation(project, {
				billingAccountId: "republish-hold",
				reservationId: hold.reservationId ?? "",
				quantity: "90",
				idempotencyKey: "republish-hold:confirm",
			}),
		).toMatchObject({ allowed: true });
		expect(
			await context.repository.consumeUsage(project, {
				...extra,
				quantity: "10",
				idempotencyKey: "republish-hold:rest",
			}),
		).toMatchObject({ allowed: true });
		expect(await context.repository.checkUsage(project, { ...extra, quantity: "1" })).toMatchObject(
			{ allowed: false, reason: "control_limit_exceeded" },
		);
	});

	it("frees corrected usage after its default control is republished", async () => {
		const limited = (version: number) => ({
			...freePlan(version, "100"),
			controls: [
				{
					controlKind: "usage_limit" as const,
					featureKey: "model_tokens",
					currency: null,
					limitValue: "100",
					interval: "day" as const,
				},
			],
		});
		await publish(catalog(limited(1)));
		const original = await context.repository.consumeUsage(project, {
			billingAccountId: "republish-correct",
			featureKey: "model_tokens",
			quantity: "90",
			idempotencyKey: "republish-correct:before",
		});
		expect(original.allowed).toBe(true);
		await publish(catalog(limited(2)));
		expect(
			await context.repository.consumeUsage(project, {
				billingAccountId: "republish-correct",
				featureKey: "model_tokens",
				quantity: "10",
				idempotencyKey: "republish-correct:after",
			}),
		).toMatchObject({ allowed: true });

		await context.repository.correctUsage(project, {
			billingAccountId: "republish-correct",
			originalUsageEventId: original.usageEventId ?? "",
			originalRecordedAt: new Date(original.recordedAt ?? ""),
			quantity: "90",
			idempotencyKey: "republish-correct:refund",
			actor: "default-plan-test",
			reason: "full refund",
		});
		const freed = { billingAccountId: "republish-correct", featureKey: "model_tokens" };
		expect(
			await context.repository.checkUsage(project, { ...freed, quantity: "90" }),
		).toMatchObject({
			allowed: true,
		});
		expect(
			await context.repository.checkUsage(project, { ...freed, quantity: "91" }),
		).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
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

	it("recomputes an account's plan while a write holds a foreign-key lock on its customer", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("busy", 1, "busy-start");
		let finishWrite = () => {};
		const writeHeld = new Promise<void>((resolve) => {
			finishWrite = resolve;
		});
		let lockTaken = () => {};
		const locked = new Promise<void>((resolve) => {
			lockTaken = resolve;
		});
		// The key-share lock every insert referencing the customer takes through its foreign key.
		const write = context.sql.begin(async (tx) => {
			await tx`SELECT id FROM customers WHERE billing_account_id = 'busy' FOR KEY SHARE`;
			lockTaken();
			await writeHeld;
		});
		await locked;
		try {
			const outcome = await Promise.race([
				context.repository.recomputeCustomerEntitlements(project, "busy").then(() => "done"),
				Bun.sleep(3000).then(() => "blocked"),
			]);
			expect(outcome).toBe("done");
		} finally {
			finishWrite();
			await write;
		}
	});

	it("catches an account up to a new version while parallel writes spend, without deadlocking", async () => {
		await publish(catalog(freePlan(1, "100")));
		await consume("catcher", 1, "catch-up-start");
		// The pass has not reached the account, so each write below catches it up first.
		await publish(catalog(freePlan(2, "100")));

		const results = await Promise.all(
			Array.from({ length: 8 }, (_, index) => consume("catcher", 1, `catch-up-${index}`)),
		);

		expect(results.every((result) => result.allowed)).toBe(true);
		expect(await grants("catcher")).toMatchObject([{ status: "active", plan_version: 2 }]);
		expect(await balance("catcher")).toMatchObject({ consumed: "9", available: "91" });
	});

	it("keeps a non-consumable level when the default plan moves to a new version", async () => {
		const withProjects = (version: number, projects: string): CatalogIntent => {
			const base = catalog({
				...freePlan(version, "100"),
				items: [
					...freePlan(version, "100").items,
					{
						featureKey: "projects",
						itemKind: "allocation",
						quantity: projects,
						resetInterval: "month",
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
					},
				],
			});
			return {
				...base,
				features: [
					...base.features,
					{
						key: "projects",
						name: "Projects",
						kind: "metered",
						meterKind: "non_consumable",
						unit: "project",
						creditScale: 0,
						filterDimensions: [],
					},
				],
			};
		};
		const addProject = async (key: string) =>
			await context.repository.consumeUsage(project, {
				billingAccountId: "builder",
				featureKey: "projects",
				quantity: "1",
				idempotencyKey: key,
			});
		const projects = async () =>
			await context.repository.getMeteringBalance(project, "builder", "projects");

		await publish(withProjects(1, "5"));
		for (const n of [1, 2, 3, 4]) expect((await addProject(`project-${n}`)).allowed).toBe(true);

		// Version 2 allows three projects: the four in use stay, before and after the pass.
		await publish(withProjects(2, "3"));
		expect(await projects()).toMatchObject({ consumed: "4" });
		await runWorker(25);
		expect(await grants("builder")).toMatchObject([{ status: "active", plan_version: 2 }]);
		expect(await projects()).toMatchObject({ consumed: "4" });
	});
});
