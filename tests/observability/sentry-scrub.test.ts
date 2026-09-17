import { describe, expect, it } from "bun:test";
import type { ErrorEvent } from "@sentry/core";
import {
	describeThrown,
	FILTERED,
	isSensitiveKey,
	isUrlKey,
	maskPath,
	scrubBreadcrumb,
	scrubEvent,
	scrubLog,
	scrubRecord,
	scrubSpan,
	scrubSpanData,
	scrubString,
	scrubUrl,
	scrubValue,
	stripUndefined,
} from "../../src/observability/sentry-scrub";

describe("scrubString", () => {
	it("masks bearer and basic credentials", () => {
		expect(scrubString("Authorization: Bearer bearer-token-sensitive")).toBe(
			"Authorization: Bearer [Filtered]",
		);
		expect(scrubString("retry with Bearer nested-token-sensitive")).toBe(
			"retry with Bearer [Filtered]",
		);
		expect(scrubString("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic [Filtered]");
	});

	it("masks url userinfo", () => {
		expect(scrubString("postgres://user:pw@host/db")).toBe("postgres://[Filtered]@host/db");
	});

	it("masks jwt", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
		expect(scrubString(`token ${jwt} end`)).toBe("token [jwt] end");
	});

	it("masks prefixed ids but keeps safe words", () => {
		expect(scrubString("cus_1A2b3C4d5E6F7G8H")).toBe("cus_[Filtered]");
		expect(scrubString("sk_live_abcDEF1234567890")).toBe("sk_[Filtered]");
		expect(scrubString("whsec_ABC123def456")).toBe("whsec_[Filtered]");
		expect(scrubString("sqpk_test_ABC123def456789")).toBe("sqpk_[Filtered]");
		expect(scrubString("in_progress sub_total")).toBe("in_progress sub_total");
	});

	it("masks email and ip", () => {
		expect(scrubString("contact user@example.com now")).toBe("contact [email] now");
		expect(scrubString("db at 10.0.0.5:5432 failed")).toBe("db at [ip]:5432 failed");
	});

	it("masks long digit runs but keeps epoch millis", () => {
		expect(scrubString("txn 1234567890123456 done")).toBe("txn [number] done");
		expect(scrubString("at 1758000000000 ms")).toBe("at 1758000000000 ms");
	});

	it("masks opaque tokens but keeps uuids and plain words", () => {
		const token43 = "aB1".repeat(15).slice(0, 43);
		expect(scrubString(`key ${token43} end`)).toBe(`key ${FILTERED} end`);
		expect(scrubString("123e4567-e89b-12d3-a456-426614174000")).toBe(
			"123e4567-e89b-12d3-a456-426614174000",
		);
		expect(scrubString("a-very-long-hyphenated-word-that-is-definitely-long")).toBe(
			"a-very-long-hyphenated-word-that-is-definitely-long",
		);
		expect(
			scrubString("see /v1/billing-accounts/123e4567-e89b-12d3-a456-426614174000/usage ok"),
		).toBe("see /v1/billing-accounts/123e4567-e89b-12d3-a456-426614174000/usage ok");
	});

	it("caps with ellipsis", () => {
		expect(scrubString("abcdef", 5)).toBe("abcd…");
	});
});

describe("maskPath", () => {
	const cases: Array<[string, string]> = [
		["/v1/billing-accounts/abc/usage/consume", "/v1/billing-accounts/:id/usage/consume"],
		[
			"/v1/billing-accounts/abc/usage/operations/consume/def",
			"/v1/billing-accounts/:id/usage/operations/consume/:id",
		],
		["/v1/admin/customers/cust-1", "/v1/admin/customers/:id"],
		["/v1/admin/contracts/b1/c1", "/v1/admin/contracts/:id/:id"],
		["/v1/admin/auto-topups/b1/p1/reset", "/v1/admin/auto-topups/:id/:id/reset"],
		["/v1/admin/store-events/evt-1/replay", "/v1/admin/store-events/:id/replay"],
		["/v1/admin/projection-jobs/job-1/retry", "/v1/admin/projection-jobs/:id/retry"],
		["/v1/admin/promotions/SUMMER/codes", "/v1/admin/promotions/:id/codes"],
		["/v1/projects/voysee/webhooks/stripe", "/v1/projects/:id/webhooks/stripe"],
		[
			"/v1/projects/voysee/connections/ver-1/webhooks/stripe",
			"/v1/projects/:id/connections/:id/webhooks/stripe",
		],
		["/v1/stripe-app/webhooks/live", "/v1/stripe-app/webhooks/live"],
		[
			"/api/platform/provisioning/123e4567-e89b-12d3-a456-426614174000",
			"/api/platform/provisioning/:id",
		],
		["/api/platform/team/members/abc", "/api/platform/team/members/:id"],
		["/api/platform/step-up/abc/complete", "/api/platform/step-up/:id/complete"],
		[
			"/api/billing/admin/billing-accounts/abc/usage/series",
			"/api/billing/admin/billing-accounts/:id/usage/series",
		],
		["/api/auth/callback/google", "/api/auth/callback/google"],
		["/v1/billing-accounts/:billingAccountId", "/v1/billing-accounts/:billingAccountId"],
		["/api/auth/*", "/api/auth/*"],
		["/health", "/health"],
	];
	for (const [input, expected] of cases) {
		it(`masks ${input}`, () => {
			expect(maskPath(input)).toBe(expected);
		});
	}
});

describe("scrubUrl", () => {
	it("strips userinfo query and hash from absolute urls", () => {
		expect(scrubUrl("https://user:pw@example.com/v1/billing-accounts/abc/usage?x=1#frag")).toBe(
			"https://example.com/v1/billing-accounts/:id/usage",
		);
	});

	it("masks relative paths", () => {
		expect(scrubUrl("/v1/billing-accounts/abc/usage?x=1")).toBe("/v1/billing-accounts/:id/usage");
	});

	it("falls back to string scrubbing", () => {
		expect(scrubUrl("not a url cus_1A2b3C4d5E6F7G8H")).toBe("not a url cus_[Filtered]");
	});
});

describe("sensitive and url keys", () => {
	it("drops sensitive keys and keeps correlation keys", () => {
		expect(isSensitiveKey("cookie")).toBe(true);
		expect(isSensitiveKey("x-quotum-service-token")).toBe(true);
		expect(isSensitiveKey("x-forwarded-for")).toBe(true);
		expect(isSensitiveKey("email")).toBe(true);
		expect(isSensitiveKey("actor")).toBe(true);
		expect(isSensitiveKey("dsn")).toBe(true);
		expect(isSensitiveKey("postgresUri")).toBe(true);
		expect(isSensitiveKey("projectKey")).toBe(false);
		expect(isSensitiveKey("featureKey")).toBe(false);
		expect(isSensitiveKey("promotionKey")).toBe(false);
		expect(isSensitiveKey("jobId")).toBe(false);
		expect(isSensitiveKey("key")).toBe(false);
	});

	it("detects url keys", () => {
		expect(isUrlKey("path")).toBe(true);
		expect(isUrlKey("projectionUrl")).toBe(true);
		expect(isUrlKey("projectKey")).toBe(false);
	});
});

describe("scrubRecord", () => {
	it("drops sensitive keys and masks url keys", () => {
		const output = scrubRecord({
			projectKey: "voysee",
			featureKey: "api_calls",
			promotionKey: "SUMMER",
			jobId: "123e4567-e89b-12d3-a456-426614174000",
			cookie: "secret",
			"x-quotum-service-token": "secret",
			"x-forwarded-for": "10.0.0.1",
			email: "user@example.com",
			actor: "someone",
			dsn: "https://x@y/1",
			postgresUri: "postgres://user:pw@host/db",
			"user.id": "should-drop-by-substring?",
			path: "/v1/billing-accounts/abc/usage",
			projectionUrl: "https://merchant.example/hooks?a=1",
		});
		expect(output.projectKey).toBe("voysee");
		expect(output.featureKey).toBe("api_calls");
		expect(output.promotionKey).toBe("SUMMER");
		expect(output.jobId).toBe("123e4567-e89b-12d3-a456-426614174000");
		expect(output.cookie).toBeUndefined();
		expect(output["x-quotum-service-token"]).toBeUndefined();
		expect(output["x-forwarded-for"]).toBeUndefined();
		expect(output.email).toBeUndefined();
		expect(output.actor).toBeUndefined();
		expect(output.dsn).toBeUndefined();
		expect(output.postgresUri).toBeUndefined();
		expect(output.path).toBe("/v1/billing-accounts/:id/usage");
		expect(output.projectionUrl).toBe("https://merchant.example/hooks");
	});

	it("caps depth keys items and handles circular bigint", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(scrubRecord(circular).self).toBe("[Circular]");
		expect(scrubRecord({ count: 10n }).count).toBe("10");
		const deep = { a: { b: { c: { d: { e: { f: "x" } } } } } };
		expect(JSON.stringify(scrubRecord(deep))).toContain("[Truncated]");
		const many: Record<string, unknown> = {};
		for (let index = 0; index < 60; index += 1) many[`k${index}`] = index;
		expect(Object.keys(scrubRecord(many))).toHaveLength(50);
		expect(scrubRecord({ items: Array.from({ length: 60 }, (_, i) => i) }).items).toHaveLength(50);
	});

	it("scrubValue handles primitives", () => {
		expect(scrubValue("Bearer abc123DEF456")).toBe("Bearer [Filtered]");
		expect(scrubValue(42)).toBe(42);
		expect(stripUndefined({ a: 1, b: undefined } as Record<string, unknown>)).toEqual({ a: 1 });
		expect(describeThrown("oops cus_1A2b3C4d5E6F7G8H")).toBe("oops cus_[Filtered]");
		expect(describeThrown(new Error("bad cus_1A2b3C4d5E6F7G8H"))).toBe("bad cus_[Filtered]");
	});
});

describe("scrubBreadcrumb", () => {
	it("drops console and scrubs http", () => {
		expect(scrubBreadcrumb({ category: "console", message: "x", level: "info" })).toBeNull();
		const cleaned = scrubBreadcrumb({
			category: "http",
			message: "GET https://example.com/v1/billing-accounts/abc?x=1",
			level: "info",
			data: {
				url: "https://example.com/v1/billing-accounts/abc?x=1",
				"http.query": "x=1",
				arguments: ["secret"],
				method: "GET",
			},
		});
		expect(cleaned?.data?.url).toBe("https://example.com/v1/billing-accounts/:id");
		expect(cleaned?.data?.["http.query"]).toBeUndefined();
		expect(cleaned?.data?.arguments).toBeUndefined();
	});
});

describe("scrubSpan", () => {
	it("masks stripe urls and drops sensitive span data", () => {
		const cleaned = scrubSpan({
			span_id: "a",
			trace_id: "b",
			start_timestamp: 1,
			data: {
				"http.request.header.cookie": "secret",
				"url.path.parameter.id": "abc",
				"db.query.parameter.1": "secret",
				"db.statement": "SELECT *",
				"url.query": "x=1",
				"user_agent.original": "agent",
				"client.address": "10.0.0.1",
				safe: "ok",
			},
			description: "GET https://api.stripe.com/v1/customers/cus_1A2b3C4d5E6F7G8H",
		});
		expect(cleaned.description).toBe("GET https://api.stripe.com/v1/customers/:id");
		expect(cleaned.data["http.request.header.cookie"]).toBeUndefined();
		expect(cleaned.data["db.statement"]).toBeUndefined();
		expect(cleaned.data.safe).toBe("ok");
	});

	it("scrubSpanData handles undefined", () => {
		expect(scrubSpanData(undefined)).toEqual({});
	});
});

describe("scrubEvent", () => {
	it("scrubs a bun-server error shape", () => {
		const input = {
			message: "Bearer secret-token-ABC123DEF456789012345678",
			logentry: { message: "failed for user@example.com" },
			exception: {
				values: [
					{
						value: "failed cus_1A2b3C4d5E6F7G8H with Bearer abcDEF123456",
						stacktrace: { frames: [{ filename: "a.ts", vars: { secret: "x" } }] },
					},
				],
			},
			request: {
				method: "POST",
				url: "https://api.example.com/v1/billing-accounts/abc/usage?token=secret",
				headers: { authorization: "Bearer secret" },
				cookies: { session: "secret" },
				query_string: "token=secret",
			},
			transaction: "POST /v1/billing-accounts/abc/usage/consume",
			breadcrumbs: [
				{ category: "console", message: "log", level: "info" as const },
				{
					category: "http",
					message: "GET",
					level: "info" as const,
					data: { url: "https://api.example.com/v1/customers/abc?x=1", "http.query": "x=1" },
				},
			],
			contexts: {
				trace: { data: { "url.full": "https://x/y?z=1", "http.request.header.cookie": "c" } },
				response: { status_code: 500, headers: { "set-cookie": "s" } },
				billing: { projectKey: "voysee", authorization: "secret" },
				os: { name: "linux" },
			},
			extra: { authorization: "secret", jobId: "abc" },
			tags: { route: "/v1/billing-accounts/abc", safe: "ok" },
			spans: [
				{
					span_id: "a",
					trace_id: "b",
					start_timestamp: 1,
					data: { "http.request.header.x": "y" },
					description: "GET /v1/billing-accounts/abc",
				},
			],
			user: { id: "123" },
		} as unknown as ErrorEvent;
		const cleaned = scrubEvent(input) as unknown as {
			message?: string;
			logentry?: { message?: string };
			exception?: {
				values?: Array<{
					value?: string;
					stacktrace?: { frames?: Array<Record<string, unknown>> };
				}>;
			};
			request?: Record<string, unknown>;
			transaction?: string;
			breadcrumbs?: Array<Record<string, unknown>>;
			contexts?: Record<string, Record<string, unknown>>;
			extra?: Record<string, unknown>;
			user?: unknown;
			spans?: unknown[];
		};
		expect(cleaned.message).not.toContain("secret-token");
		expect(cleaned.logentry?.message).toBe("failed for [email]");
		expect(cleaned.exception?.values?.[0]?.value).toContain("cus_[Filtered]");
		expect(cleaned.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
		expect(cleaned.request).toEqual({
			method: "POST",
			url: "https://api.example.com/v1/billing-accounts/:id/usage",
		});
		expect((cleaned as Record<string, unknown>).user).toBeUndefined();
		expect(cleaned.transaction).toBe("POST /v1/billing-accounts/:id/usage/consume");
		expect(cleaned.breadcrumbs).toHaveLength(1);
		expect(cleaned.contexts?.response).toEqual({ status_code: 500 });
		expect(cleaned.contexts?.billing).toEqual({ projectKey: "voysee" });
		expect(cleaned.contexts?.os).toEqual({ name: "linux" });
		expect(cleaned.extra).toEqual({ jobId: "abc" });
		expect(cleaned.spans).toHaveLength(1);
	});
});

describe("scrubLog", () => {
	it("drops user attributes and scrubs message", () => {
		const cleaned = scrubLog({
			level: "error",
			message: "failed user@example.com with Bearer abcDEF123456789012345678901234567890" as never,
			attributes: { "user.email": "user@example.com", "server.address": "10.0.0.1", jobId: "x" },
		});
		expect(cleaned.message).toContain("[email]");
		expect(cleaned.attributes?.["user.email"]).toBeUndefined();
		expect(cleaned.attributes?.["server.address"]).toBe("[ip]");
		expect(cleaned.attributes?.jobId).toBe("x");
	});
});
