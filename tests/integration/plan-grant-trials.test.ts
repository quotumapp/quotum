import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { CatalogIntent } from "../../src/catalog/types";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog } from "./helpers/metering-catalog";
import { integrationProjectReadOnlyCredential } from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

const allowanceItem = (quantity: string) => ({
	featureKey: "ai_credits",
	itemKind: "allocation" as const,
	quantity,
	resetInterval: "month" as const,
	expiresAfterSeconds: null,
	overagePolicy: "blocked" as const,
});

/**
 * `premium` is bound to every store and declares no trial length; `starter` has no binding and a
 * seven-day trial; `boost` is an add-on.
 */
const trialCatalog: CatalogIntent = {
	...aiCreditsCatalog,
	plans: [
		...aiCreditsCatalog.plans,
		{
			key: "starter",
			name: "Starter",
			version: 1,
			currency: "USD",
			baseAmountMinor: 0,
			billingInterval: "month",
			trialDays: 7,
			items: [allowanceItem("50")],
			providerBindings: [],
		},
		{
			key: "boost",
			name: "Boost",
			version: 1,
			currency: "USD",
			baseAmountMinor: 0,
			billingInterval: "month",
			trialDays: null,
			kind: "addon",
			items: [allowanceItem("10")],
			providerBindings: [],
		},
	],
};

localDescribe("Plan grant trials integration", () => {
	const project = integrationProjectContext();

	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		const preview = await context.repository.previewCatalog(project, {
			expectedRevision: null,
			actor: "plan-grant-trials",
			catalog: trialCatalog,
		});
		await context.repository.publishCatalog(project, {
			expectedRevision: null,
			actor: "plan-grant-trials",
			previewToken: preview.previewToken,
			catalog: trialCatalog,
		});
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("starts a trial once, replays it, and grants the plan's entitlements and allowances", async () => {
		const api = trialApi();

		const started = await api.start(
			"trial_user",
			{ planKey: "premium", durationDays: 14 },
			"start-1",
		);
		expect(started.status).toBe(201);
		const trial = started.body.data.trial;
		expect(started.body.data.duplicate).toBe(false);
		expect(trial).toMatchObject({
			billingAccountId: "trial_user",
			planKey: "premium",
			planVersion: 1,
			status: "active",
			durationDays: 14,
			entitlementKeys: ["premium"],
			endedAt: null,
			supersededBy: null,
			actor: "billing-account:trial_user",
		});
		expect(Date.parse(trial.endsAt) - Date.parse(trial.startsAt)).toBe(14 * 86_400_000);

		const replay = await api.start(
			"trial_user",
			{ planKey: "premium", durationDays: 14 },
			"start-1",
		);
		expect(replay.status).toBe(200);
		expect(replay.body.data).toEqual({ duplicate: true, trial });
		const conflict = await api.start(
			"trial_user",
			{ planKey: "premium", durationDays: 7 },
			"start-1",
		);
		expect({ status: conflict.status, code: conflict.body.error?.code }).toEqual({
			status: 409,
			code: "IDEMPOTENCY_CONFLICT",
		});

		const entitlements = await api.get("/v1/billing-accounts/trial_user/entitlements");
		expect(entitlements.body.data.entitlements).toEqual([
			{
				key: "premium",
				active: true,
				expiresAt: trial.endsAt,
				metadata: {
					source: "plan_grant",
					origin: "trial",
					status: "active",
					planKey: "premium",
					planGrantId: trial.id,
					trialStartsAt: trial.startsAt,
					trialEndsAt: trial.endsAt,
				},
			},
		]);
		const balance = await api.get("/v1/billing-accounts/trial_user/balances/ai_credits");
		expect(balance.body.data).toMatchObject({ granted: "1000", available: "1000" });
		expect(await projectionJob(context.sql, `plan_grant:${trial.id}:started`)).toMatchObject({
			reason: "usage_changed",
			payload: { reason: "usage_changed" },
		});

		expect((await api.get("/v1/billing-accounts/trial_user/trials")).body).toEqual({
			success: true,
			data: [trial],
			pagination: { nextCursor: null },
		});
		expect((await api.get(`/v1/billing-accounts/trial_user/trials/${trial.id}`)).body.data).toEqual(
			trial,
		);
	});

	it("refuses trials the account or plan is not eligible for", async () => {
		const api = trialApi();
		const code = async (
			billingAccountId: string,
			body: Record<string, unknown>,
			key: string,
		): Promise<[number, string | undefined]> => {
			const response = await api.start(billingAccountId, body, key);
			return [response.status, response.body.error?.code];
		};

		expect(await code("fresh_user", { planKey: "premium" }, "no-length")).toEqual([
			400,
			"TRIAL_DURATION_REQUIRED",
		]);
		expect(await code("fresh_user", { planKey: "boost", durationDays: 7 }, "addon")).toEqual([
			409,
			"TRIAL_PLAN_NOT_ELIGIBLE",
		]);
		expect(await code("fresh_user", { planKey: "missing", durationDays: 7 }, "missing")).toEqual([
			404,
			"BILLING_PLAN_NOT_FOUND",
		]);

		// The plan's own trial length applies when the request names none.
		const starter = await api.start("fresh_user", { planKey: "starter" }, "starter");
		expect(starter.status).toBe(201);
		expect(starter.body.data.trial.durationDays).toBe(7);
		expect(await code("fresh_user", { planKey: "premium", durationDays: 7 }, "second")).toEqual([
			409,
			"TRIAL_ALREADY_ACTIVE",
		]);

		await recordAppleSubscription("paying_user", { expiresInDays: 20, trial: false });
		expect(await code("paying_user", { planKey: "starter" }, "paying")).toEqual([
			409,
			"TRIAL_BASE_PLAN_ACTIVE",
		]);

		// A lapsed App Store subscription that began with a free trial used up the plan's trial.
		await recordAppleSubscription("lapsed_user", { expiresInDays: -3, trial: true });
		expect(await code("lapsed_user", { planKey: "premium", durationDays: 7 }, "lapsed")).toEqual([
			409,
			"TRIAL_ALREADY_USED",
		]);
		expect(
			(await api.get("/v1/billing-accounts/lapsed_user/trial-eligibility?planKey=starter")).body
				.data,
		).toEqual({ planKey: "starter", eligible: true, reason: null, defaultDurationDays: 7 });
		expect(
			(await api.get("/v1/billing-accounts/lapsed_user/trial-eligibility?planKey=premium")).body
				.data,
		).toEqual({
			planKey: "premium",
			eligible: false,
			reason: "TRIAL_ALREADY_USED",
			defaultDurationDays: null,
		});
	});

	it("lets exactly one of two concurrent starts through", async () => {
		const api = trialApi();

		const results = await Promise.all([
			api.start("racer", { planKey: "premium", durationDays: 14 }, "race-a"),
			api.start("racer", { planKey: "starter" }, "race-b"),
		]);

		expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
		expect(results.find((result) => result.status === 409)?.body.error?.code).toBe(
			"TRIAL_ALREADY_ACTIVE",
		);
		const [grants] = await context.sql<{ count: string }[]>`
			SELECT count(*)::text AS count FROM plan_grants WHERE status = 'active'
		`;
		expect(grants?.count).toBe("1");
	});

	it("lets a read-only credential read trials but not start one", async () => {
		const api = trialApi();
		await api.start("reader", { planKey: "starter" }, "start");
		const { app } = createIntegrationApp({ env: context.env, repository: context.repository });
		const readOnly = { authorization: `Bearer ${integrationProjectReadOnlyCredential("voysee")}` };

		const list = await testRequest(app, "/v1/billing-accounts/reader/trials", {
			headers: readOnly,
		});
		expect(list.status).toBe(200);
		expect((await list.json()).data).toHaveLength(1);
		const start = await testRequest(app, "/v1/billing-accounts/reader/trials", {
			method: "POST",
			headers: { ...readOnly, "content-type": "application/json", "idempotency-key": "ro" },
			body: JSON.stringify({ planKey: "premium", durationDays: 7 }),
		});
		expect(start.status).toBe(403);
		expect((await start.json()).error.code).toBe("READ_ONLY_CREDENTIAL");
	});

	it("ends a trial early, idempotently, and never lets the account trial the plan again", async () => {
		const api = trialApi();
		const trial = (await api.start("ender", { planKey: "premium", durationDays: 14 }, "start")).body
			.data.trial;

		const ended = await api.end("ender", trial.id, { reason: "Converted offline" }, "end-1");
		expect(ended.status).toBe(200);
		expect(ended.body.data.trial).toMatchObject({
			status: "ended",
			endReason: "Converted offline",
		});
		expect(Date.parse(ended.body.data.trial.endedAt)).toBeLessThan(Date.parse(trial.endsAt));
		expect(
			(await api.end("ender", trial.id, { reason: "Converted offline" }, "end-1")).body.data
				.duplicate,
		).toBe(true);
		const again = await api.end("ender", trial.id, {}, "end-2");
		expect({ status: again.status, code: again.body.error?.code }).toEqual({
			status: 409,
			code: "TRIAL_NOT_ACTIVE",
		});

		const entitlements = await api.get("/v1/billing-accounts/ender/entitlements");
		expect(entitlements.body.data.entitlements[0]?.active).toBe(false);
		const balance = await api.get("/v1/billing-accounts/ender/balances/ai_credits");
		expect(balance.body.data.available).toBe("0");
		expect(
			(await projectionJob(context.sql, `plan_grant:${trial.id}:ended`))?.payload.trial,
		).toEqual({
			event: "ended",
			source: "plan_grant",
			planGrantId: trial.id,
			planKey: "premium",
			trialStartsAt: trial.startsAt,
			trialEndsAt: ended.body.data.trial.endedAt,
			autoRenew: false,
		});

		const retry = await api.start("ender", { planKey: "premium", durationDays: 14 }, "start-again");
		expect({ status: retry.status, code: retry.body.error?.code }).toEqual({
			status: 409,
			code: "TRIAL_ALREADY_USED",
		});
	});

	it("gives way to a paid subscription at once and sends no trial fact", async () => {
		const api = trialApi();
		const trial = (await api.start("converter", { planKey: "premium", durationDays: 14 }, "start"))
			.body.data.trial;

		await recordAppleSubscription("converter", { expiresInDays: 30, trial: false });

		const superseded = (await api.get(`/v1/billing-accounts/converter/trials/${trial.id}`)).body
			.data;
		expect(superseded).toMatchObject({
			status: "superseded",
			supersededBy: { provider: "apple", externalSubscriptionId: "converter_original" },
		});
		const entitlements = await api.get("/v1/billing-accounts/converter/entitlements");
		expect(entitlements.body.data.entitlements[0]).toMatchObject({
			active: true,
			metadata: { source: "subscription", provider: "apple" },
		});
		const [reward] = await context.sql<{ expired: boolean }[]>`
			SELECT expires_at <= now() AS expired FROM balance_allocations WHERE plan_grant_id = ${trial.id}::uuid
		`;
		expect(reward?.expired).toBe(true);
		const facts = await context.sql<{ count: string }[]>`
			SELECT count(*)::text AS count FROM projection_sync_jobs WHERE payload ? 'trial'
		`;
		expect(facts[0]?.count).toBe("0");
	});

	it("materializes later windows, notices the end once, and expires the trial", async () => {
		const api = trialApi();
		const trial = (await api.start("long_user", { planKey: "premium", durationDays: 60 }, "start"))
			.body.data.trial;
		const [grant] = await context.sql<{ next_period_at: Date | null }[]>`
			SELECT next_period_at FROM plan_grants WHERE id = ${trial.id}::uuid
		`;
		expect(grant?.next_period_at).toEqual(new Date(addMonth(trial.startsAt)));

		// Forty days later the second, clamped window has begun.
		await shiftGrant(trial.id, -40);
		expect(await context.repository.reconcilePlanGrants(25)).toEqual({
			expiredPlanGrants: 0,
			planGrantPeriods: 1,
		});
		const windows = await context.sql<{ period_end_at: Date }[]>`
			SELECT period_end_at FROM balance_allocations
			WHERE plan_grant_id = ${trial.id}::uuid ORDER BY period_start_at
		`;
		expect(windows).toHaveLength(2);
		expect(await context.repository.reconcilePlanGrants(25)).toEqual({
			expiredPlanGrants: 0,
			planGrantPeriods: 0,
		});

		// Within three days of the end, one ending notice.
		await shiftGrant(trial.id, -18);
		expect((await context.repository.enqueueTrialEndingNotices(25)).noticedTrials).toBe(1);
		expect((await context.repository.enqueueTrialEndingNotices(25)).noticedTrials).toBe(0);
		const [shifted] = await context.sql<{ starts_at: Date; ends_at: Date }[]>`
			SELECT starts_at, ends_at FROM plan_grants WHERE id = ${trial.id}::uuid
		`;
		if (shifted === undefined) throw new Error("grant missing");
		const ending = await projectionJob(
			context.sql,
			`trial_ending:plan_grant:${trial.id}:${shifted.ends_at.toISOString()}`,
		);
		expect(ending).toMatchObject({
			reason: "expiry_reconciliation",
			payload: {
				trial: {
					event: "ending",
					source: "plan_grant",
					planGrantId: trial.id,
					trialEndsAt: shifted.ends_at.toISOString(),
					autoRenew: false,
				},
			},
		});

		// After the end, the worker records the expiry with an ended fact.
		await shiftGrant(trial.id, -3);
		expect(
			(await api.get(`/v1/billing-accounts/long_user/trials/${trial.id}`)).body.data.status,
		).toBe("expired");
		expect(await context.repository.reconcilePlanGrants(25)).toEqual({
			expiredPlanGrants: 1,
			planGrantPeriods: 0,
		});
		const [expired] = await context.sql<{ status: string; ends_at: Date }[]>`
			SELECT status, ends_at FROM plan_grants WHERE id = ${trial.id}::uuid
		`;
		expect(expired?.status).toBe("expired");
		expect(
			(
				await projectionJob(
					context.sql,
					`expiry_reconciliation:plan_grant:${trial.id}:${expired?.ends_at.toISOString()}`,
				)
			)?.payload.trial,
		).toMatchObject({ event: "ended", source: "plan_grant", planGrantId: trial.id });
	});
});

function trialApi() {
	const { app, authHeaders } = createIntegrationApp({
		env: context.env,
		repository: context.repository,
	});
	const headers = authHeaders("voysee");
	const json = async (response: Response) => ({
		status: response.status,
		// biome-ignore lint/suspicious/noExplicitAny: test responses are asserted field by field
		body: (await response.json()) as any,
	});
	return {
		start: async (billingAccountId: string, body: Record<string, unknown>, key: string) =>
			json(
				await testRequest(app, `/v1/billing-accounts/${billingAccountId}/trials`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
					body: JSON.stringify(body),
				}),
			),
		end: async (
			billingAccountId: string,
			trialId: string,
			body: Record<string, unknown>,
			key: string,
		) =>
			json(
				await testRequest(app, `/v1/billing-accounts/${billingAccountId}/trials/${trialId}/end`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
					body: JSON.stringify(body),
				}),
			),
		get: async (path: string) => json(await testRequest(app, path, { headers })),
	};
}

async function recordAppleSubscription(
	billingAccountId: string,
	input: { expiresInDays: number; trial: boolean },
): Promise<void> {
	const day = 86_400_000;
	const now = Math.floor(Date.now() / 1000) * 1000;
	const expiresAt = new Date(now + input.expiresInDays * day);
	const purchasedAt = new Date(expiresAt.getTime() - 30 * day);
	await context.repository.recordStoreKitTransactionAndEnqueueProjection(
		integrationProjectContext(),
		{
			billingAccountId,
			appAccountToken: null,
			channel: "ios",
			externalProductId: "premium_monthly",
			purchaseKind: "subscription",
			transactionId: `${billingAccountId}_transaction`,
			originalTransactionId: `${billingAccountId}_original`,
			webOrderLineItemId: `${billingAccountId}_line`,
			purchaseStatus: "completed",
			subscriptionStatus: input.expiresInDays > 0 ? "active" : "expired",
			purchasedAt,
			expiresAt,
			trialStart: input.trial ? purchasedAt : null,
			trialEnd: input.trial ? expiresAt : null,
			autoRenew: input.expiresInDays > 0,
			invalidatedAt: null,
			invalidationReason: null,
			rawPayload: { fixture: billingAccountId },
			eventType: "SUBSCRIBED",
			externalEventId: `${billingAccountId}_event`,
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: `${billingAccountId}:projection`,
		},
	);
}

/** Moves a grant and its pending window by whole days, as if that much time had passed. */
async function shiftGrant(grantId: string, days: number): Promise<void> {
	await context.sql`
		UPDATE plan_grants
		SET starts_at = starts_at + ${days} * interval '1 day',
			ends_at = ends_at + ${days} * interval '1 day',
			next_period_at = next_period_at + ${days} * interval '1 day'
		WHERE id = ${grantId}::uuid
	`;
}

async function projectionJob(
	sql: SQL,
	idempotencyKey: string,
	// biome-ignore lint/suspicious/noExplicitAny: payloads are asserted field by field
): Promise<{ reason: string; payload: any } | undefined> {
	const rows = await sql<{ reason: string; payload: unknown }[]>`
		SELECT reason, payload FROM projection_sync_jobs WHERE idempotency_key = ${idempotencyKey}
	`;
	return rows[0];
}

function addMonth(iso: string): string {
	const date = new Date(iso);
	const day = date.getUTCDate();
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() + 1);
	const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
	date.setUTCDate(Math.min(day, last));
	return date.toISOString();
}
