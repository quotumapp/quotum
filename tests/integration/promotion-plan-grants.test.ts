import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import type { CreatePromotionInput } from "../../src/billing/promotions";
import type { AuthoredCatalogIntent, AuthoredPlanIntent } from "../../src/catalog/types";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { recordedEvents, subscribeToEveryEvent } from "./helpers/domain-event-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const actor = "operator@example.com";
const day = 86_400_000;
let context: LocalPostgresContext;
const allowance = (quantity: string) => ({
	featureKey: "ai_credits",
	itemKind: "allocation" as const,
	quantity,
	reset: {
		interval: "month" as const,
		intervalCount: 1,
	},
});
const plan = (key: string, extra: Partial<AuthoredPlanIntent> = {}): AuthoredPlanIntent => ({
	key,
	name: key,
	version: 1,
	trialDays: null,
	items: [allowance("50")],
	...extra,
});
/**
 * `premium` is bound to every store and allows 1000 credits a month; `starter` has no binding and
 * a seven-day trial; `boost` is an add-on; `free`, when marked, is the default plan.
 */
function catalog(options: { defaultPlan: boolean }): AuthoredCatalogIntent {
	return {
		...aiCreditsCatalog,
		plans: [
			...aiCreditsCatalog.plans,
			plan("starter", { trialDays: 7 }),
			plan("boost", { kind: "addon", items: [allowance("10")] }),
			...(options.defaultPlan ? [plan("free")] : []),
		],
		...(options.defaultPlan
			? { defaultPlan: { planKey: "free", entitlementKeys: ["free_tier"] } }
			: {}),
	};
}
localDescribe("Promotion plan grants integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("gives the plan for the promotion's term and replays the redemption", async () => {
		await publish({ defaultPlan: false });
		await promotion("premium-month", "premium", { unit: "month", count: 1 }, [
			{ code: "MONTH" },
			{ code: "OTHER" },
		]);
		await promotion("premium-days", "premium", { unit: "day", count: 30 }, [{ code: "DAYS" }]);
		const api = promotionApi();

		expect(await api.validate("reader", { code: "month" })).toMatchObject({
			valid: true,
			reason: null,
			promotion: { key: "premium-month", effectKind: "plan_grant" },
		});
		const redeemed = await api.redeem("reader", { code: "month", channel: "web" }, "redeem-1");
		expect(redeemed.status).toBe(200);
		const { redemption } = redeemed.body.data;
		const grant = redemption.planGrant;
		expect(redeemed.body.data).toMatchObject({ kind: "plan_granted", duplicate: false });
		expect(redemption).toMatchObject({
			promotionKey: "premium-month",
			code: "MONTH",
			billingAccountId: "reader",
			channel: "web",
			status: "applied",
			provider: "quotum",
			source: "api_redeem",
			actor: "billing-account:reader",
		});
		expect(grant).toMatchObject({
			planKey: "premium",
			planVersion: 1,
			status: "active",
			endedAt: null,
		});
		expect(grant.endsAt).toBe(addMonth(grant.startsAt));

		const replay = await api.redeem("reader", { code: "month", channel: "web" }, "redeem-1");
		expect(replay.status).toBe(200);
		expect(replay.body.data).toEqual({ ...redeemed.body.data, duplicate: true });
		const conflict = await api.redeem("reader", { code: "other", channel: "web" }, "redeem-1");
		expect([conflict.status, conflict.body.error?.code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);

		expect(
			(await api.get("/v1/billing-accounts/reader/entitlements")).body.data.entitlements,
		).toEqual([
			{
				key: "premium",
				active: true,
				expiresAt: grant.endsAt,
				metadata: {
					source: "plan_grant",
					origin: "promotion",
					status: "active",
					planKey: "premium",
					planGrantId: grant.id,
					promotionRedemptionId: redemption.id,
				},
			},
		]);
		expect(
			(await api.get("/v1/billing-accounts/reader/balances/ai_credits")).body.data,
		).toMatchObject({ granted: "1000", available: "1000" });
		expect(await projectionJob(context.sql, `plan_grant:${grant.id}:started`)).toMatchObject({
			reason: "usage_changed",
			payload: { reason: "usage_changed" },
		});
		expect(
			(await api.get(`/v1/billing-accounts/reader/promotion-redemptions/${redemption.id}`)).body
				.data,
		).toEqual(redemption);
		expect(await grantRows("reader")).toEqual([
			{
				origin: "promotion",
				status: "active",
				duration_unit: "month",
				duration_count: 1,
				promotion_redemption_id: redemption.id,
				actor: "billing-account:reader",
			},
		]);

		// Android redeems the same way, and a term in days is exact.
		const days = await api.redeem("droid", { code: "days", channel: "android" }, "redeem-1");
		const dayGrant = days.body.data.redemption.planGrant;
		expect(days.body.data.kind).toBe("plan_granted");
		expect(Date.parse(dayGrant.endsAt) - Date.parse(dayGrant.startsAt)).toBe(30 * day);
		expect(await uses()).toEqual({ DAYS: 1, MONTH: 1, OTHER: 0 });
	});

	it("refuses in validation and in redemption alike, and a refusal takes no use", async () => {
		await publish({ defaultPlan: true });
		const term = { unit: "day", count: 30 } as const;
		await promotion("premium-pass", "premium", term, [
			{ code: "PASS" },
			{ code: "PASS-TWO" },
			{ code: "PASS-OLD", expiresAt: "2026-01-01T00:00:00Z" },
			{ code: "PASS-VIP", billingAccountId: "vip" },
		]);
		await promotion("boost-pass", "boost", term, [{ code: "ADDON" }]);
		await promotion("free-pass", "free", term, [{ code: "DEFAULT" }]);
		const api = promotionApi();
		const both = async (billingAccountId: string, code: string, channel = "web") => {
			const validation = await api.validate(billingAccountId, { code, channel });
			const redeemed = await api.redeem(billingAccountId, { code, channel }, `refused-${code}`);
			expect(validation.valid).toBe(false);
			expect(redeemed.status).not.toBe(200);
			return [validation.reason, redeemed.body.error?.code];
		};
		const refused = (code: string) => [code, code];

		// The plan: an add-on and the default plan cannot be granted.
		expect(await both("fresh", "ADDON")).toEqual(refused("PROMOTION_PLAN_NOT_ELIGIBLE"));
		expect(await both("fresh", "DEFAULT")).toEqual(refused("PROMOTION_PLAN_NOT_ELIGIBLE"));

		// The account: a paid base plan, a trial and another promotional grant each refuse.
		await recordAppleSubscription("paying", { expiresInDays: 20 });
		expect(await both("paying", "PASS")).toEqual(refused("PROMOTION_BASE_PLAN_ACTIVE"));
		expect((await api.startTrial("trialing", { planKey: "starter" }, "trial")).status).toBe(201);
		expect(await both("trialing", "PASS")).toEqual(refused("PROMOTION_PLAN_GRANT_ACTIVE"));
		expect((await api.redeem("holder", { code: "PASS", channel: "web" }, "first")).status).toBe(
			200,
		);
		expect(await both("holder", "PASS-TWO")).toEqual(refused("PROMOTION_PLAN_GRANT_ACTIVE"));

		// The channel and the code answer before the plan does.
		expect(await both("fresh", "PASS", "ios")).toEqual(
			refused("PROMOTION_CODE_CHANNEL_NOT_SUPPORTED"),
		);
		expect(await both("paying", "PASS-OLD")).toEqual(refused("PROMOTION_CODE_EXPIRED"));
		expect(await both("holder", "PASS")).toEqual(refused("PROMOTION_CODE_ALREADY_REDEEMED"));
		expect(await both("fresh", "PASS-VIP")).toEqual(refused("PROMOTION_CODE_NOT_FOUND"));
		expect(
			await api.validate("fresh", { code: "PASS", target: { kind: "plan", key: "premium" } }),
		).toMatchObject({ valid: false, reason: "PROMOTION_CODE_NOT_APPLICABLE" });

		expect(await uses()).toEqual({
			ADDON: 0,
			DEFAULT: 0,
			PASS: 1,
			"PASS-OLD": 0,
			"PASS-TWO": 0,
			"PASS-VIP": 0,
		});
		const promotional = await context.sql<{ billing_account_id: string }[]>`
			SELECT c.billing_account_id
			FROM plan_grants g JOIN customers c ON c.id = g.customer_id
			WHERE g.origin = 'promotion'
		`;
		expect(promotional.map((row) => row.billing_account_id)).toEqual(["holder"]);
	});

	it("lets one of two concurrent redemptions through and gives the other its use back", async () => {
		await publish({ defaultPlan: false });
		await promotion("premium-pass", "premium", { unit: "day", count: 30 }, [
			{ code: "RACE-A" },
			{ code: "RACE-B" },
		]);
		const api = promotionApi();

		const results = await Promise.all([
			api.redeem("racer", { code: "RACE-A", channel: "web" }, "race-a"),
			api.redeem("racer", { code: "RACE-B", channel: "web" }, "race-b"),
		]);

		expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
		expect(results.find((result) => result.status === 409)?.body.error?.code).toBe(
			"PROMOTION_PLAN_GRANT_ACTIVE",
		);
		const taken = await uses();
		expect((taken["RACE-A"] ?? 0) + (taken["RACE-B"] ?? 0)).toBe(1);
		expect(await grantRows("racer")).toHaveLength(1);
	});

	it("keeps the plan's trial for later and refuses a trial while the grant runs", async () => {
		await publish({ defaultPlan: false });
		await promotion("premium-pass", "premium", { unit: "day", count: 30 }, [{ code: "PASS" }]);
		const api = promotionApi();
		const redeemed = await api.redeem("member", { code: "PASS", channel: "web" }, "redeem");
		const trial = { planKey: "premium", durationDays: 14 };

		const during = await api.startTrial("member", trial, "trial-during");
		expect([during.status, during.body.error?.code]).toEqual([409, "TRIAL_ALREADY_ACTIVE"]);
		expect(
			(await api.get("/v1/billing-accounts/member/trial-eligibility?planKey=premium")).body.data,
		).toMatchObject({ eligible: false, reason: "TRIAL_ALREADY_ACTIVE" });

		expect((await api.revoke(redeemed.body.data.redemption.id, "revoke")).status).toBe(200);
		const after = await api.startTrial("member", trial, "trial-after");
		expect(after.status).toBe(201);
		expect(after.body.data.trial).toMatchObject({ planKey: "premium", status: "active" });
	});

	it("supersedes the default plan and returns it when the redemption is revoked", async () => {
		await publish({ defaultPlan: true });
		await promotion("premium-pass", "premium", { unit: "month", count: 3 }, [{ code: "PASS" }]);
		const api = promotionApi();
		expect((await api.createAccount("member")).status).toBe(200);
		expect(await grantRows("member")).toMatchObject([{ origin: "default", status: "active" }]);

		const redeemed = await api.redeem("member", { code: "PASS", channel: "web" }, "redeem");
		const { redemption } = redeemed.body.data;
		expect(await grantRows("member")).toMatchObject([
			{ origin: "default", status: "superseded" },
			{ origin: "promotion", status: "active", duration_unit: "month", duration_count: 3 },
		]);
		const [superseded] = await context.sql<{ superseded_by_plan_grant_id: string }[]>`
			SELECT superseded_by_plan_grant_id FROM plan_grants WHERE origin = 'default'
		`;
		expect(superseded?.superseded_by_plan_grant_id).toBe(redemption.planGrant.id);
		expect(await activeKeys(api, "member")).toEqual(["premium"]);
		await spend("member", "spend-1");
		expect(
			(await api.get("/v1/billing-accounts/member/balances/ai_credits")).body.data,
		).toMatchObject({ granted: "1000", available: "990" });

		const revoked = await api.revoke(redemption.id, "revoke-1");
		expect(revoked.status).toBe(200);
		expect(revoked.body.data).toMatchObject({
			duplicate: false,
			redemption: {
				status: "reversed",
				planGrant: { id: redemption.planGrant.id, status: "ended" },
			},
			reversedAllocations: [],
		});
		const ended = revoked.body.data.redemption.planGrant;
		expect(Date.parse(ended.endedAt)).toBeLessThan(Date.parse(ended.endsAt));
		expect((await api.revoke(redemption.id, "revoke-1")).body.data).toEqual({
			...revoked.body.data,
			duplicate: true,
		});
		const again = await api.revoke(redemption.id, "revoke-2");
		expect([again.status, again.body.error?.code]).toEqual([
			409,
			"PROMOTION_REDEMPTION_ALREADY_REVERSED",
		]);
		const [row] = await context.sql<{ end_actor: string; end_reason: string }[]>`
			SELECT end_actor, end_reason FROM plan_grants WHERE origin = 'promotion'
		`;
		expect(row).toMatchObject({ end_actor: actor, end_reason: "Abuse report" });
		expect(await projectionJob(context.sql, `plan_grant:${ended.id}:ended`)).toMatchObject({
			reason: "usage_changed",
			payload: {
				planGrant: {
					event: "ended",
					origin: "promotion",
					planGrantId: ended.id,
					planKey: "premium",
					promotionRedemptionId: redemption.id,
					startsAt: ended.startsAt,
					endsAt: ended.endedAt,
				},
			},
		});

		// The grant's allowance stops with it, and the default plan answers again at once.
		expect(await activeKeys(api, "member")).toEqual(["free_tier"]);
		expect(
			(await api.get("/v1/billing-accounts/member/balances/ai_credits")).body.data,
		).toMatchObject({ granted: "50", available: "50" });
		await spend("member", "spend-2");
		expect(await grantRows("member")).toMatchObject([
			{ origin: "default", status: "superseded" },
			{ origin: "promotion", status: "ended" },
			{ origin: "default", status: "active" },
		]);
	});

	it("gives way to a paid plan, expires at its end, and leaves repeats to the code's limits", async () => {
		await subscribeToEveryEvent(context.sql, project.projectInstanceId);
		await publish({ defaultPlan: false });
		await promotion("premium-pass", "premium", { unit: "day", count: 30 }, [
			{ code: "PASS" },
			{ code: "PASS-TWO" },
		]);
		const api = promotionApi();
		const read = async (billingAccountId: string, redemptionId: string) =>
			(
				await api.get(
					`/v1/billing-accounts/${billingAccountId}/promotion-redemptions/${redemptionId}`,
				)
			).body.data.planGrant;

		// A paid base subscription takes over at once, and the grant's allowance stops.
		const converting = (await api.redeem("converter", { code: "PASS", channel: "web" }, "redeem"))
			.body.data.redemption;
		await spend("converter", "spend-1");
		await recordAppleSubscription("converter", { expiresInDays: 30 });
		expect(await read("converter", converting.id)).toMatchObject({ status: "superseded" });
		const [reward] = await context.sql<{ expired: boolean }[]>`
			SELECT expires_at <= now() AS expired FROM balance_allocations
			WHERE plan_grant_id = ${converting.planGrant.id}::uuid
		`;
		expect(reward?.expired).toBe(true);
		expect(
			(await api.get("/v1/billing-accounts/converter/entitlements")).body.data.entitlements[0],
		).toMatchObject({ active: true, metadata: { source: "subscription", provider: "apple" } });

		// No fact follows the conversion: the customer moved to a paid plan.
		const facts = await context.sql<{ count: string }[]>`
			SELECT count(*)::text AS count FROM projection_sync_jobs WHERE payload ? 'planGrant'
		`;
		expect(facts[0]?.count).toBe("0");

		// Within three days of its end the grant sends one ending notice.
		const lapsing = (await api.redeem("lapser", { code: "PASS", channel: "web" }, "redeem")).body
			.data.redemption;
		const grantId = lapsing.planGrant.id;
		await shiftGrant(grantId, -28);
		expect((await context.repository.enqueueTrialEndingNotices(25)).noticedTrials).toBe(1);
		expect((await context.repository.enqueueTrialEndingNotices(25)).noticedTrials).toBe(0);
		const noticed = await read("lapser", lapsing.id);
		expect(
			await projectionJob(context.sql, `plan_grant_ending:${grantId}:${noticed.endsAt}`),
		).toMatchObject({
			reason: "expiry_reconciliation",
			payload: {
				planGrant: {
					event: "ending",
					origin: "promotion",
					planGrantId: grantId,
					promotionRedemptionId: lapsing.id,
					endsAt: noticed.endsAt,
				},
			},
		});

		// Past its end the grant reads expired before the worker records it.
		await shiftGrant(grantId, -3);
		expect(await read("lapser", lapsing.id)).toMatchObject({ status: "expired" });
		expect((await context.repository.reconcilePlanGrants(25)).expiredPlanGrants).toBe(1);
		const expired = await read("lapser", lapsing.id);
		expect(expired).toMatchObject({ status: "expired", endedAt: expired.endsAt });
		expect(
			(
				await projectionJob(
					context.sql,
					`expiry_reconciliation:plan_grant:${grantId}:${expired.endsAt}`,
				)
			)?.payload.planGrant,
		).toMatchObject({ event: "ended", origin: "promotion", planGrantId: grantId });
		expect(await activeKeys(api, "lapser")).toEqual([]);
		// Webhook endpoints get the same two facts; the conversion sends neither.
		const grantEvents = [
			...(await recordedEvents(context.sql, project.projectInstanceId, "plan_grant.ending")),
			...(await recordedEvents(context.sql, project.projectInstanceId, "plan_grant.ended")),
		];
		expect(grantEvents.map((recorded) => recorded.type)).toEqual([
			"plan_grant.ending",
			"plan_grant.ended",
		]);
		for (const recorded of grantEvents) {
			expect(recorded.data).toMatchObject({
				planGrant: { origin: "promotion", planGrantId: grantId, promotionRedemptionId: lapsing.id },
			});
			expect(recorded.envelope.billingAccountId).toBe("lapser");
		}
		// The Apple purchase that converted the other account is a subscription event of its own.
		expect(
			await recordedEvents(context.sql, project.projectInstanceId, "subscription.activated"),
		).toHaveLength(1);

		// Revoking a redemption whose grant is over reverses the redemption and leaves the grant.
		for (const [account, redemptionId, status] of [
			["converter", converting.id, "superseded"],
			["lapser", lapsing.id, "expired"],
		] as const) {
			const revoked = await api.revoke(redemptionId, `revoke-${account}`);
			expect(revoked.body.data).toMatchObject({
				redemption: { status: "reversed", planGrant: { status } },
				reversedAllocations: [],
			});
		}

		// The same code is used up for the account; another code of the promotion gives the plan again.
		const same = await api.redeem("lapser", { code: "PASS", channel: "web" }, "same");
		expect([same.status, same.body.error?.code]).toEqual([409, "PROMOTION_CODE_ALREADY_REDEEMED"]);
		const second = await api.redeem("lapser", { code: "PASS-TWO", channel: "web" }, "second");
		expect(second.body.data).toMatchObject({
			kind: "plan_granted",
			redemption: { planGrant: { status: "active" } },
		});
	});
});

async function publish(options: { defaultPlan: boolean }): Promise<void> {
	const intent = catalog(options);
	const preview = await context.repository.previewCatalog(project, {
		expectedRevision: null,
		actor: "promotion-plan-grants",
		catalog: intent,
	});
	await context.repository.publishCatalog(project, {
		expectedRevision: null,
		actor: "promotion-plan-grants",
		previewToken: preview.previewToken,
		catalog: intent,
	});
}

async function promotion(
	key: string,
	planKey: string,
	term: { unit: "day" | "month"; count: number },
	codes: NonNullable<CreatePromotionInput["codes"]>,
): Promise<void> {
	await context.repository.promotions.createPromotion(project, {
		key,
		name: key,
		effect: { kind: "plan_grant", planKey, durationUnit: term.unit, durationCount: term.count },
		codes,
		actor,
	});
}

function promotionApi() {
	const { app, authHeaders } = createIntegrationApp({
		env: context.env,
		repository: context.repository,
	});
	const headers = authHeaders("acme");
	const json = async (response: Response) => ({
		status: response.status,
		// biome-ignore lint/suspicious/noExplicitAny: test responses are asserted field by field
		body: (await response.json()) as any,
	});
	const post = async (path: string, body: unknown, extra: Record<string, string> = {}) =>
		json(
			await testRequest(app, path, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json", ...extra },
				body: JSON.stringify(body),
			}),
		);
	return {
		validate: async (billingAccountId: string, body: Record<string, unknown>) => {
			const response = await post(
				`/v1/billing-accounts/${billingAccountId}/promotion-codes/validate`,
				body,
			);
			expect(response.status).toBe(200);
			return response.body.data;
		},
		redeem: (billingAccountId: string, body: Record<string, unknown>, key: string) =>
			post(`/v1/billing-accounts/${billingAccountId}/promotion-redemptions`, body, {
				"idempotency-key": key,
			}),
		revoke: (redemptionId: string, key: string) =>
			post(
				`/v1/admin/promotion-redemptions/${redemptionId}/revoke`,
				{ reason: "Abuse report" },
				{
					"x-billing-operator-key": context.env.operatorApiKey ?? "",
					"x-billing-actor": actor,
					"idempotency-key": key,
				},
			),
		startTrial: (billingAccountId: string, body: Record<string, unknown>, key: string) =>
			post(`/v1/billing-accounts/${billingAccountId}/trials`, body, { "idempotency-key": key }),
		createAccount: async (billingAccountId: string) =>
			json(
				await testRequest(app, `/v1/billing-accounts/${billingAccountId}`, {
					method: "PUT",
					headers,
				}),
			),
		get: async (path: string) => json(await testRequest(app, path, { headers })),
	};
}

async function activeKeys(
	api: ReturnType<typeof promotionApi>,
	billingAccountId: string,
): Promise<string[]> {
	const response = await api.get(`/v1/billing-accounts/${billingAccountId}/entitlements`);
	return (response.body.data.entitlements as Array<{ key: string; active: boolean }>)
		.filter((entitlement) => entitlement.active)
		.map((entitlement) => entitlement.key);
}

/** Uses taken per code, redeemed or reserved. */
async function uses(): Promise<Record<string, number>> {
	const rows = await context.sql<{ code: string; used: number }[]>`
		SELECT normalized_code AS code, (redeemed_count + reserved_count)::integer AS used
		FROM promotion_codes ORDER BY normalized_code
	`;
	return Object.fromEntries(rows.map((row) => [row.code, row.used]));
}

/** Plain rows, oldest first: Bun's result array carries extra properties matchers compare. */
async function grantRows(billingAccountId: string) {
	const rows = await context.sql<
		Array<{
			origin: string;
			status: string;
			duration_unit: string | null;
			duration_count: number | null;
			promotion_redemption_id: string | null;
			actor: string;
		}>
	>`
		SELECT g.origin, g.status, g.duration_unit, g.duration_count, g.promotion_redemption_id, g.actor
		FROM plan_grants g JOIN customers c ON c.id = g.customer_id
		WHERE c.billing_account_id = ${billingAccountId}
		ORDER BY g.created_at, g.starts_at
	`;
	return rows.map((row) => ({ ...row }));
}

async function recordAppleSubscription(
	billingAccountId: string,
	input: { expiresInDays: number },
): Promise<void> {
	const now = Math.floor(Date.now() / 1000) * 1000;
	const expiresAt = new Date(now + input.expiresInDays * day);
	await context.repository.recordStoreKitTransactionAndEnqueueProjection(project, {
		billingAccountId,
		appAccountToken: null,
		channel: "ios",
		externalProductId: "premium_monthly",
		purchaseKind: "subscription",
		transactionId: `${billingAccountId}_transaction`,
		originalTransactionId: `${billingAccountId}_original`,
		webOrderLineItemId: `${billingAccountId}_line`,
		purchaseStatus: "completed",
		subscriptionStatus: "active",
		purchasedAt: new Date(expiresAt.getTime() - 30 * day),
		expiresAt,
		trialStart: null,
		trialEnd: null,
		autoRenew: true,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: { fixture: billingAccountId },
		eventType: "SUBSCRIBED",
		externalEventId: `${billingAccountId}_event`,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${billingAccountId}:projection`,
	});
}

/** Moves a grant and its allowances by whole days, as if that much time had passed. */
async function shiftGrant(grantId: string, days: number): Promise<void> {
	await context.sql`
		UPDATE plan_grants
		SET starts_at = starts_at + ${days} * interval '1 day',
			ends_at = ends_at + ${days} * interval '1 day'
		WHERE id = ${grantId}::uuid
	`;
	await context.sql`
		UPDATE balance_allocations
		SET period_start_at = period_start_at + ${days} * interval '1 day',
			period_end_at = period_end_at + ${days} * interval '1 day',
			expires_at = expires_at + ${days} * interval '1 day'
		WHERE plan_grant_id = ${grantId}::uuid
	`;
}

/** Spends ten credits of the account's allowance. */
async function spend(billingAccountId: string, idempotencyKey: string): Promise<void> {
	const result = await context.repository.consumeUsage(project, {
		billingAccountId,
		featureKey: "model_tokens",
		quantity: "2000",
		idempotencyKey,
	});
	expect(result.allowed).toBe(true);
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
	const dayOfMonth = date.getUTCDate();
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() + 1);
	const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
	date.setUTCDate(Math.min(dayOfMonth, last));
	return date.toISOString();
}
