import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ProjectInstanceContext } from "../../src/projects/context";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

// biome-ignore lint/suspicious/noExplicitAny: catalog bodies and responses are asserted field by field
type Json = Record<string, any>;

const feature = (key: string) => ({
	key,
	name: key,
	kind: "metered",
	meterKind: "consumable",
	unit: "credit",
	creditScale: 3,
	filterDimensions: [] as string[],
});

/** A priced plan that allocates `ai_credits`, sold through the seeded Stripe product. */
const sold: Json = {
	features: [feature("ai_credits")],
	plans: [
		{
			key: "premium",
			name: "Premium",
			version: 1,
			kind: "base",
			basePrice: {
				key: "premium_monthly",
				currency: "USD",
				unitAmountMinor: 999,
				billingUnits: "1",
				billingInterval: "month",
				minimumQuantity: 1,
				maximumQuantity: 1,
				taxBehavior: "exclusive",
				providerBindings: [{ productKey: "premium_monthly", provider: "stripe", channel: "web" }],
			},
			providerPriced: null,
			items: [
				{
					itemKind: "allocation",
					featureKey: "ai_credits",
					quantity: "1000",
					reset: { interval: "month", intervalCount: 1 },
				},
			],
		},
	],
	topups: [],
	rateCards: [],
};

/** The same project with the plan and its feature retired. */
const retired: Json = {
	features: [feature("other_credits")],
	plans: [],
	topups: [],
	rateCards: [],
	retiredFeatureKeys: ["ai_credits"],
	retiredPlanKeys: ["premium"],
};

localDescribe("retiring a feature", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	function operator(projectKey = "acme") {
		const { app, authHeaders } = createIntegrationApp({
			env: { ...context.env, rateLimit: { ...context.env.rateLimit, adminLimit: 1_000_000 } },
			repository: context.repository,
		});
		const headers = {
			...(authHeaders(projectKey) as Record<string, string>),
			"content-type": "application/json",
			"x-billing-actor": "retirement-test",
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
		};
		const call = async (path: string, init: RequestInit = {}) => {
			const response = await testRequest(app, path, { ...init, headers });
			return { status: response.status, body: (await response.json()) as Json };
		};
		const post = (path: string, body: unknown) =>
			call(path, { method: "POST", body: JSON.stringify(body) });
		return {
			call,
			preview: (catalog: Json, expectedRevision: number | null) =>
				post("/v1/admin/catalog/preview", { expectedRevision, catalog }),
			publish: (catalog: Json, previewToken: string, expectedRevision: number | null) =>
				post("/v1/admin/catalog/publish", { expectedRevision, previewToken, catalog }),
		};
	}

	async function subscribe(billingAccountId = "subscriber"): Promise<void> {
		const start = new Date();
		const end = new Date(start.getTime() + 30 * 86_400_000);
		await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
			billingAccountId,
			stripeCustomerId: `cus_${billingAccountId}`,
			stripeSubscriptionId: `sub_${billingAccountId}`,
			invoiceId: null,
			externalProductId: "prod_stripe_premium",
			externalPriceId: "price_premium_monthly",
			subscriptionStatus: "active",
			purchasedAt: start,
			startsAt: start,
			expiresAt: end,
			currentPeriodStart: start,
			currentPeriodEnd: end,
			autoRenew: true,
			rawPayload: {},
			eventType: "customer.subscription.updated",
			externalEventId: `evt_${billingAccountId}`,
			projectionReason: "provider_webhook",
			projectionIdempotencyKey: `evt_${billingAccountId}:projection`,
			providerEventCreated: 1,
		});
	}

	async function publishInitial(catalog: Json = sold, projectKey = "acme") {
		const api = operator(projectKey);
		const preview = await api.preview(catalog, null);
		expect(preview.status).toBe(200);
		expect((await api.publish(catalog, preview.body.data.previewToken, null)).status).toBe(200);
		return api;
	}

	function trial(billingAccountId = "trial", target: ProjectInstanceContext = project) {
		return context.repository.planGrants.startTrial(target, {
			billingAccountId,
			planKey: "premium",
			durationDays: 14,
			metadata: {},
			idempotencyKey: `start:${billingAccountId}`,
			actor: "retirement-test",
		});
	}

	function createPromotion(
		kind: "plan_grant" | "feature_grant",
		expiresAfterSeconds: number | null = 86_400,
		target: ProjectInstanceContext = project,
	) {
		return context.repository.promotions.createPromotion(target, {
			key: kind,
			name: kind,
			effect:
				kind === "plan_grant"
					? { kind, planKey: "premium", durationUnit: "day", durationCount: 14 }
					: { kind, items: [{ featureKey: "ai_credits", quantity: "25", expiresAfterSeconds }] },
			codes: [{ code: kind.replaceAll("_", "-") }],
			allowedChannels: ["web"],
			actor: "retirement-test",
		});
	}

	function redeem(code: string, billingAccountId = code, target: ProjectInstanceContext = project) {
		return context.repository.promotions.redeemPromotionCode(target, {
			billingAccountId,
			code: code.replaceAll("_", "-"),
			channel: "web",
			idempotencyKey: `redeem:${billingAccountId}`,
			actor: "retirement-test",
		});
	}

	function check(billingAccountId: string) {
		return context.repository.usageApi.check(project, {
			billingAccountId,
			featureId: "ai_credits",
			value: "1",
		});
	}

	function consume(billingAccountId: string, value = "1") {
		return context.repository.usageApi.consume(project, {
			billingAccountId,
			featureId: "ai_credits",
			value,
			operationId: `consume:${billingAccountId}`,
		});
	}

	function planHolder(origin: "trial" | "promotion", count = 1, planVersion = 1) {
		return { kind: "plan_grant", origin, planKey: "premium", planVersion, count };
	}

	async function expectBlocked(
		api: ReturnType<typeof operator>,
		holders: Json[],
		catalog: Json = retired,
		revision = 1,
	) {
		const result = await api.preview(catalog, revision);
		expect(result.status).toBe(409);
		expect(result.body.error).toMatchObject({
			code: "FEATURE_RETIREMENT_BLOCKED",
			details: { featureKey: "ai_credits", holders },
		});
		return result;
	}

	it("is refused while a live subscription still holds it, and allowed once it has ended", async () => {
		const { call, preview, publish } = operator();
		const first = await preview(sold, null);
		expect((await publish(sold, first.body.data.previewToken, null)).status).toBe(200);
		await subscribe();
		const balance = () => call("/v1/billing-accounts/subscriber/balances/ai_credits");
		expect((await balance()).body.data).toMatchObject({ available: "1000" });

		// Retiring the plan stops new sales, but its subscriber stays pinned to it and still holds
		// the feature: retiring that too would leave them with a balance they cannot read or spend.
		const blocked = {
			code: "FEATURE_RETIREMENT_BLOCKED",
			message:
				"Feature ai_credits cannot be retired: 1 live subscription still holds it through plan premium version 1; migrate them to a version without it, or retire it after they end",
			details: {
				featureKey: "ai_credits",
				holders: [{ kind: "subscription", planKey: "premium", planVersion: 1, count: 1 }],
			},
		};
		const refusedPreview = await preview(retired, 1);
		expect(refusedPreview.status).toBe(409);
		expect(refusedPreview.body.error).toMatchObject(blocked);
		// Publishing checks it again: a subscription may have started since the preview.
		await context.sql`UPDATE subscriptions SET status = 'expired' WHERE project_id = ${project.projectInstanceId}`;
		const allowedPreview = await preview(retired, 1);
		expect(allowedPreview.status).toBe(200);
		await context.sql`UPDATE subscriptions SET status = 'active' WHERE project_id = ${project.projectInstanceId}`;
		const refusedPublish = await publish(retired, allowedPreview.body.data.previewToken, 1);
		expect(refusedPublish.status).toBe(409);
		expect(refusedPublish.body.error).toMatchObject(blocked);
		expect((await balance()).body.data).toMatchObject({ available: "1000" });
		const [state] = await context.sql`
			SELECT (SELECT max(revision)::int FROM catalog_revisions) AS revision,
				(SELECT active FROM features WHERE key = 'ai_credits') AS feature_active`;
		expect(state).toEqual({ revision: 1, feature_active: true });

		// Retiring only the plan is still allowed: the feature stays, and so does the subscriber.
		const planOnly = { ...sold, plans: [], retiredPlanKeys: ["premium"] };
		const planPreview = await preview(planOnly, 1);
		expect(planPreview.status).toBe(200);
		expect((await publish(planOnly, planPreview.body.data.previewToken, 1)).status).toBe(200);
		expect((await balance()).body.data).toMatchObject({ available: "1000" });

		// Once the subscription has ended nobody holds the feature and it can go.
		await context.sql`UPDATE subscriptions SET status = 'expired' WHERE project_id = ${project.projectInstanceId}`;
		const featureOnly = { ...retired, retiredPlanKeys: [] };
		const lastPreview = await preview(featureOnly, 2);
		expect(lastPreview.status).toBe(200);
		expect((await publish(featureOnly, lastPreview.body.data.previewToken, 2)).status).toBe(200);
	});

	for (const origin of ["trial", "promotion"] as const) {
		for (const itemKind of ["allocation", "meter_limit", "unlimited_usage"] as const) {
			it(`protects a ${origin} grant's ${itemKind}, including after plan-only retirement`, async () => {
				const item = {
					itemKind,
					featureKey: "ai_credits",
					...(itemKind === "unlimited_usage"
						? {}
						: { quantity: "1000", reset: { interval: "month", intervalCount: 1 } }),
				};
				const catalog = { ...sold, plans: [{ ...sold.plans[0], items: [item] }] };
				const api = await publishInitial(catalog);
				if (origin === "trial") await trial(origin);
				else {
					await createPromotion("plan_grant");
					await redeem("plan_grant", origin);
				}
				expect((await check(origin)).allowed).toBe(true);
				const blocked = await expectBlocked(api, [planHolder(origin)]);
				expect(blocked.body.error.message).toContain(`1 live ${origin} plan grant`);
				expect((await consume(origin)).allowed).toBe(true);

				const planOnly = { ...catalog, plans: [], retiredPlanKeys: ["premium"] };
				const preview = await api.preview(planOnly, 1);
				expect(preview.status).toBe(200);
				expect((await api.publish(planOnly, preview.body.data.previewToken, 1)).status).toBe(200);
				expect((await check(origin)).allowed).toBe(true);
				await expectBlocked(api, [planHolder(origin)], { ...retired, retiredPlanKeys: [] }, 2);
			});
		}
	}

	it("protects a copied boolean entitlement even without a plan item", async () => {
		const boolean = { ...feature("premium"), kind: "boolean", meterKind: null, creditScale: 0 };
		const catalog = { ...sold, features: [...sold.features, boolean] };
		const api = await publishInitial(catalog);
		await createPromotion("plan_grant");
		await redeem("plan_grant");
		const input = { billingAccountId: "plan_grant", featureId: "premium" };
		expect(await context.repository.usageApi.check(project, input)).toMatchObject({
			allowed: true,
		});
		const result = await api.preview({ ...sold, retiredFeatureKeys: ["premium"] }, 1);
		expect(result.status).toBe(409);
		expect(result.body.error.details).toEqual({
			featureKey: "premium",
			holders: [planHolder("promotion")],
		});
		expect(await context.repository.usageApi.check(project, input)).toMatchObject({
			allowed: true,
		});
	});

	it("protects the grant's pinned older version after its plan is republished", async () => {
		const api = await publishInitial();
		await trial();
		const changed = {
			...sold,
			features: [...sold.features, feature("other_credits")],
			plans: [
				{
					...sold.plans[0],
					version: 2,
					items: [{ ...sold.plans[0].items[0], featureKey: "other_credits" }],
				},
			],
		};
		const preview = await api.preview(changed, 1);
		expect(preview.status).toBe(200);
		expect((await api.publish(changed, preview.body.data.previewToken, 1)).status).toBe(200);
		await expectBlocked(
			api,
			[planHolder("trial")],
			{
				...changed,
				features: [feature("other_credits")],
				retiredFeatureKeys: ["ai_credits"],
			},
			2,
		);
		expect((await check("trial")).allowed).toBe(true);
	});

	for (const kind of ["trial", "plan_grant", "feature_grant"] as const) {
		it(`rechecks a ${kind} created after preview before publishing`, async () => {
			const api = await publishInitial();
			const preview = await api.preview(retired, 1);
			expect(preview.status).toBe(200);
			if (kind === "trial") await trial(kind);
			else {
				await createPromotion(kind);
				await redeem(kind);
			}
			const result = await api.publish(retired, preview.body.data.previewToken, 1);
			expect(result.status).toBe(409);
			expect(result.body.error.code).toBe("FEATURE_RETIREMENT_BLOCKED");
			expect(result.body.error.details.holders).toEqual([
				kind === "feature_grant"
					? { kind: "promotion_feature_grant", promotionKey: "feature_grant", count: 1 }
					: planHolder(kind === "trial" ? "trial" : "promotion"),
			]);
			expect((await check(kind)).allowed).toBe(true);
			expect((await consume(kind)).allowed).toBe(true);
			const [state] = await context.sql`
				SELECT active, (SELECT max(revision)::int FROM catalog_revisions
					WHERE project_id = ${project.projectInstanceId}) AS revision
				FROM features WHERE project_id = ${project.projectInstanceId} AND key = 'ai_credits'
			`;
			expect(state).toEqual({ active: true, revision: 1 });
		});
	}

	for (const state of ["expired", "ended", "superseded", "elapsed"] as const) {
		it(`allows retirement after a grant is ${state}, without relying on maintenance`, async () => {
			const api = await publishInitial();
			const billingAccountId = state === "superseded" ? "subscriber" : "trial";
			const started = await trial(billingAccountId);
			if (state === "ended") {
				await context.repository.planGrants.endTrial(project, {
					billingAccountId,
					trialId: started.trial.id,
					reason: "Finished",
					idempotencyKey: "end",
					actor: "retirement-test",
				});
			} else if (state === "superseded") {
				await subscribe();
				await context.sql`UPDATE subscriptions SET status = 'expired' WHERE project_id = ${project.projectInstanceId}`;
			} else if (state === "elapsed") {
				await context.sql`
					UPDATE plan_grants SET starts_at = now() - interval '2 days', ends_at = now()
					WHERE project_id = ${project.projectInstanceId}
				`;
			} else {
				await context.sql`
					UPDATE plan_grants SET status = 'expired', starts_at = now() - interval '2 days',
						ends_at = now(), ended_at = now()
					WHERE project_id = ${project.projectInstanceId}
				`;
			}
			const [grant] = await context.sql`
				SELECT status FROM plan_grants WHERE project_id = ${project.projectInstanceId}
			`;
			expect(grant?.status).toBe(state === "elapsed" ? "active" : state);
			const preview = await api.preview(retired, 1);
			expect(preview.status).toBe(200);
			expect((await api.publish(retired, preview.body.data.previewToken, 1)).status).toBe(200);
		});
	}

	for (const expiresAfterSeconds of [null, 86_400]) {
		it(`protects ${expiresAfterSeconds === null ? "permanent" : "unexpired"} promotion credits, including archived and fully held ones`, async () => {
			const api = await publishInitial();
			await createPromotion("feature_grant", expiresAfterSeconds);
			await redeem("feature_grant");
			const holders = [
				{ kind: "promotion_feature_grant", promotionKey: "feature_grant", count: 1 },
			];
			const blocked = await expectBlocked(api, holders);
			expect(blocked.body.error.message).toContain(
				"1 redeemed feature grant from promotion feature_grant",
			);
			await context.repository.promotions.archivePromotion(
				project,
				"feature_grant",
				"retirement-test",
			);
			expect((await consume("feature_grant", "5")).allowed).toBe(true);
			const reservation = await context.repository.usageApi.reserve(project, {
				billingAccountId: "feature_grant",
				featureId: "ai_credits",
				value: "20",
				operationId: "hold-promotion",
			});
			expect(reservation.allowed).toBe(true);
			await expectBlocked(api, holders);
		});
	}

	for (const state of ["unredeemed", "expired", "consumed", "revoked"] as const) {
		it(`ignores ${state} feature promotions`, async () => {
			const api = await publishInitial();
			await createPromotion("feature_grant");
			if (state !== "unredeemed") {
				const result = await redeem("feature_grant");
				if (state === "expired") {
					await context.sql`
						UPDATE balance_allocations SET expires_at = now()
						WHERE project_id = ${project.projectInstanceId}
					`;
				} else if (state === "consumed") {
					expect((await consume("feature_grant", "25")).allowed).toBe(true);
				} else {
					await context.repository.promotions.revokePromotionRedemption(project, {
						redemptionId: result.redemption?.id ?? "",
						reason: "Withdrawn",
						idempotencyKey: "revoke",
						actor: "retirement-test",
					});
				}
			}
			const preview = await api.preview(retired, 1);
			expect(preview.status).toBe(200);
			expect((await api.publish(retired, preview.body.data.previewToken, 1)).status).toBe(200);
		});
	}

	it("reports distinct mixed holders in stable order for the first retired feature", async () => {
		const catalog = {
			...sold,
			features: [...sold.features, feature("z_credits")],
			plans: [
				{
					...sold.plans[0],
					items: [...sold.plans[0].items, { ...sold.plans[0].items[0], featureKey: "z_credits" }],
				},
			],
		};
		const api = await publishInitial(catalog);
		await subscribe();
		await subscribe("another-subscriber");
		await trial("first");
		await trial("second");
		await createPromotion("plan_grant");
		await redeem("plan_grant");
		// Matching both a copied entitlement and an item must still count each grant only once.
		await context.sql`
			UPDATE plan_grants SET entitlement_keys = ARRAY['ai_credits', 'z_credits']
			WHERE project_id = ${project.projectInstanceId}
		`;
		await createPromotion("feature_grant");
		await redeem("feature_grant", "bonus-first");
		await redeem("feature_grant", "bonus-second");
		const result = await expectBlocked(
			api,
			[
				planHolder("promotion"),
				planHolder("trial", 2),
				{ kind: "promotion_feature_grant", promotionKey: "feature_grant", count: 2 },
				{ kind: "subscription", planKey: "premium", planVersion: 1, count: 2 },
			],
			{ ...retired, retiredFeatureKeys: ["z_credits", "ai_credits"] },
		);
		expect(result.body.error.message).toContain("2 live trial plan grants");
		expect(result.body.error.message).toContain("2 redeemed feature grants");
	});

	it("does not count holders belonging to another project", async () => {
		const api = await publishInitial();
		await publishInitial(sold, "globex");
		const other = integrationProjectContext("globex");
		await trial("other-trial", other);
		await createPromotion("plan_grant", 86_400, other);
		await redeem("plan_grant", "other-promotion", other);
		await createPromotion("feature_grant", 86_400, other);
		await redeem("feature_grant", "other-credits", other);
		const preview = await api.preview(retired, 1);
		expect(preview.status).toBe(200);
		expect((await api.publish(retired, preview.body.data.previewToken, 1)).status).toBe(200);
		expect(
			await context.repository.usageApi.check(other, {
				billingAccountId: "other-trial",
				featureId: "ai_credits",
				value: "1",
			}),
		).toMatchObject({ allowed: true });
	});

	for (const removeMarker of [false, true]) {
		it(`preserves default-plan ${removeMarker ? "removal" : "feature updates"} before reconciliation`, async () => {
			const free = { ...sold.plans[0], basePrice: null, providerPriced: null };
			const catalog = {
				...sold,
				features: [...sold.features, feature("other_credits")],
				plans: [free],
				defaultPlan: { planKey: "premium", entitlementKeys: ["free_tier"] },
			};
			const api = await publishInitial(catalog);
			await context.repository.usageApi.createAccount(project, "free-holder");
			const changed = removeMarker
				? retired
				: {
						...catalog,
						features: [feature("other_credits")],
						plans: [
							{ ...free, version: 2, items: [{ ...free.items[0], featureKey: "other_credits" }] },
						],
						retiredFeatureKeys: ["ai_credits"],
					};
			const preview = await api.preview(changed, 1);
			expect(preview.status).toBe(200);
			expect((await api.publish(changed, preview.body.data.previewToken, 1)).status).toBe(200);
			const [grant] = await context.sql`
				SELECT origin, status FROM plan_grants WHERE project_id = ${project.projectInstanceId}
			`;
			expect(grant).toEqual({ origin: "default", status: "active" });
			expect(
				(await context.repository.getEntitlementSnapshot(project, "free-holder")).entitlements,
			).toMatchObject([{ key: "free_tier", active: !removeMarker }]);
		});
	}
});
