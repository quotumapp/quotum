import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
	createFixedWindowRateLimiter,
	rateLimitMiddleware,
	requestIpAndPath,
	requestProjectIpAndPath,
} from "../../src/http/rate-limit";

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

describe("rateLimitMiddleware", () => {
	it("sets rate limit headers for allowed responses", async () => {
		const app = new Hono();
		app.use(
			"*",
			rateLimitMiddleware({
				limiter: {
					check(key) {
						expect(key).toBe("client-a");
						return { allowed: true, remaining: 4, resetAt: new Date(10_000) };
					},
				},
				key: () => "client-a",
			}),
		);
		app.get("/", (c) => c.json({ ok: true }));

		const response = await app.request("/");

		expect(response.status).toBe(200);
		expect(response.headers.get("ratelimit-remaining")).toBe("4");
		expect(response.headers.get("ratelimit-reset")).toBe(new Date(10_000).toISOString());
		expect(await response.json()).toEqual({ ok: true });
	});

	it("returns the standard 429 body when a request is not allowed", async () => {
		const app = new Hono();
		app.use(
			"*",
			rateLimitMiddleware({
				limiter: {
					check() {
						return { allowed: false, remaining: 0, resetAt: new Date(10_000) };
					},
				},
				key: () => "client-a",
			}),
		);
		app.get("/", (c) => c.json({ ok: true }));

		const response = await app.request("/");

		expect(response.status).toBe(429);
		expect(response.headers.get("ratelimit-remaining")).toBe("0");
		expect(response.headers.get("ratelimit-reset")).toBe(new Date(10_000).toISOString());
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
	});
});

describe("requestIpAndPath", () => {
	it("ignores spoofable proxy headers unless proxy trust is enabled", async () => {
		const app = new Hono();
		app.get("/limited", (c) => c.text(requestIpAndPath(c)));

		const response = await app.request("/limited?query=ignored", {
			headers: {
				"x-forwarded-for": "203.0.113.10, 198.51.100.20",
				"cf-connecting-ip": "198.51.100.30",
			},
		});

		expect(await response.text()).toBe("unknown:/limited");
	});

	it("uses the direct Bun peer address when proxy headers are untrusted", async () => {
		const app = new Hono();
		app.get("/limited", (c) =>
			c.text(
				requestIpAndPath(c, {
					remoteAddress: () => "203.0.113.42",
				}),
			),
		);

		const response = await app.request("/limited", {
			headers: { "x-forwarded-for": "198.51.100.10" },
		});

		expect(await response.text()).toBe("203.0.113.42:/limited");
	});

	it("uses Cloudflare IP before x-forwarded-for when proxy trust is enabled", async () => {
		const app = new Hono();
		app.get("/limited", (c) => c.text(requestIpAndPath(c, { trustProxyHeaders: true })));

		const response = await app.request("/limited?query=ignored", {
			headers: {
				"x-forwarded-for": "203.0.113.10, 198.51.100.20",
				"cf-connecting-ip": "198.51.100.30",
			},
		});

		expect(await response.text()).toBe("198.51.100.30:/limited");
	});

	it("falls back to x-forwarded-for and then unknown", async () => {
		const app = new Hono();
		app.get("/limited", (c) => c.text(requestIpAndPath(c, { trustProxyHeaders: true })));

		const forwardedResponse = await app.request("/limited", {
			headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.20" },
		});
		expect(await forwardedResponse.text()).toBe("203.0.113.10:/limited");

		const unknownResponse = await app.request("/limited");
		expect(await unknownResponse.text()).toBe("unknown:/limited");
	});
});

describe("requestProjectIpAndPath", () => {
	it("collapses unknown project webhook keys onto the route template", async () => {
		const app = new Hono();
		const knownProjectKeys = new Set(["voysee"]);
		app.get("/v1/projects/:projectKey/webhooks/:provider", (c) =>
			c.text(
				requestProjectIpAndPath(c, {
					knownProjectKeys,
					remoteAddress: () => "203.0.113.42",
				}),
			),
		);

		const first = await app.request("/v1/projects/attacker-a/webhooks/stripe");
		const second = await app.request("/v1/projects/attacker-b/webhooks/stripe");

		expect(await first.text()).toBe(
			"project:unknown:203.0.113.42:/v1/projects/:projectKey/webhooks/stripe",
		);
		expect(await second.text()).toBe(
			"project:unknown:203.0.113.42:/v1/projects/:projectKey/webhooks/stripe",
		);
	});
});
