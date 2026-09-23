import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createApp } from "../../src/app";
import { createConnectionEventApp } from "../../src/composition/connection-events";
import { ipRateLimitGate } from "../../src/composition/ingress-http";
import { createStripeAppEvents } from "../../src/composition/stripe-app-events";
import {
	createFixedWindowRateLimiter,
	normalizedRateLimitPath,
	type PostAuthRateLimitGuard,
	projectScopedRateLimitGuard,
	RateLimitExceeded,
	type RateLimiter,
	type RateLimitResult,
	rateLimitHeaders,
	rateLimitResponse,
	requestIp,
	requestIpAndPath,
	requestProjectIpAndPath,
} from "../../src/http/rate-limit";
import { attachRequestServer } from "../../src/http/server";
import type { StripeOAuthPort } from "../../src/platform/connections/oauth-port";
import {
	type FixtureBillingEnv as BillingEnv,
	fixtureConnections,
} from "../../src/testing/connection-fixtures";
import { testRequest } from "../helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

const RATE_LIMITED_ENVELOPE = {
	success: false,
	error: { code: "RATE_LIMITED", message: "Too many requests" },
};

interface RateLimitKeyOptions {
	trustProxyHeaders?: boolean;
	remoteAddress?: (request: Request) => string | null;
}

/** Rejecting key that mirrors `rateLimitResponse`/`rateLimitHeaders` exactly. */
const rejected = (resetAt: number): RateLimitResult => ({
	allowed: false,
	remaining: 0,
	resetAt: new Date(resetAt),
});

describe("createFixedWindowRateLimiter", () => {
	it("allows requests up to the limit and clamps remaining at zero", () => {
		let now = 1_000;
		const limiter = createFixedWindowRateLimiter({
			windowMs: 1_000,
			limit: 2,
			now: () => now,
		});

		expect(limiter.check("user_1")).toEqual({
			allowed: true,
			remaining: 1,
			resetAt: new Date(2_000),
		});
		expect(limiter.check("user_1")).toEqual({
			allowed: true,
			remaining: 0,
			resetAt: new Date(2_000),
		});
		expect(limiter.check("user_1")).toEqual({
			allowed: false,
			remaining: 0,
			resetAt: new Date(2_000),
		});

		now = 1_500;
		expect(limiter.check("user_1")).toEqual({
			allowed: false,
			remaining: 0,
			resetAt: new Date(2_000),
		});
	});

	it("resets the bucket when the fixed window changes", () => {
		let now = 1_999;
		const limiter = createFixedWindowRateLimiter({
			windowMs: 1_000,
			limit: 1,
			now: () => now,
		});

		expect(limiter.check("user_1").allowed).toBe(true);
		expect(limiter.check("user_1").allowed).toBe(false);

		now = 2_000;
		expect(limiter.check("user_1")).toEqual({
			allowed: true,
			remaining: 0,
			resetAt: new Date(3_000),
		});
	});

	it("isolates buckets by key", () => {
		const limiter = createFixedWindowRateLimiter({
			windowMs: 1_000,
			limit: 1,
			now: () => 5_000,
		});

		expect(limiter.check("user_1").allowed).toBe(true);
		expect(limiter.check("user_1").allowed).toBe(false);
		expect(limiter.check("user_2")).toEqual({
			allowed: true,
			remaining: 0,
			resetAt: new Date(6_000),
		});
	});

	it("prunes stale key buckets when the fixed window advances", () => {
		let now = 1_000;
		const limiter = createFixedWindowRateLimiter({
			windowMs: 1_000,
			limit: 1,
			now: () => now,
		});

		for (let i = 0; i < 100; i += 1) {
			expect(limiter.check(`client_${i}`).allowed).toBe(true);
		}
		expect(limiter.size()).toBe(100);

		now = 2_000;
		expect(limiter.check("client_0")).toEqual({
			allowed: true,
			remaining: 0,
			resetAt: new Date(3_000),
		});
		expect(limiter.size()).toBe(1);
		expect(limiter.check("client_1")).toEqual({
			allowed: true,
			remaining: 0,
			resetAt: new Date(3_000),
		});
		expect(limiter.size()).toBe(2);
	});

	it("rejects invalid limiter configuration", () => {
		expect(() => createFixedWindowRateLimiter({ windowMs: 0, limit: 1 })).toThrow(
			"windowMs must be a positive finite number",
		);
		expect(() => createFixedWindowRateLimiter({ windowMs: 1_000, limit: 0 })).toThrow(
			"limit must be a positive finite number",
		);
		expect(() =>
			createFixedWindowRateLimiter({ windowMs: 1_000, limit: 1, maxBuckets: 0 }),
		).toThrow("maxBuckets must be a positive integer");
	});

	it("never rejects a new key because the bucket table is full", () => {
		const limiter = createFixedWindowRateLimiter({
			windowMs: 1_000,
			limit: 2,
			maxBuckets: 2,
			now: () => 1_000,
		});

		expect(limiter.check("known-a").allowed).toBe(true);
		expect(limiter.check("known-b").allowed).toBe(true);
		for (let index = 0; index < 1_000; index += 1) {
			expect(limiter.check(`attacker-${index}`).allowed).toBe(true);
			expect(limiter.check(`attacker-${index}`).allowed).toBe(true);
			expect(limiter.check(`attacker-${index}`).allowed).toBe(false);
		}

		expect(limiter.check("newcomer")).toEqual({
			allowed: true,
			remaining: 1,
			resetAt: new Date(2_000),
		});
		expect(limiter.size()).toBe(2);
	});

	it("evicts the least recently checked key and keeps a hammering key rejected", () => {
		const limiter = createFixedWindowRateLimiter({
			windowMs: 1_000,
			limit: 1,
			maxBuckets: 2,
			now: () => 1_000,
		});

		expect(limiter.check("abuser").allowed).toBe(true);
		expect(limiter.check("idle").allowed).toBe(true);
		// A rejected check is still use: "abuser" becomes the most recently checked key.
		expect(limiter.check("abuser").allowed).toBe(false);
		expect(limiter.check("newcomer").allowed).toBe(true);

		expect(limiter.check("abuser").allowed).toBe(false);
		// "idle" was evicted by "newcomer", so it starts over instead of being rejected.
		expect(limiter.check("idle").allowed).toBe(true);
		expect(limiter.size()).toBe(2);
	});
});

describe("pre-auth rate limit gates", () => {
	/** Mirrors the shell's `onRequest` gates: reject with a Response, mirror headers when allowed. */
	function gateApp(options: { limiter: RateLimiter; key(request: Request): string }) {
		return new Elysia()
			.onRequest(({ request, set }) => {
				const pathname = new URL(request.url).pathname;
				if (pathname !== "/limited") {
					return;
				}
				const result = options.limiter.check(options.key(request));
				if (!result.allowed) {
					return rateLimitResponse(result);
				}
				Object.assign(set.headers, rateLimitHeaders(result));
			})
			.get("/limited", () => ({ ok: true }));
	}

	it("sets rate limit headers for allowed responses", async () => {
		const app = gateApp({
			limiter: {
				check(key) {
					expect(key).toBe("client-a");
					return { allowed: true, remaining: 4, resetAt: new Date(10_000) };
				},
			},
			key: () => "client-a",
		});

		const response = await testRequest(app, "/limited");

		expect(response.status).toBe(200);
		expect(response.headers.get("ratelimit-remaining")).toBe("4");
		expect(response.headers.get("ratelimit-reset")).toBe(new Date(10_000).toISOString());
		expect(await response.json()).toEqual({ ok: true });
	});

	it("returns the standard 429 body when a request is not allowed", async () => {
		const app = gateApp({
			limiter: { check: () => rejected(10_000) },
			key: () => "client-a",
		});

		const response = await testRequest(app, "/limited");

		expect(response.status).toBe(429);
		expect(response.headers.get("ratelimit-remaining")).toBe("0");
		expect(response.headers.get("ratelimit-reset")).toBe(new Date(10_000).toISOString());
		expect(await response.json()).toEqual(RATE_LIMITED_ENVELOPE);
	});
});

describe("projectScopedRateLimitGuard", () => {
	/** Mirrors the shell: post-auth guards throw `RateLimitExceeded`, `onError` renders the envelope. */
	function postAuthApp(
		guard: PostAuthRateLimitGuard,
		path = "/limited",
		projectKey = "proj_voysee",
	) {
		return new Elysia()
			.onError(({ error, set }) => {
				if (!(error instanceof RateLimitExceeded)) {
					return;
				}
				Object.assign(set.headers, rateLimitHeaders(error.result));
				return rateLimitResponse(error.result);
			})
			.get(path, () => ({ ok: true }), {
				beforeHandle({ request, path, route, server, set }) {
					if (!guard.matches(path)) {
						return;
					}
					const guardHeaders: Record<string, string> = {};
					guard.guard({
						request,
						path,
						route,
						server: server ?? null,
						projectKey,
						set: { headers: guardHeaders },
					});
					Object.assign(set.headers, guardHeaders);
				},
			});
	}

	it("mirrors limiter headers onto allowed responses", async () => {
		const keys: string[] = [];
		const guard = projectScopedRateLimitGuard({
			limiter: {
				check(key) {
					keys.push(key);
					return { allowed: true, remaining: 4, resetAt: new Date(10_000) };
				},
			},
			matches: (pathname) => pathname === "/limited",
		});
		const app = postAuthApp(guard, "/limited");

		const response = await testRequest(app, "/limited");

		expect(keys).toEqual(["project:proj_voysee:unknown:/limited"]);
		expect(response.status).toBe(200);
		expect(response.headers.get("ratelimit-remaining")).toBe("4");
		expect(response.headers.get("ratelimit-reset")).toBe(new Date(10_000).toISOString());
		expect(await response.json()).toEqual({ ok: true });
	});

	it("renders the 429 envelope with limiter headers when rejected", async () => {
		const guard = projectScopedRateLimitGuard({
			limiter: { check: () => rejected(10_000) },
			matches: () => true,
		});
		const app = postAuthApp(guard, "/limited");

		const response = await testRequest(app, "/limited");

		expect(response.status).toBe(429);
		expect(response.headers.get("ratelimit-remaining")).toBe("0");
		expect(response.headers.get("ratelimit-reset")).toBe(new Date(10_000).toISOString());
		expect(await response.json()).toEqual(RATE_LIMITED_ENVELOPE);
	});

	it("limits a fixed window end to end", async () => {
		const guard = projectScopedRateLimitGuard({
			limiter: createFixedWindowRateLimiter({ windowMs: 1_000, limit: 2, now: () => 5_000 }),
			matches: () => true,
		});
		const app = postAuthApp(guard, "/limited");

		const first = await testRequest(app, "/limited");
		const second = await testRequest(app, "/limited");
		const third = await testRequest(app, "/limited");

		expect(first.status).toBe(200);
		expect(first.headers.get("ratelimit-remaining")).toBe("1");
		expect(second.status).toBe(200);
		expect(second.headers.get("ratelimit-remaining")).toBe("0");
		expect(third.status).toBe(429);
		expect(third.headers.get("ratelimit-remaining")).toBe("0");
		expect(third.headers.get("ratelimit-reset")).toBe(new Date(6_000).toISOString());
		expect(await third.json()).toEqual(RATE_LIMITED_ENVELOPE);
	});

	it("honours proxy headers only when proxy trust is enabled", async () => {
		let key = "";
		const untrusted = projectScopedRateLimitGuard({
			limiter: {
				check(key_) {
					key = key_;
					return { allowed: true, remaining: 1, resetAt: new Date(10_000) };
				},
			},
			matches: () => true,
		});
		await testRequest(postAuthApp(untrusted), "/limited", {
			headers: { "cf-connecting-ip": "198.51.100.30" },
		});
		expect(key).toBe("project:proj_voysee:unknown:/limited");

		const trusted = projectScopedRateLimitGuard({
			limiter: {
				check(key_) {
					key = key_;
					return { allowed: true, remaining: 1, resetAt: new Date(10_000) };
				},
			},
			matches: () => true,
			trustProxyHeaders: true,
		});
		await testRequest(postAuthApp(trusted), "/limited", {
			headers: { "cf-connecting-ip": "198.51.100.30" },
		});
		expect(key).toBe("project:proj_voysee:198.51.100.30:/limited");
	});

	it("keys buckets on the route pattern, not the values in the path", async () => {
		const keys: string[] = [];
		const guard = projectScopedRateLimitGuard({
			limiter: {
				check(key) {
					keys.push(key);
					return { allowed: true, remaining: 1, resetAt: new Date(10_000) };
				},
			},
			matches: () => true,
		});
		const app = postAuthApp(guard, "/v1/billing-accounts/:billingAccountId/usage/check");

		await testRequest(app, "/v1/billing-accounts/user_1/usage/check");
		await testRequest(app, "/v1/billing-accounts/user_2/usage/check");

		expect(keys).toEqual([
			"project:proj_voysee:unknown:/v1/billing-accounts/:billingAccountId/usage/check",
			"project:proj_voysee:unknown:/v1/billing-accounts/:billingAccountId/usage/check",
		]);
	});

	it("skips requests outside its path group", async () => {
		let checks = 0;
		const guard = projectScopedRateLimitGuard({
			limiter: {
				check() {
					checks += 1;
					return { allowed: true, remaining: 9, resetAt: new Date(10_000) };
				},
			},
			matches: (pathname) => pathname === "/limited",
		});

		const response = await testRequest(postAuthApp(guard, "/other"), "/other");

		expect(response.status).toBe(200);
		expect(checks).toBe(0);
	});

	it("omits headers on allowed responses with rejected_only headers", async () => {
		const guard = projectScopedRateLimitGuard({
			limiter: { check: () => ({ allowed: true, remaining: 9, resetAt: new Date(10_000) }) },
			matches: () => true,
			headers: "rejected_only",
		});

		const response = await testRequest(postAuthApp(guard, "/limited"), "/limited");

		expect(response.status).toBe(200);
		expect(response.headers.get("ratelimit-remaining")).toBeNull();
		expect(response.headers.get("ratelimit-reset")).toBeNull();
	});

	it("exposes the rejected result on the thrown error", () => {
		const result = rejected(10_000);

		const error = new RateLimitExceeded(result);

		expect(error.message).toBe("Too many requests");
		expect(error.result).toBe(result);
	});
});

describe("ipRateLimitGate", () => {
	function ingressApp(
		gate: ReturnType<typeof ipRateLimitGate>,
		route = "/v1/stripe-app/webhooks/:mode",
	) {
		return new Elysia().post(route, () => ({ ok: true }), { beforeHandle: gate });
	}
	const recording = (keys: string[]): RateLimiter => ({
		check(key) {
			keys.push(key);
			return { allowed: true, remaining: 1, resetAt: new Date(10_000) };
		},
	});

	it("keys on the route pattern and keeps only accepted values of bounded parameters", async () => {
		const keys: string[] = [];
		const app = ingressApp(
			ipRateLimitGate(recording(keys), { boundedParams: { mode: ["test", "live"] } }),
		);

		for (const mode of ["live", "test", "m1", "m2", "constructor", "__proto__"]) {
			await app.handle(
				new Request(`http://localhost/v1/stripe-app/webhooks/${mode}`, { method: "POST" }),
			);
		}

		expect(keys).toEqual([
			"unknown:/v1/stripe-app/webhooks/live",
			"unknown:/v1/stripe-app/webhooks/test",
			"unknown:/v1/stripe-app/webhooks/:mode",
			"unknown:/v1/stripe-app/webhooks/:mode",
			"unknown:/v1/stripe-app/webhooks/:mode",
			"unknown:/v1/stripe-app/webhooks/:mode",
		]);
	});

	it("honours proxy headers only when proxy trust is enabled", async () => {
		const keys: string[] = [];
		const headers = { "x-forwarded-for": "198.51.100.30" };
		const post = (app: ReturnType<typeof ingressApp>) =>
			app.handle(
				new Request("http://localhost/v1/stripe-app/webhooks/live", { method: "POST", headers }),
			);

		await post(ingressApp(ipRateLimitGate(recording(keys))));
		await post(ingressApp(ipRateLimitGate(recording(keys), { trustProxyHeaders: true })));

		expect(keys).toEqual([
			"unknown:/v1/stripe-app/webhooks/:mode",
			"198.51.100.30:/v1/stripe-app/webhooks/:mode",
		]);
	});
});

describe("requestIp", () => {
	it("uses the Bun peer address and falls back to unknown", () => {
		const request = new Request("http://localhost/limited");
		const server = { requestIP: () => ({ address: "198.51.100.7" }) };

		expect(requestIp({ request, server })).toBe("198.51.100.7");
		expect(requestIp({ request, server: null })).toBe("unknown");
	});

	it("prefers the direct peer over proxy headers unless proxy trust is enabled", () => {
		const request = new Request("http://localhost/limited", {
			headers: {
				"x-forwarded-for": "203.0.113.10, 198.51.100.20",
				"cf-connecting-ip": "198.51.100.30",
			},
		});

		expect(requestIp({ request, server: null }, { remoteAddress: () => "203.0.113.42" })).toBe(
			"203.0.113.42",
		);
		expect(requestIp({ request, server: null })).toBe("unknown");
		expect(requestIp({ request, server: null }, { trustProxyHeaders: true })).toBe("198.51.100.30");
	});

	it("falls back to unknown when peer resolution throws", () => {
		const request = new Request("http://localhost/limited");

		expect(
			requestIp(
				{ request, server: null },
				{
					remoteAddress: () => {
						throw new Error("no peer");
					},
				},
			),
		).toBe("unknown");
	});
});

describe("requestIpAndPath", () => {
	const keyApp = (options: RateLimitKeyOptions = {}) =>
		new Elysia().get("/limited", ({ request, server }) => {
			return new Response(requestIpAndPath({ request, server }, options));
		});

	it("ignores spoofable proxy headers unless proxy trust is enabled", async () => {
		const response = await testRequest(keyApp(), "/limited?query=ignored", {
			headers: {
				"x-forwarded-for": "203.0.113.10, 198.51.100.20",
				"cf-connecting-ip": "198.51.100.30",
			},
		});

		expect(await response.text()).toBe("unknown:/limited");
	});

	it("uses the direct Bun peer address when proxy headers are untrusted", async () => {
		const app = keyApp({ remoteAddress: () => "203.0.113.42" });

		const response = await testRequest(app, "/limited", {
			headers: { "x-forwarded-for": "198.51.100.10" },
		});

		expect(await response.text()).toBe("203.0.113.42:/limited");
	});

	it("uses Cloudflare IP before x-forwarded-for when proxy trust is enabled", async () => {
		const app = keyApp({ trustProxyHeaders: true });

		const response = await testRequest(app, "/limited?query=ignored", {
			headers: {
				"x-forwarded-for": "203.0.113.10, 198.51.100.20",
				"cf-connecting-ip": "198.51.100.30",
			},
		});

		expect(await response.text()).toBe("198.51.100.30:/limited");
	});

	it("falls back to x-forwarded-for and then unknown", async () => {
		const app = keyApp({ trustProxyHeaders: true });

		const forwardedResponse = await testRequest(app, "/limited", {
			headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.20" },
		});
		expect(await forwardedResponse.text()).toBe("203.0.113.10:/limited");

		const unknownResponse = await testRequest(app, "/limited");
		expect(await unknownResponse.text()).toBe("unknown:/limited");
	});
});

describe("requestProjectIpAndPath", () => {
	it("composes the key from the resolved project key, peer, and normalized path", () => {
		const key = requestProjectIpAndPath(
			{
				request: new Request("http://localhost/v1/projects/voysee/usage/events"),
				server: null,
				projectKey: "abc",
			},
			{ remoteAddress: () => "203.0.113.9" },
		);

		expect(key).toBe("project:abc:203.0.113.9:/v1/projects/voysee/usage/events");
	});

	it("treats blank project keys as unknown", () => {
		const key = requestProjectIpAndPath(
			{ request: new Request("http://localhost/v1/catalog"), server: null, projectKey: "   " },
			{ remoteAddress: () => "203.0.113.9" },
		);

		expect(key).toBe("project:unknown:203.0.113.9:/v1/catalog");
	});

	it("collapses unresolved project webhook keys onto the route template", () => {
		const keyFor = (projectKey: string) =>
			requestProjectIpAndPath(
				{
					request: new Request(`http://localhost/v1/projects/${projectKey}/webhooks/stripe`),
					server: null,
					projectKey: null,
				},
				{ remoteAddress: () => "203.0.113.42" },
			);

		expect(keyFor("attacker-a")).toBe(
			"project:unknown:203.0.113.42:/v1/projects/:projectKey/webhooks/stripe",
		);
		expect(keyFor("attacker-b")).toBe(
			"project:unknown:203.0.113.42:/v1/projects/:projectKey/webhooks/stripe",
		);
	});

	it("keys webhook requests by project, peer, and normalized route template", async () => {
		const app = new Elysia().get(
			"/v1/projects/:projectKey/webhooks/:provider",
			({ params, request, server }) => {
				return new Response(
					requestProjectIpAndPath(
						{ request, server, projectKey: params.projectKey },
						{ remoteAddress: () => "203.0.113.42" },
					),
				);
			},
		);

		const first = await testRequest(app, "/v1/projects/attacker-a/webhooks/stripe");
		const second = await testRequest(app, "/v1/projects/voysee/webhooks/stripe");

		expect(await first.text()).toBe(
			"project:attacker-a:203.0.113.42:/v1/projects/:projectKey/webhooks/stripe",
		);
		expect(await second.text()).toBe(
			"project:voysee:203.0.113.42:/v1/projects/:projectKey/webhooks/stripe",
		);
	});
});

describe("normalizedRateLimitPath", () => {
	it("collapses provider webhook paths onto the route template", () => {
		expect(normalizedRateLimitPath("/v1/projects/voysee/webhooks/apple")).toBe(
			"/v1/projects/:projectKey/webhooks/apple",
		);
		expect(normalizedRateLimitPath("/v1/projects/voysee/webhooks/google")).toBe(
			"/v1/projects/:projectKey/webhooks/google",
		);
		expect(normalizedRateLimitPath("/v1/projects/attacker-a/webhooks/stripe")).toBe(
			"/v1/projects/:projectKey/webhooks/stripe",
		);
	});

	it("leaves other paths untouched", () => {
		expect(normalizedRateLimitPath("/v1/projects/voysee/usage/events")).toBe(
			"/v1/projects/voysee/usage/events",
		);
		expect(normalizedRateLimitPath("/v1/projects/voysee/webhooks/unknown")).toBe(
			"/v1/projects/voysee/webhooks/unknown",
		);
	});
});

describe("rate limit envelope helpers", () => {
	it("renders the standard limiter headers", () => {
		expect(rateLimitHeaders({ allowed: true, remaining: 4, resetAt: new Date(10_000) })).toEqual({
			"ratelimit-remaining": "4",
			"ratelimit-reset": new Date(10_000).toISOString(),
		});
	});

	it("renders the standard 429 envelope with limiter headers", async () => {
		const response = rateLimitResponse(rejected(10_000));

		expect(response.status).toBe(429);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get("ratelimit-remaining")).toBe("0");
		expect(response.headers.get("ratelimit-reset")).toBe(new Date(10_000).toISOString());
		expect(await response.json()).toEqual(RATE_LIMITED_ENVELOPE);
	});
});

/**
 * Every in-memory limiter the service registers, driven through its real app. A caller chooses
 * path values (billing accounts, webhook project keys, ingress modes) and, with enough hosts, its
 * address; neither may reject another project or another client.
 */
describe("limiter isolation", () => {
	/** Enough distinct keys to fill the default 10,000-key table and drain any shared remainder. */
	const FLOOD = 10_130;
	const LIMIT = 3;
	/** An epoch-aligned window that cannot roll over while a test runs. */
	const WINDOW_MS = 10 ** 13;
	/** The setup ingresses use a fixed one-minute window. */
	const INGRESS_WINDOW_MS = 60_000;
	const PEER_X = "198.51.100.66";
	const PEER_Z = "203.0.113.9";
	const validUsage = JSON.stringify({ featureKey: "api_calls", quantity: "1" });

	const env: BillingEnv = {
		postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
		postgresPreparedStatements: true,
		authMode: "api_key",
		operatorApiKey: "operator-secret-key",
		trustGatewayProjectHeader: false,
		connectionFixtures: [],
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
			windowMs: WINDOW_MS,
			verifyLimit: 120,
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

	type IsolationApp = { server: unknown; handle(request: Request): Promise<Response> };

	function staffApp(rateLimit: Partial<BillingEnv["rateLimit"]>): IsolationApp {
		const answer = async () => ({ recorded: true }) as never;
		return createApp({
			env: { ...env, rateLimit: { ...env.rateLimit, ...rateLimit } },
			connections: fixtureConnections([]),
			projectContextResolver: projectContextResolver({
				contexts: [projectInstanceContext("voysee"), projectInstanceContext("wiseley")],
				credentials: { voysee: "voysee", wiseley: "wiseley" },
			}),
			stripeBillingService: {
				handleWebhook: async () => ({ status: "ignored", eventType: "ping", entitlements: null }),
			} as never,
			meteringService: new Proxy({}, { get: () => answer }) as never,
			adminBillingReader: new Proxy({}, { get: () => async () => null }) as never,
			promotionService: new Proxy({}, { get: () => answer }) as never,
		}) as unknown as IsolationApp;
	}

	const stripeAppOAuth: StripeOAuthPort = {
		authorize: () => "",
		exchange: () => Promise.reject(new Error("unused")),
		refresh: () => Promise.reject(new Error("unused")),
		webhookSecret: (environment) => `whsec_${environment}`,
	};
	const unusedPersistence = Object.assign(
		async () => {
			throw new Error("an unsigned request must not reach persistence");
		},
		{ begin: async () => [] },
	) as never;

	function post(path: string, headers: Record<string, string>, body = "{}"): Request {
		return new Request(`http://localhost${path}`, { method: "POST", headers, body });
	}
	function authenticated(project: string, extra: Record<string, string> = {}) {
		return { authorization: `Bearer ${project}`, "content-type": "application/json", ...extra };
	}

	interface IsolationCase {
		name: string;
		createApp(): IsolationApp;
		/** Requests one client may send before this limiter rejects it, whatever values it picks. */
		budget: number;
		/** A request carrying the caller-chosen `value`, as `project` where the route authenticates. */
		request(value: string, project: string): Request;
		/** The value another client sends, such as a real project's webhook key. */
		victimValue: string;
		/** Post-authentication guards also keep another project behind the same address apart. */
		projectScoped: boolean;
		windowMs: number;
	}

	const cases: IsolationCase[] = [
		{
			name: "provider webhooks (per-IP ceiling, then per project)",
			createApp: () => staffApp({ webhookLimit: LIMIT }),
			// The per-client ceiling is ten per-project budgets; the project key is unauthenticated.
			budget: 10 * LIMIT,
			request: (value) =>
				post(`/v1/projects/${value}/webhooks/stripe`, { "stripe-signature": "t=1,v1=00" }),
			victimValue: "voysee",
			projectScoped: false,
			windowMs: WINDOW_MS,
		},
		{
			name: "/v1 aggregate per-IP gate",
			// The aggregate is the sum of the verify, admin and metering limits.
			createApp: () => staffApp({ verifyLimit: 1, adminLimit: 1, meteringLimit: 1 }),
			budget: 3,
			request: (value) => new Request(`http://localhost/v1/billing-accounts/${value}/entitlements`),
			victimValue: "user_victim",
			projectScoped: false,
			windowMs: WINDOW_MS,
		},
		{
			name: "metering guard",
			createApp: () => staffApp({ meteringLimit: LIMIT }),
			budget: LIMIT,
			request: (value, project) =>
				post(`/v1/billing-accounts/${value}/usage/check`, authenticated(project), validUsage),
			victimValue: "user_victim",
			projectScoped: true,
			windowMs: WINDOW_MS,
		},
		{
			name: "admin guard",
			createApp: () => staffApp({ adminLimit: LIMIT }),
			budget: LIMIT,
			request: (value, project) =>
				new Request(`http://localhost/v1/admin/customers/by-billing-account/${value}`, {
					headers: authenticated(project, { "x-billing-operator-key": "operator-secret-key" }),
				}),
			victimValue: "user_victim",
			projectScoped: true,
			windowMs: WINDOW_MS,
		},
		{
			name: "purchase verification guard",
			createApp: () => staffApp({ verifyLimit: LIMIT }),
			budget: LIMIT,
			request: (value, project) =>
				post(
					"/v1/purchases/verify",
					authenticated(project),
					JSON.stringify({ provider: "apple", billingAccountId: value }),
				),
			victimValue: "user_victim",
			projectScoped: true,
			windowMs: WINDOW_MS,
		},
		{
			name: "promotion code entry guard",
			createApp: () => staffApp({ verifyLimit: LIMIT }),
			budget: LIMIT,
			request: (value, project) =>
				post(
					`/v1/billing-accounts/${value}/promotion-codes/validate`,
					authenticated(project),
					JSON.stringify({ code: "SPRING" }),
				),
			victimValue: "user_victim",
			projectScoped: true,
			windowMs: WINDOW_MS,
		},
		{
			name: "connection setup ingress",
			createApp: () => createConnectionEventApp({} as never) as unknown as IsolationApp,
			budget: 120,
			// An unsupported provider is answered before any lookup, so no repository is needed.
			request: (value) =>
				post(`/v1/projects/${value}/connections/${crypto.randomUUID()}/webhooks/paddle`, {}),
			victimValue: "voysee",
			projectScoped: false,
			windowMs: INGRESS_WINDOW_MS,
		},
		{
			name: "Stripe App ingress",
			createApp: () =>
				createStripeAppEvents({} as never, stripeAppOAuth, unusedPersistence)
					.app as unknown as IsolationApp,
			budget: 120,
			request: (value) =>
				post(`/v1/stripe-app/webhooks/${value}`, { "stripe-signature": "t=1,v1=00" }),
			victimValue: "live",
			projectScoped: false,
			windowMs: INGRESS_WINDOW_MS,
		},
	];

	function send(app: IsolationApp, request: Request, address: string): Promise<Response> {
		attachRequestServer(app, { requestIP: () => ({ address }) });
		return app.handle(request);
	}

	/** Waits out the last two seconds of a fixed window so a burst cannot straddle a reset. */
	async function awayFromWindowEdge(windowMs: number): Promise<void> {
		const remaining = windowMs - (Date.now() % windowMs);
		if (remaining < 2_000) await Bun.sleep(remaining + 10);
	}

	/** What the other client, and another project behind the flooding address, get back. */
	async function bystanders(app: IsolationApp, testCase: IsolationCase) {
		const otherPeer = await send(app, testCase.request(testCase.victimValue, "voysee"), PEER_Z);
		const otherProject = testCase.projectScoped
			? (await send(app, testCase.request(testCase.victimValue, "wiseley"), PEER_X)).status
			: null;
		return { otherPeer: otherPeer.status, otherProject };
	}

	for (const testCase of cases) {
		describe(testCase.name, () => {
			it("does not let path values multiply one client's budget", async () => {
				const baseline = await bystanders(testCase.createApp(), testCase);
				expect(baseline.otherPeer).not.toBe(429);
				expect(baseline.otherProject).not.toBe(429);
				await awayFromWindowEdge(testCase.windowMs);

				const app = testCase.createApp();
				const statuses: number[] = [];
				for (let index = 0; index <= testCase.budget; index += 1) {
					const request = testCase.request(`value-${index}`, "voysee");
					statuses.push((await send(app, request, PEER_X)).status);
				}

				expect(statuses.slice(0, testCase.budget)).not.toContain(429);
				expect(statuses[testCase.budget]).toBe(429);
				expect(await bystanders(app, testCase)).toEqual(baseline);
			});

			it("never rejects another client once its bucket table is full", async () => {
				const baseline = await bystanders(testCase.createApp(), testCase);
				await awayFromWindowEdge(testCase.windowMs);

				const app = testCase.createApp();
				for (let index = 0; index < FLOOD; index += 1) {
					const address = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
					await send(app, testCase.request(`value-${index}`, "voysee"), address);
				}

				expect(await bystanders(app, testCase)).toEqual(baseline);
			}, 30_000);
		});
	}

	it("caps the project lookups one client can cause with unknown webhook project keys", async () => {
		let lookups = 0;
		const resolver = projectContextResolver({ contexts: [projectInstanceContext("voysee")] });
		const app = createApp({
			env: { ...env, rateLimit: { ...env.rateLimit, webhookLimit: LIMIT } },
			connections: fixtureConnections([]),
			projectContextResolver: {
				...resolver,
				resolveInstanceKey(key) {
					lookups += 1;
					return resolver.resolveInstanceKey(key);
				},
			},
		}) as unknown as IsolationApp;

		let rejected: Response | undefined;
		for (let index = 0; index < 1_000; index += 1) {
			const response = await send(
				app,
				post(`/v1/projects/k${index}/webhooks/stripe`, { "stripe-signature": "t=1,v1=00" }),
				PEER_X,
			);
			if (response.status === 429) rejected ??= response;
		}

		expect(lookups).toBe(10 * LIMIT);
		expect(rejected?.headers.get("ratelimit-remaining")).toBe("0");
		expect(await rejected?.json()).toEqual(RATE_LIMITED_ENVELOPE);
	});

	describe("setup ingress behind a trusted proxy", () => {
		const ingresses: Array<{ name: string; create(trustProxyHeaders: boolean): IsolationApp }> = [
			{
				name: "connection setup ingress",
				create: (trustProxyHeaders) =>
					createConnectionEventApp({} as never, { trustProxyHeaders }) as unknown as IsolationApp,
			},
			{
				name: "Stripe App ingress",
				create: (trustProxyHeaders) =>
					createStripeAppEvents({} as never, stripeAppOAuth, unusedPersistence, {
						trustProxyHeaders,
					}).app as unknown as IsolationApp,
			},
		];
		const path = {
			"connection setup ingress": `/v1/projects/voysee/connections/${crypto.randomUUID()}/webhooks/paddle`,
			"Stripe App ingress": "/v1/stripe-app/webhooks/live",
		} as const;

		for (const ingress of ingresses) {
			it(`keys the ${ingress.name} on the forwarded client only when trusted`, async () => {
				await awayFromWindowEdge(INGRESS_WINDOW_MS);
				const lastStatus = async (trustProxyHeaders: boolean) => {
					const app = ingress.create(trustProxyHeaders);
					// Every request arrives from the ingress controller's socket.
					const from = (client: string) =>
						send(
							app,
							post(path[ingress.name as keyof typeof path], { "x-forwarded-for": client }),
							"10.0.0.2",
						);
					for (let index = 0; index < 121; index += 1) await from(PEER_X);
					return (await from(PEER_Z)).status;
				};

				expect(await lastStatus(true)).not.toBe(429);
				expect(await lastStatus(false)).toBe(429);
			});
		}
	});
});
