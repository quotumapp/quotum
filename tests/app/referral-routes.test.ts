import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import type { ReferralServiceLike } from "../../src/billing/referrals";
import { createNoopBillingLogger } from "../../src/observability/logger";
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
		verifyLimit: 3,
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

const project = projectInstanceContext("acme");
const programRecord = {
	key: "friends",
	name: "Refer a friend",
	status: "active" as const,
	rewardPromotionKey: "reward",
	trigger: "redemption" as const,
	recipient: "referrer" as const,
	maxRewardsPerReferrer: null,
	targets: [],
	excludeTrial: true,
	createdBy: "support@example.com",
	createdAt: "2026-11-01T00:00:00.000Z",
	archivedBy: null,
	archivedAt: null,
};
const referralRecord = {
	id: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e10",
	programKey: "friends",
	role: "referee" as const,
	counterpartBillingAccountId: "alice",
	status: "qualified" as const,
	qualifiedAt: "2026-11-01T00:00:00.000Z",
	createdAt: "2026-11-01T00:00:00.000Z",
	rewards: [],
};

function fixture() {
	const calls: Array<{ method: string; input: unknown }> = [];
	const record = (method: string, input: unknown) => calls.push({ method, input });
	const referralService: ReferralServiceLike = {
		async createProgram(_project, input) {
			record("createProgram", input);
			return { program: programRecord, created: input.key === "friends" };
		},
		async getProgram() {
			return programRecord;
		},
		async listPrograms(_project, input) {
			record("listPrograms", input);
			return { items: [programRecord], nextCursor: null };
		},
		async archiveProgram(_project, key, actor) {
			record("archiveProgram", { key, actor });
			return { ...programRecord, status: "archived", archivedBy: actor, archivedAt: "2026-11-02" };
		},
		async listProgramReferrals() {
			return {
				items: [
					{
						id: referralRecord.id,
						referrerBillingAccountId: "alice",
						refereeBillingAccountId: null,
						status: "qualified",
						qualifiedAt: referralRecord.qualifiedAt,
						createdAt: referralRecord.createdAt,
						rewards: [],
					},
				],
				nextCursor: null,
			};
		},
		async getOrCreateCode(_project, input) {
			record("getOrCreateCode", input);
			return { ...input, code: "K7Q2M9XD", createdAt: "2026-11-01T00:00:00.000Z" };
		},
		async redeemCode(_project, input) {
			record("redeemCode", input);
			return { duplicate: false, referral: referralRecord };
		},
		async listAccountReferrals(_project, billingAccountId, input) {
			record("listAccountReferrals", { billingAccountId, ...input });
			return { items: [referralRecord], nextCursor: null };
		},
	};
	const app = withOpenApiAssertions(
		createApp({
			env,
			logger: createNoopBillingLogger(),
			connections: fixtureConnections(env.connectionFixtures),
			projectContextResolver: projectContextResolver({
				contexts: [project],
				credentials: {
					secret: "acme",
					"read-key": { projectInstanceKey: "acme", access: "read_only" },
				},
			}),
			referralService,
		}),
	);
	return { app, calls };
}

const auth = { authorization: "Bearer secret", "content-type": "application/json" };
const operator = {
	...auth,
	"x-billing-operator-key": "operator-secret-key",
	"x-billing-actor": "support@example.com",
};
const programBody = {
	key: "friends",
	name: "Refer a friend",
	rewardPromotionKey: "reward",
	trigger: "redemption",
	recipient: "referrer",
};

describe("referral program administration", () => {
	it("creates a program as the operator who sent the request", async () => {
		const { app, calls } = fixture();

		const created = await testRequest(app, "/v1/admin/referral-programs", {
			method: "POST",
			headers: operator,
			body: JSON.stringify(programBody),
		});
		const replayed = await testRequest(app, "/v1/admin/referral-programs", {
			method: "POST",
			headers: operator,
			body: JSON.stringify({ ...programBody, key: "again" }),
		});

		expect(created.status).toBe(201);
		expect(replayed.status).toBe(200);
		expect(calls[0]).toEqual({
			method: "createProgram",
			input: { ...programBody, actor: "support@example.com" },
		});
	});

	it("needs the operator key on every program route", async () => {
		const { app, calls } = fixture();
		const routes: Array<[string, string]> = [
			["POST", "/v1/admin/referral-programs"],
			["GET", "/v1/admin/referral-programs"],
			["GET", "/v1/admin/referral-programs/friends"],
			["POST", "/v1/admin/referral-programs/friends/archive"],
			["GET", "/v1/admin/referral-programs/friends/referrals"],
		];

		for (const [method, path] of routes) {
			const response = await testRequest(app, path, {
				method,
				headers: auth,
				body: method === "POST" ? JSON.stringify(programBody) : undefined,
			});
			expect(response.status).toBe(403);
			expect((await response.json()).error.code).toBe("BILLING_OPERATOR_KEY_INVALID");
		}
		expect(calls).toEqual([]);
	});

	it("needs an actor to change anything", async () => {
		const { app, calls } = fixture();
		const { "x-billing-actor": _actor, ...withoutActor } = operator;

		const response = await testRequest(app, "/v1/admin/referral-programs/friends/archive", {
			method: "POST",
			headers: withoutActor,
		});

		expect(response.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("refuses unknown fields and a trigger it does not have", async () => {
		const { app, calls } = fixture();
		for (const body of [
			{ ...programBody, extra: true },
			{ ...programBody, trigger: "never" },
			{ ...programBody, maxRewardsPerReferrer: 0 },
		]) {
			const response = await testRequest(app, "/v1/admin/referral-programs", {
				method: "POST",
				headers: operator,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
		expect(calls).toEqual([]);
	});

	it("archives and pages programs and the ledger", async () => {
		const { app, calls } = fixture();

		const archived = await testRequest(app, "/v1/admin/referral-programs/friends/archive", {
			method: "POST",
			headers: operator,
		});
		const listed = await testRequest(app, "/v1/admin/referral-programs?limit=5&status=active", {
			headers: operator,
		});
		const ledger = await testRequest(app, "/v1/admin/referral-programs/friends/referrals", {
			headers: operator,
		});

		expect(archived.status).toBe(200);
		expect(listed.status).toBe(200);
		expect(calls[1]).toEqual({
			method: "listPrograms",
			input: { limit: 5, cursor: null, status: "active" },
		});
		expect((await ledger.json()).data[0].refereeBillingAccountId).toBeNull();
	});
});

describe("referral calls from a product backend", () => {
	it("gets a code with no body and no operator key", async () => {
		const { app, calls } = fixture();

		const response = await testRequest(app, "/v1/billing-accounts/alice/referral-codes/friends", {
			method: "PUT",
			headers: { authorization: "Bearer secret" },
		});

		expect(response.status).toBe(200);
		expect((await response.json()).data.code).toBe("K7Q2M9XD");
		expect(calls[0]?.input).toEqual({ billingAccountId: "alice", programKey: "friends" });
	});

	it("redeems a code", async () => {
		const { app, calls } = fixture();

		const response = await testRequest(app, "/v1/billing-accounts/bob/referral-redemptions", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ code: "K7Q2M9XD", channel: "web" }),
		});

		expect(response.status).toBe(200);
		expect((await response.json()).data.referral.counterpartBillingAccountId).toBe("alice");
		expect(calls[0]?.input).toEqual({
			billingAccountId: "bob",
			code: "K7Q2M9XD",
			channel: "web",
		});
	});

	it("refuses a malformed code before it reaches the service", async () => {
		const { app, calls } = fixture();
		for (const code of ["short", "much-too-long-a-code", "K7Q2-9XD"]) {
			const response = await testRequest(app, "/v1/billing-accounts/bob/referral-redemptions", {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ code, channel: "web" }),
			});
			expect(response.status).toBe(400);
		}
		expect(calls).toEqual([]);
	});

	it("limits code entry so a short code cannot be guessed", async () => {
		const { app } = fixture();
		const enter = () =>
			testRequest(app, "/v1/billing-accounts/bob/referral-redemptions", {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ code: "K7Q2M9XD", channel: "web" }),
			});

		for (let attempt = 0; attempt < env.rateLimit.verifyLimit; attempt += 1) {
			expect((await enter()).status).toBe(200);
		}

		expect((await enter()).status).toBe(429);
	});

	it("does not limit reading an account's referrals as code entry", async () => {
		const { app } = fixture();
		for (let attempt = 0; attempt <= env.rateLimit.verifyLimit; attempt += 1) {
			const response = await testRequest(
				app,
				"/v1/billing-accounts/alice/referrals?role=referrer",
				{
					headers: auth,
				},
			);
			expect(response.status).toBe(200);
		}
	});

	it("keeps a read-only credential away from codes", async () => {
		const { app, calls } = fixture();
		const readOnly = { authorization: "Bearer read-key" };

		const list = await testRequest(app, "/v1/billing-accounts/alice/referrals", {
			headers: readOnly,
		});
		const code = await testRequest(app, "/v1/billing-accounts/alice/referral-codes/friends", {
			method: "PUT",
			headers: readOnly,
		});

		expect(list.status).toBe(403);
		expect(code.status).toBe(403);
		expect(calls).toEqual([]);
	});
});
