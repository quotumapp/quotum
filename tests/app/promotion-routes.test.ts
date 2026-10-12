import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type {
	GiftRecord,
	PromotionCodeRecord,
	PromotionRecord,
	PromotionRedemptionRecord,
	PromotionServiceLike,
} from "../../src/billing/promotions";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	postgresPreparedStatements: true,
	authMode: "api_key",
	operatorApiKey: "operator-secret-key",
	trustGatewayProjectHeader: false,
	connectionFixtures: [
		{
			projectInstanceKey: "acme",
			projectionUrl: "https://acme.example.com",
			projectionSecret: "acme-projection-secret",
		},
	],
	runtimeEnvironment: "development",
	workerId: "worker-a",
	workerPollIntervalMs: 5000,
	projectionSyncMaxAttempts: 10,
	storeEventReplayMaxAttempts: 10,
	storeEventReplayPollIntervalMs: 5000,
	subscriptionReconciliationMaxAttempts: 10,
	subscriptionReconciliationPollIntervalMs: 60000,
	providerReconciliationStaleAfterMs: 21600000,
	meteringMaintenancePollIntervalMs: 60000,
	rateLimit: {
		windowMs: 60000,
		verifyLimit: 2,
		webhookLimit: 600,
		adminLimit: 60,
		meteringLimit: 6000,
		trustProxyHeaders: false,
	},
	sentry: {
		dsn: null,
		environment: "test",
		release: null,
		enableLogs: true,
		tracesSampleRate: 0.01,
		logLevel: "warn",
		captureExpectedErrors: false,
	},
};

const operatorHeaders = {
	authorization: "Bearer secret",
	"x-billing-operator-key": "operator-secret-key",
	"x-billing-actor": "operator@example.com",
	"content-type": "application/json",
};

const promotion: PromotionRecord = {
	id: "11111111-1111-4111-8111-111111111111",
	key: "spring-sale",
	name: "Spring sale",
	status: "active",
	effect: {
		kind: "discount",
		discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
	},
	targets: [{ kind: "plan", key: "pro" }],
	allowedChannels: ["web", "ios", "android"],
	metadata: {},
	termsHash: "a".repeat(64),
	createdBy: "operator@example.com",
	createdAt: "2026-09-16T00:00:00.000Z",
	archivedBy: null,
	archivedAt: null,
	codeCounts: { total: 1, active: 1 },
	redemptionCounts: { reserved: 0, applied: 0, released: 0, reversed: 0 },
	providerObjects: [],
};

const code: PromotionCodeRecord = {
	id: "22222222-2222-4222-8222-222222222222",
	promotionKey: "spring-sale",
	code: "SPRING",
	active: true,
	startsAt: null,
	expiresAt: null,
	maxRedemptions: 100,
	maxRedemptionsPerCustomer: 1,
	firstPurchaseOnly: false,
	billingAccountId: null,
	hostedCheckoutEnabled: false,
	redeemedCount: 0,
	reservedCount: 0,
	createdBy: "operator@example.com",
	createdAt: "2026-09-16T00:00:00.000Z",
	deactivatedBy: null,
	deactivatedAt: null,
	gift: null,
};

const gift: GiftRecord = {
	purchaseId: "44444444-4444-4444-8444-444444444444",
	productKey: "gift_12m",
	purchasedAt: "2026-10-12T12:00:00.000Z",
	reversedAt: null,
	reversalReason: null,
	codes: [
		{
			code: "K7Q2-M9XD-4TRW-P8HB-3NCF",
			status: "available",
			expiresAt: "2028-10-12T12:00:00.000Z",
			redeemedAt: null,
		},
		{
			code: "W3NF-8HCV-2JTA-R6KD-5MPQ",
			status: "redeemed",
			expiresAt: "2028-10-12T12:00:00.000Z",
			redeemedAt: "2026-10-20T08:14:09.000Z",
		},
	],
};

const redemption: PromotionRedemptionRecord = {
	id: "33333333-3333-4333-8333-333333333333",
	promotionKey: "launch-credits",
	promotionCodeId: code.id,
	code: "LAUNCH",
	billingAccountId: "acct_1",
	channel: "web",
	status: "applied",
	provider: "quotum",
	source: "api_redeem",
	stripeCheckoutSessionId: null,
	externalSubscriptionId: null,
	currency: null,
	amountSubtotalMinor: null,
	amountDiscountMinor: null,
	amountTotalMinor: null,
	limitViolation: null,
	actor: "billing-account:acct_1",
	reason: null,
	reservedUntil: null,
	appliedAt: "2026-09-16T00:00:00.000Z",
	releasedAt: null,
	reversedAt: null,
	createdAt: "2026-09-16T00:00:00.000Z",
};

function recordingService() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	let created = true;
	const record = <T>(method: string, result: T) =>
		(async (_project: unknown, ...args: unknown[]) => {
			calls.push({ method, args });
			return result;
		}) as never;
	const service: PromotionServiceLike = {
		createPromotion: (async (_project: unknown, input: unknown) => {
			calls.push({ method: "createPromotion", args: [input] });
			const result = { promotion, created };
			created = false;
			return result;
		}) as never,
		getPromotion: record("getPromotion", promotion),
		listPromotions: record("listPromotions", { items: [promotion], nextCursor: "next" }),
		archivePromotion: record("archivePromotion", { ...promotion, status: "archived" }),
		updatePromotionTerms: record("updatePromotionTerms", { ...promotion, name: "Spring sale 2" }),
		addPromotionCodes: record("addPromotionCodes", { codes: [code], created: 1 }),
		listPromotionCodes: record("listPromotionCodes", { items: [code], nextCursor: null }),
		deactivatePromotionCode: record("deactivatePromotionCode", { ...code, active: false }),
		listPromotionRedemptions: record("listPromotionRedemptions", { items: [], nextCursor: null }),
		requestPromotionProviderSync: record("requestPromotionProviderSync", promotion),
		redeemPromotionCode: record("redeemPromotionCode", {
			kind: "granted",
			duplicate: false,
			redemption,
			grant: {
				features: [
					{
						featureKey: "ai_tokens",
						quantity: "1000",
						expiresAt: null,
						allocationId: "41",
					},
				],
			},
		}),
		listAccountRedemptions: record("listAccountRedemptions", {
			items: [redemption],
			nextCursor: null,
		}),
		listAccountGifts: record("listAccountGifts", { items: [gift], nextCursor: "next" }),
		getAccountRedemption: record("getAccountRedemption", redemption),
		revokePromotionRedemption: record("revokePromotionRedemption", {
			duplicate: false,
			redemption: {
				...redemption,
				status: "reversed",
				reversedAt: "2026-09-17T00:00:00.000Z",
			},
			reversedAllocations: [
				{
					allocationId: "41",
					featureKey: "ai_tokens",
					reversedQuantity: "600",
					consumedQuantity: "400",
					heldQuantity: "0",
					expired: false,
				},
			],
		}),
		validatePromotionCode: record("validatePromotionCode", {
			valid: true,
			reason: null,
			promotion: {
				key: "spring-sale",
				name: "Spring sale",
				effectKind: "discount",
				allowedChannels: ["web", "ios", "android"],
			},
			code: { id: code.id, code: "SPRING", expiresAt: null, hostedCheckoutEnabled: false },
		}),
	};
	return { service, calls };
}

function promotionApp(service: PromotionServiceLike) {
	return withOpenApiAssertions(
		createApp({
			env,
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("acme")],
				credentials: {
					secret: "acme",
					"read-key": { projectInstanceKey: "acme", access: "read_only" },
				},
			}),
			promotionService: service,
		}),
	);
}

const createBody = {
	key: "spring-sale",
	name: "Spring sale",
	effect: {
		kind: "discount",
		discount: { type: "percent", percentOffBps: 2000, duration: "once" },
	},
	targets: [{ kind: "plan", key: "pro" }],
	codes: [{ code: "SPRING", maxRedemptions: 100 }],
};

describe("promotion routes", () => {
	it("creates promotions with 201 and replays with 200 using the operator actor", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const request = () =>
			testRequest(app, "/v1/admin/promotions", {
				method: "POST",
				headers: operatorHeaders,
				body: JSON.stringify(createBody),
			});

		const first = await request();
		const replay = await request();

		expect(first.status).toBe(201);
		expect(replay.status).toBe(200);
		expect((await first.json()).data.key).toBe("spring-sale");
		expect(calls[0]).toEqual({
			method: "createPromotion",
			args: [
				{
					...createBody,
					effect: {
						kind: "discount",
						discount: {
							type: "percent",
							percentOffBps: 2000,
							duration: "once",
							durationMonths: null,
						},
					},
					codes: [{ code: "SPRING", maxRedemptions: 100 }],
					actor: "operator@example.com",
				},
			],
		});
	});

	it("requires an actor and rejects unknown fields and project selectors", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;

		const missingActor = await testRequest(app, "/v1/admin/promotions", {
			method: "POST",
			headers: withoutActor,
			body: JSON.stringify(createBody),
		});
		const unknownField = await testRequest(app, "/v1/admin/promotions", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ ...createBody, stripeCouponId: "co_123" }),
		});
		const selector = await testRequest(app, "/v1/admin/promotions", {
			method: "POST",
			headers: operatorHeaders,
			body: JSON.stringify({ ...createBody, projectId: "other" }),
		});

		expect(missingActor.status).toBe(400);
		expect(unknownField.status).toBe(400);
		expect(selector.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("changes terms with the operator actor and rejects empty, unknown and selector bodies", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const update = (body: unknown, headers: Record<string, string> = operatorHeaders) =>
			testRequest(app, "/v1/admin/promotions/spring-sale/terms", {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;

		const changed = await update({
			name: "Spring sale 2",
			metadata: { campaign: "spring" },
			discount: { type: "percent", percentOffBps: 1500, duration: "repeating", durationMonths: 3 },
		});
		const nameOnly = await update({ name: "Spring sale 2" });
		const empty = await update({});
		const unknown = await update({ name: "Spring", targets: [] });
		const selector = await update({ name: "Spring", projectId: "other" });
		const badDiscount = await update({
			discount: { type: "percent", percentOffBps: 0, duration: "once" },
		});
		const missingActor = await update({ name: "Spring" }, withoutActor);
		const missingOperatorKey = await update(
			{ name: "Spring" },
			{ authorization: "Bearer secret", "content-type": "application/json" },
		);

		expect(changed.status).toBe(200);
		expect((await changed.json()).data.name).toBe("Spring sale 2");
		expect(nameOnly.status).toBe(200);
		expect([empty, unknown, selector, badDiscount, missingActor].map((r) => r.status)).toEqual([
			400, 400, 400, 400, 400,
		]);
		expect([401, 403]).toContain(missingOperatorKey.status);
		expect(calls).toEqual([
			{
				method: "updatePromotionTerms",
				args: [
					"spring-sale",
					{
						name: "Spring sale 2",
						metadata: { campaign: "spring" },
						discount: {
							type: "percent",
							percentOffBps: 1500,
							duration: "repeating",
							durationMonths: 3,
						},
					},
					"operator@example.com",
				],
			},
			{
				method: "updatePromotionTerms",
				args: ["spring-sale", { name: "Spring sale 2" }, "operator@example.com"],
			},
		]);
	});

	it("maps list filters, code deactivation and redemption queries to the service", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const get = (path: string) => testRequest(app, path, { headers: operatorHeaders });

		const list = await get("/v1/admin/promotions?limit=10&status=active");
		const codes = await get("/v1/admin/promotions/spring-sale/codes?active=false");
		const redemptions = await get(
			"/v1/admin/promotions/spring-sale/redemptions?status=applied&billingAccountId=acct_1",
		);
		const deactivated = await testRequest(
			app,
			`/v1/admin/promotions/spring-sale/codes/${code.id}/deactivate`,
			{ method: "POST", headers: operatorHeaders },
		);
		const archived = await testRequest(app, "/v1/admin/promotions/spring-sale/archive", {
			method: "POST",
			headers: operatorHeaders,
		});
		const synced = await testRequest(app, "/v1/admin/promotions/spring-sale/provider-sync", {
			method: "POST",
			headers: operatorHeaders,
		});

		expect(await list.json()).toMatchObject({
			data: [{ key: "spring-sale" }],
			pagination: { nextCursor: "next" },
		});
		expect(codes.status).toBe(200);
		expect(redemptions.status).toBe(200);
		expect((await deactivated.json()).data.active).toBe(false);
		expect((await archived.json()).data.status).toBe("archived");
		expect(synced.status).toBe(200);
		expect(calls.map((call) => [call.method, ...call.args])).toEqual([
			["listPromotions", { limit: 10, cursor: null, status: "active" }],
			[
				"listPromotionCodes",
				"spring-sale",
				{ limit: 25, cursor: null, active: false, source: null },
			],
			[
				"listPromotionRedemptions",
				"spring-sale",
				{ limit: 25, cursor: null, status: "applied", billingAccountId: "acct_1" },
			],
			["deactivatePromotionCode", "spring-sale", code.id, "operator@example.com"],
			["archivePromotion", "spring-sale", "operator@example.com"],
			["requestPromotionProviderSync", "spring-sale", "operator@example.com"],
		]);
	});

	it("validates codes with project credentials only, defaulting to the web channel", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const validate = (body: unknown) =>
			testRequest(app, "/v1/billing-accounts/acct_1/promotion-codes/validate", {
				method: "POST",
				headers: { authorization: "Bearer secret", "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const response = await validate({ code: "spring", target: { kind: "plan", key: "pro" } });
		const malformed = await validate({ code: "no spaces" });
		const limited = await validate({ code: "SPRING" });

		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({ valid: true, reason: null });
		expect(malformed.status).toBe(400);
		expect(limited.status).toBe(429);
		expect(calls).toEqual([
			{
				method: "validatePromotionCode",
				args: [
					{
						billingAccountId: "acct_1",
						code: "spring",
						channel: "web",
						target: { kind: "plan", key: "pro" },
					},
				],
			},
		]);
	});

	it("redeems codes with a required idempotency key and limits only code entry", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const backend = { authorization: "Bearer secret", "content-type": "application/json" };
		const redeem = (
			headers: Record<string, string>,
			body: unknown = { code: "launch", channel: "web" },
		) =>
			testRequest(app, "/v1/billing-accounts/acct_1/promotion-redemptions", {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

		const reads = await Promise.all(
			[1, 2, 3].map(() =>
				testRequest(app, "/v1/billing-accounts/acct_1/promotion-redemptions?limit=5", {
					headers: backend,
				}),
			),
		);
		const detail = await testRequest(
			app,
			`/v1/billing-accounts/acct_1/promotion-redemptions/${redemption.id}`,
			{ headers: backend },
		);
		const missingKey = await redeem(backend);
		const granted = await redeem({
			...backend,
			"idempotency-key": "redeem-1",
			"x-billing-actor": "user:42",
		});
		const limited = await redeem({ ...backend, "idempotency-key": "redeem-2" });

		expect(reads.map((response) => response.status)).toEqual([200, 200, 200]);
		expect((await reads[0]?.json())?.data).toEqual([redemption]);
		expect((await detail.json()).data.id).toBe(redemption.id);
		expect(missingKey.status).toBe(400);
		expect(granted.status).toBe(200);
		expect((await granted.json()).data).toMatchObject({
			kind: "granted",
			grant: { features: [{ featureKey: "ai_tokens", quantity: "1000" }] },
		});
		expect(limited.status).toBe(429);
		expect(calls.map((call) => [call.method, ...call.args])).toEqual([
			["listAccountRedemptions", "acct_1", { limit: 5, cursor: null }],
			["listAccountRedemptions", "acct_1", { limit: 5, cursor: null }],
			["listAccountRedemptions", "acct_1", { limit: 5, cursor: null }],
			["getAccountRedemption", "acct_1", redemption.id],
			[
				"redeemPromotionCode",
				{
					billingAccountId: "acct_1",
					code: "launch",
					channel: "web",
					idempotencyKey: "redeem-1",
					actor: "user:42",
				},
			],
		]);
	});

	it("lists the gifts an account bought, for a project key only", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const backend = { authorization: "Bearer secret" };
		const readOnlyBackend = { authorization: "Bearer read-key" };
		const path = "/v1/billing-accounts/acct_1/gifts?limit=5&cursor=abc";

		const read = await testRequest(app, path, { headers: backend });
		const readOnly = await testRequest(app, path, { headers: readOnlyBackend });
		const unfiltered = await testRequest(app, "/v1/billing-accounts/acct_1/gifts", {
			headers: backend,
		});
		const badLimit = await testRequest(app, "/v1/billing-accounts/acct_1/gifts?limit=0", {
			headers: backend,
		});

		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({
			success: true,
			data: [gift],
			pagination: { nextCursor: "next" },
		});
		expect(readOnly.status).toBe(403);
		expect((await readOnly.json()).error.code).toBe("READ_ONLY_CREDENTIAL");
		expect(unfiltered.status).toBe(200);
		expect(badLimit.status).toBe(400);
		expect(calls.map((call) => [call.method, ...call.args])).toEqual([
			["listAccountGifts", "acct_1", { limit: 5, cursor: "abc" }],
			["listAccountGifts", "acct_1", { limit: 25, cursor: null }],
		]);
	});

	it("filters an operator's codes by where they came from", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);

		const response = await testRequest(
			app,
			"/v1/admin/promotions/spring-sale/codes?source=gift&active=true",
			{ headers: operatorHeaders },
		);
		const invalid = await testRequest(app, "/v1/admin/promotions/spring-sale/codes?source=other", {
			headers: operatorHeaders,
		});

		expect(response.status).toBe(200);
		expect(invalid.status).toBe(400);
		expect(calls.map((call) => [call.method, ...call.args])).toEqual([
			[
				"listPromotionCodes",
				"spring-sale",
				{ limit: 25, cursor: null, active: true, source: "gift" },
			],
		]);
	});

	it("revokes redemptions only with the operator key, an actor and an idempotency key", async () => {
		const { service, calls } = recordingService();
		const app = promotionApp(service);
		const path = `/v1/admin/promotion-redemptions/${redemption.id}/revoke`;
		const revoke = (headers: Record<string, string>) =>
			testRequest(app, path, {
				method: "POST",
				headers,
				body: JSON.stringify({ reason: "Fraudulent signup" }),
			});
		const { "x-billing-operator-key": _key, ...withoutOperator } = operatorHeaders;
		const { "x-billing-actor": _actor, ...withoutActor } = operatorHeaders;

		const noOperator = await revoke({ ...withoutOperator, "idempotency-key": "revoke-1" });
		const noActor = await revoke({ ...withoutActor, "idempotency-key": "revoke-1" });
		const noKey = await revoke(operatorHeaders);
		const revoked = await revoke({ ...operatorHeaders, "idempotency-key": "revoke-1" });

		expect(noOperator.status).toBe(401);
		expect(noActor.status).toBe(400);
		expect(noKey.status).toBe(400);
		expect(revoked.status).toBe(200);
		expect((await revoked.json()).data.reversedAllocations).toEqual([
			expect.objectContaining({ reversedQuantity: "600", consumedQuantity: "400" }),
		]);
		expect(calls).toEqual([
			{
				method: "revokePromotionRedemption",
				args: [
					{
						redemptionId: redemption.id,
						reason: "Fraudulent signup",
						actor: "operator@example.com",
						idempotencyKey: "revoke-1",
					},
				],
			},
		]);
	});
});
