import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type {
	PromotionCodeRecord,
	PromotionRecord,
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
			projectInstanceKey: "voysee",
			projectionUrl: "https://voysee.example.com",
			projectionSecret: "voysee-projection-secret",
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
		addPromotionCodes: record("addPromotionCodes", { codes: [code], created: 1 }),
		listPromotionCodes: record("listPromotionCodes", { items: [code], nextCursor: null }),
		deactivatePromotionCode: record("deactivatePromotionCode", { ...code, active: false }),
		listPromotionRedemptions: record("listPromotionRedemptions", { items: [], nextCursor: null }),
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
				contexts: [projectInstanceContext("voysee")],
				credentials: { secret: "voysee" },
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

		expect(await list.json()).toMatchObject({
			data: [{ key: "spring-sale" }],
			pagination: { nextCursor: "next" },
		});
		expect(codes.status).toBe(200);
		expect(redemptions.status).toBe(200);
		expect((await deactivated.json()).data.active).toBe(false);
		expect((await archived.json()).data.status).toBe("archived");
		expect(calls.map((call) => [call.method, ...call.args])).toEqual([
			["listPromotions", { limit: 10, cursor: null, status: "active" }],
			["listPromotionCodes", "spring-sale", { limit: 25, cursor: null, active: false }],
			[
				"listPromotionRedemptions",
				"spring-sale",
				{ limit: 25, cursor: null, status: "applied", billingAccountId: "acct_1" },
			],
			["deactivatePromotionCode", "spring-sale", code.id, "operator@example.com"],
			["archivePromotion", "spring-sale", "operator@example.com"],
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
});
