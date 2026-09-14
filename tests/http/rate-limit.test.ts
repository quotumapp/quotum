import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
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
import { testRequest } from "../helpers/openapi";

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

	it("bounds attacker-controlled keys with a shared overflow bucket", () => {
		const limiter = createFixedWindowRateLimiter({
			windowMs: 1_000,
			limit: 2,
			maxBuckets: 2,
			now: () => 1_000,
		});

		expect(limiter.check("known-a").allowed).toBe(true);
		expect(limiter.check("known-b").allowed).toBe(true);
		expect(limiter.check("attacker-a").allowed).toBe(true);
		expect(limiter.check("attacker-b").allowed).toBe(true);
		expect(limiter.check("attacker-c").allowed).toBe(false);
		expect(limiter.size()).toBe(3);
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
				beforeHandle({ request, path, server, set }) {
					if (!guard.matches(path)) {
						return;
					}
					const guardHeaders: Record<string, string> = {};
					guard.guard({
						request,
						path,
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
