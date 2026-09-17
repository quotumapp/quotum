import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { BillingError } from "../../src/billing/errors";
import type { SentryEnv } from "../../src/env";
import { createPinoBillingLogger } from "../../src/observability/logger";
import {
	createSentryBillingLogger,
	createSentryRequestScope,
	initializeSentry,
	type SentryClientLike,
} from "../../src/observability/sentry";
import { testRequest } from "../helpers/openapi";

const sentryEnv: SentryEnv = {
	dsn: "https://sentry.example/123",
	environment: "test",
	release: "quotum-api@1.2.3",
	enableLogs: true,
	tracesSampleRate: 0.01,
	logLevel: "warn",
	captureExpectedErrors: false,
};

describe("initializeSentry", () => {
	it("passes billing Sentry config to the SDK", () => {
		const initCalls: unknown[] = [];
		const sentry = {
			init(options: unknown) {
				initCalls.push(options);
			},
		} satisfies SentryClientLike;

		initializeSentry(sentry, sentryEnv);

		expect(initCalls).toHaveLength(1);
		const options = initCalls[0] as {
			dsn: string;
			environment: string;
			release?: string;
			enableLogs: boolean;
			tracesSampleRate: number;
			dataCollection: Record<string, unknown>;
			maxValueLength: number;
			normalizeDepth: number;
			integrations(defaults: Array<{ name: string }>): Array<{ name: string }>;
			beforeSend(event: unknown, hint: unknown): unknown | null;
			beforeSendTransaction(event: unknown, hint: unknown): unknown | null;
			beforeSendSpan(span: unknown): unknown;
			beforeBreadcrumb(breadcrumb: unknown, hint?: unknown): unknown | null;
			beforeSendLog(log: {
				level: string;
				message: string;
				attributes?: Record<string, unknown>;
			}): unknown | null;
		};
		expect(options.dsn).toBe("https://sentry.example/123");
		expect(options.environment).toBe("test");
		expect(options.release).toBe("quotum-api@1.2.3");
		expect(options.enableLogs).toBe(true);
		expect(options.tracesSampleRate).toBe(0.01);
		expect(options.dataCollection).toEqual({
			userInfo: false,
			cookies: false,
			httpHeaders: { request: false, response: false },
			httpBodies: [],
			urlQueryParams: false,
			graphQL: { document: false, variables: false },
			genAI: { inputs: false, outputs: false },
			databaseQueryData: false,
			stackFrameVariables: false,
		});
		expect(options.maxValueLength).toBe(1024);
		expect(options.normalizeDepth).toBe(5);
		expect(
			options.integrations([{ name: "Console" }, { name: "Http" }]).map((i) => i.name),
		).toEqual(["Http"]);
		expect("sendDefaultPii" in options).toBe(false);

		const noisyInfo = { level: "info", message: "Routine detail" };
		const workerSummary = {
			level: "info",
			message: "Projection sync run completed",
			attributes: { "billing.category": "worker_run" },
		};
		const warning = { level: "warn", message: "Provider retry delayed" };
		expect(options.beforeSendLog(noisyInfo)).toBeNull();
		expect(options.beforeSendLog(workerSummary)).toEqual(workerSummary);
		expect(options.beforeSendLog(warning)).toEqual(warning);
	});

	it("omits release when unset", () => {
		const initCalls: unknown[] = [];
		const sentry = {
			init(options: unknown) {
				initCalls.push(options);
			},
		} satisfies SentryClientLike;

		initializeSentry(sentry, { ...sentryEnv, release: null });

		const options = initCalls[0] as { release?: string };
		expect("release" in options).toBe(false);
	});

	it("scrubs through every hook and drops on scrubber throw", () => {
		const initCalls: unknown[] = [];
		const sentry = {
			init(options: unknown) {
				initCalls.push(options);
			},
		} satisfies SentryClientLike;

		initializeSentry(sentry, sentryEnv);
		const options = initCalls[0] as {
			beforeSend(event: Record<string, unknown>, hint: unknown): unknown | null;
			beforeSendTransaction(event: Record<string, unknown>, hint: unknown): unknown | null;
			beforeSendSpan(span: Record<string, unknown>): Record<string, unknown>;
			beforeBreadcrumb(breadcrumb: Record<string, unknown>, hint?: unknown): unknown | null;
			beforeSendLog(log: Record<string, unknown>): unknown | null;
		};
		expect(
			options.beforeSend(
				{
					message: "hi user@example.com",
					request: { url: "https://x/y?z=1", headers: { a: "b" } },
				},
				{},
			),
		).toMatchObject({ message: "hi [email]" });
		expect(
			options.beforeSendTransaction({ transaction: "GET /v1/billing-accounts/abc" }, {}),
		).toMatchObject({ transaction: "GET /v1/billing-accounts/:id" });
		expect(options.beforeBreadcrumb({ category: "console", message: "x" }, {})).toBeNull();
		expect(
			options.beforeSendLog({
				level: "error",
				message: "bad user@example.com",
				attributes: { "user.email": "a@b.com" },
			}),
		).toMatchObject({ message: "bad [email]" });

		const throwing = new Proxy(
			{ message: "x", description: "x", data: {}, level: "error" },
			{
				get() {
					throw new Error("scrub boom");
				},
			},
		);
		expect(options.beforeSend(throwing as Record<string, unknown>, {})).toBeNull();
		expect(options.beforeSendTransaction(throwing as Record<string, unknown>, {})).toBeNull();
		expect(options.beforeBreadcrumb(throwing as Record<string, unknown>, {})).toBeNull();
		expect(options.beforeSendLog(throwing as Record<string, unknown>)).toBeNull();

		// Spans cannot be dropped, so a span whose data cannot be scrubbed keeps only its identity.
		const unreadableData = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("scrub boom");
				},
			},
		);
		const stripped = options.beforeSendSpan({
			span_id: "a",
			trace_id: "b",
			start_timestamp: 1,
			description: "GET /v1/billing-accounts/abc",
			data: unreadableData,
		});
		expect(stripped).toEqual({
			span_id: "a",
			trace_id: "b",
			start_timestamp: 1,
			description: "[Filtered]",
			data: {},
		});
	});

	it("skips SDK initialization when Sentry is disabled", () => {
		const initCalls: unknown[] = [];
		const sentry = {
			init(options: unknown) {
				initCalls.push(options);
			},
		} satisfies SentryClientLike;

		initializeSentry(sentry, { ...sentryEnv, dsn: null });

		expect(initCalls).toEqual([]);
	});
});

describe("createSentryBillingLogger", () => {
	it("writes through to the base logger and captures unexpected errors with sanitized context", () => {
		const baseErrors: unknown[] = [];
		const { sentry, calls } = createRecordingSentry();
		const logger = createSentryBillingLogger({
			baseLogger: {
				info() {},
				warn() {},
				error(message, error, context) {
					baseErrors.push({ message, error, context });
				},
			},
			sentry,
			config: sentryEnv,
		});
		const error = new Error("database unavailable");

		logger.error("Projection sync failed", error, {
			worker: "projection_sync",
			projectKey: "voysee",
			authorizationHeader: "Bearer secret",
		});

		expect(baseErrors).toEqual([
			{
				message: "Projection sync failed",
				error,
				context: {
					worker: "projection_sync",
					projectKey: "voysee",
					authorizationHeader: "Bearer secret",
				},
			},
		]);
		expect(calls.logs).toEqual([
			{
				level: "error",
				message: "Projection sync failed",
				attributes: {
					"billing.category": "worker",
					"error.message": "database unavailable",
					"error.name": "Error",
					projectKey: "voysee",
					worker: "projection_sync",
				},
			},
		]);
		expect(calls.breadcrumbs).toEqual([
			{
				category: "billing.worker",
				data: {
					"billing.category": "worker",
					"error.message": "database unavailable",
					"error.name": "Error",
					projectKey: "voysee",
					worker: "projection_sync",
				},
				level: "error",
				message: "Projection sync failed",
			},
		]);
		expect(calls.captures).toEqual([error]);
		expect(calls.scopes).toEqual([
			{
				contexts: {
					billing: {
						"billing.category": "worker",
						"error.message": "database unavailable",
						"error.name": "Error",
						projectKey: "voysee",
						worker: "projection_sync",
					},
				},
				tags: {
					project_key: "voysee",
					worker: "projection_sync",
				},
			},
		]);
	});

	it("forwards once to Sentry even when local Pino output is silent", () => {
		const lines: string[] = [];
		const { sentry, calls } = createRecordingSentry();
		const logger = createSentryBillingLogger({
			baseLogger: createPinoBillingLogger({
				level: "silent",
				destination: { write: (line) => lines.push(line) },
			}),
			sentry,
			config: sentryEnv,
		});
		const error = new Error("database unavailable");
		logger.error("Projection sync failed", error, { worker: "projection_sync" });
		expect(lines).toEqual([]);
		expect(calls.logs).toHaveLength(1);
		expect(calls.captures).toEqual([error]);
	});

	it("does not capture expected BillingError responses unless configured", () => {
		const { sentry, calls } = createRecordingSentry();
		const logger = createSentryBillingLogger({
			baseLogger: createNoopBaseLogger(),
			sentry,
			config: sentryEnv,
		});

		logger.error("Apple webhook failed", new BillingError("Invalid body", "INVALID_REQUEST", 400), {
			code: "INVALID_REQUEST",
			provider: "apple",
		});

		expect(calls.logs).toHaveLength(1);
		expect(calls.breadcrumbs).toHaveLength(1);
		expect(calls.captures).toEqual([]);

		const capturingLogger = createSentryBillingLogger({
			baseLogger: createNoopBaseLogger(),
			sentry,
			config: { ...sentryEnv, captureExpectedErrors: true },
		});
		capturingLogger.error(
			"Apple webhook failed",
			new BillingError("Invalid body", "INVALID_REQUEST", 400),
			{ code: "INVALID_REQUEST", provider: "apple" },
		);

		expect(calls.captures).toHaveLength(1);
	});

	it("scrubs billing identifiers, raw payload aliases, and bearer values", () => {
		const { sentry, calls } = createRecordingSentry();
		const logger = createSentryBillingLogger({
			baseLogger: createNoopBaseLogger(),
			sentry,
			config: sentryEnv,
		});

		logger.warn("Google webhook retry delayed", {
			provider: "google",
			projectKey: "voysee",
			billingAccountId: "user_sensitive",
			customer_id: "customer_sensitive",
			transactionId: "transaction_sensitive",
			purchase_token: "purchase_token_sensitive",
			raw_payload: {
				signedPayload: "signed_payload_sensitive",
				body: "body_sensitive",
			},
			detail: "Authorization: Bearer bearer-token-sensitive",
			nested: {
				message: "retry with Bearer nested-token-sensitive",
				stripe_signature: "signature_sensitive",
			},
		});

		expect(calls.logs).toEqual([
			{
				level: "warn",
				message: "Google webhook retry delayed",
				attributes: {
					"billing.category": "webhook",
					detail: "Authorization: Bearer [Filtered]",
					nested: {
						message: "retry with Bearer [Filtered]",
					},
					projectKey: "voysee",
					provider: "google",
				},
			},
		]);
	});
});

describe("createSentryRequestScope", () => {
	function dispatch(
		requestScope: ReturnType<typeof createSentryRequestScope>,
		app: { handle(request: Request): Promise<Response> },
		path: string,
		init?: RequestInit,
	): Promise<Response> {
		const request = new Request(new URL(path, "http://localhost"), init);
		return requestScope.run(request, () => app.handle(request));
	}

	it("tags one isolation scope per request without raw sensitive request data", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "billing" });
		const app = new Elysia()
			.use(requestScope.plugin)
			.post("/v1/projects/:projectKey/webhooks/apple", () => ({ ok: true }));

		const response = await dispatch(requestScope, app, "/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"stripe-signature": "secret",
			},
			body: JSON.stringify({ signedPayload: "secret" }),
		});

		expect(response.status).toBe(200);
		expect(calls.scopes).toEqual([
			{
				contexts: {
					"billing.request": {
						method: "POST",
						projectKey: "voysee",
						provider: "apple",
						route: "/v1/projects/:projectKey/webhooks/apple",
						service: "billing",
						status: 200,
					},
				},
				tags: {
					method: "POST",
					project_key: "voysee",
					provider: "apple",
					route: "/v1/projects/:projectKey/webhooks/apple",
					service: "billing",
				},
			},
		]);
	});

	it("parameterizes billing account routes without project or provider tags", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "billing" });
		const app = new Elysia()
			.use(requestScope.plugin)
			.get("/v1/billing-accounts/:billingAccountId/usage/series", () => ({ points: [] }));

		const response = await dispatch(requestScope, app, "/v1/billing-accounts/abc/usage/series");

		expect(response.status).toBe(200);
		expect(calls.scopes).toEqual([
			{
				contexts: {
					"billing.request": {
						method: "GET",
						route: "/v1/billing-accounts/:billingAccountId/usage/series",
						service: "billing",
						status: 200,
					},
				},
				tags: {
					method: "GET",
					route: "/v1/billing-accounts/:billingAccountId/usage/series",
					service: "billing",
				},
			},
		]);
	});

	it("adds error attributes to the request scope when the handler throws a BillingError", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "billing" });
		const app = new Elysia()
			.use(requestScope.plugin)
			.post("/v1/projects/:projectKey/webhooks/stripe", () => {
				throw new BillingError("Invalid signature", "INVALID_SIGNATURE", 400);
			});

		await dispatch(requestScope, app, "/v1/projects/myproject/webhooks/stripe", {
			method: "POST",
		});

		expect(calls.scopes).toEqual([
			{
				contexts: {
					"billing.request": {
						"error.code": "INVALID_SIGNATURE",
						"error.message": "Invalid signature",
						"error.name": "BillingError",
						"error.status": 400,
						method: "POST",
						projectKey: "myproject",
						provider: "stripe",
						route: "/v1/projects/:projectKey/webhooks/stripe",
						service: "billing",
					},
				},
				tags: {
					billing_error_code: "INVALID_SIGNATURE",
					method: "POST",
					project_key: "myproject",
					provider: "stripe",
					route: "/v1/projects/:projectKey/webhooks/stripe",
					service: "billing",
				},
			},
		]);
	});

	it("keeps concurrent requests on their own scopes", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "billing" });
		const app = new Elysia()
			.use(requestScope.plugin)
			.post("/v1/projects/:projectKey/webhooks/apple", async () => {
				await Bun.sleep(1);
				return { ok: true };
			});

		await Promise.all(
			["first", "second"].map((projectKey) =>
				dispatch(requestScope, app, `/v1/projects/${projectKey}/webhooks/apple`, {
					method: "POST",
				}),
			),
		);

		expect(calls.scopes.map((scope) => scope.tags.project_key)).toEqual(["first", "second"]);
	});

	it("never tags a process-wide scope for requests dispatched outside run", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "billing" });
		const app = new Elysia().use(requestScope.plugin).get("/health", () => ({ ok: true }));

		const response = await testRequest(app, "/health");

		expect(response.status).toBe(200);
		expect(calls.scopes).toEqual([]);
	});

	it("falls back to withScope when the client does not expose an isolation scope", async () => {
		const { sentry, calls } = createRecordingSentry();
		const { withIsolationScope: _unused, ...withScopeOnly } = sentry;
		const requestScope = createSentryRequestScope(withScopeOnly, { service: "billing" });
		const app = new Elysia().use(requestScope.plugin).get("/health", () => ({ ok: true }));

		const response = await dispatch(requestScope, app, "/health");

		expect(response.status).toBe(200);
		expect(calls.scopes).toEqual([
			{
				contexts: {
					"billing.request": {
						method: "GET",
						route: "/health",
						service: "billing",
						status: 200,
					},
				},
				tags: {
					method: "GET",
					route: "/health",
					service: "billing",
				},
			},
		]);
	});

	it("uses Elysia route patterns and exposes onBeforeHandle tags inside handlers", async () => {
		const order: string[] = [];
		const { sentry, calls } = createRecordingSentry();
		const instrumented: SentryClientLike = {
			...sentry,
			withIsolationScope<T>(callback: (scope: never) => T): T {
				return sentry.withIsolationScope?.((scope) => {
					const wrapped = {
						setTag(key: string, value: string) {
							order.push(`tag:${key}=${value}`);
							return (scope as { setTag(k: string, v: string): unknown }).setTag(key, value);
						},
						setContext(key: string, context: Record<string, unknown> | null) {
							if (context?.status !== undefined) order.push(`context:status=${context.status}`);
							return (scope as { setContext(k: string, c: unknown): unknown }).setContext(
								key,
								context,
							);
						},
					};
					return callback(wrapped as never);
				}) as T;
			},
		};
		const requestScope = createSentryRequestScope(instrumented, { service: "billing" });
		const app = new Elysia()
			.use(requestScope.plugin)
			.post("/v1/billing-accounts/:billingAccountId/usage/consume", () => {
				order.push("handler");
				return { ok: true };
			});

		const response = await dispatch(requestScope, app, "/v1/billing-accounts/abc/usage/consume", {
			method: "POST",
		});

		expect(response.status).toBe(200);
		// Fallback would be :id; Elysia pattern proves onBeforeHandle overwrote it.
		expect(calls.scopes[0]?.tags.route).toBe(
			"/v1/billing-accounts/:billingAccountId/usage/consume",
		);
		const routeTagIndex = order.findIndex((entry) =>
			entry.startsWith("tag:route=/v1/billing-accounts/:billingAccountId"),
		);
		const handlerIndex = order.indexOf("handler");
		const statusIndex = order.indexOf("context:status=200");
		// onBeforeHandle tags the route before the handler runs; onAfterHandle records the status.
		expect(routeTagIndex).toBeGreaterThanOrEqual(0);
		expect(handlerIndex).toBeGreaterThan(routeTagIndex);
		expect(statusIndex).toBeGreaterThan(handlerIndex);
	});

	it("tags merchant auth wildcard with its pattern", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "merchant" });
		const app = new Elysia().use(requestScope.plugin).all("/api/auth/*", () => ({ ok: true }));

		const response = await dispatch(requestScope, app, "/api/auth/callback/google");

		expect(response.status).toBe(200);
		expect(calls.scopes[0]?.tags.route).toBe("/api/auth/*");
	});

	it("falls back to maskPath for 404s", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "billing" });
		const app = new Elysia().use(requestScope.plugin).get("/health", () => ({ ok: true }));

		const response = await dispatch(requestScope, app, "/v1/billing-accounts/abc/usage/consume");

		expect(response.status).toBe(404);
		expect(calls.scopes[0]?.tags.route).toBe("/v1/billing-accounts/:id/usage/consume");
	});

	it("bounds non-Error throws", async () => {
		const { sentry, calls } = createRecordingSentry();
		const requestScope = createSentryRequestScope(sentry, { service: "billing" });
		const app = new Elysia().use(requestScope.plugin).get("/health", () => {
			throw "oops cus_1A2b3C4d5E6F7G8H ".repeat(200) as unknown as Error;
		});

		await dispatch(requestScope, app, "/health");

		const message = calls.scopes[0]?.contexts["billing.request"]?.["error.message"];
		expect(typeof message).toBe("string");
		expect((message as string).length).toBeLessThanOrEqual(1024);
		expect(message).not.toContain("cus_1A2b3C4d5E6F7G8H");
	});

	it("still dispatches the request when Sentry fails to open a scope", async () => {
		const { sentry } = createRecordingSentry();
		const requestScope = createSentryRequestScope(
			{
				...sentry,
				withIsolationScope() {
					throw new Error("sentry unavailable");
				},
			},
			{ service: "billing" },
		);
		const app = new Elysia().use(requestScope.plugin).get("/health", () => ({ ok: true }));

		expect((await dispatch(requestScope, app, "/health")).status).toBe(200);
	});
});

function createNoopBaseLogger() {
	return {
		info() {},
		warn() {},
		error() {},
	};
}

function createRecordingSentry(): {
	sentry: SentryClientLike;
	calls: {
		logs: Array<{ level: string; message: string; attributes?: Record<string, unknown> }>;
		breadcrumbs: unknown[];
		captures: unknown[];
		scopes: Array<{
			tags: Record<string, string>;
			contexts: Record<string, Record<string, unknown>>;
		}>;
	};
} {
	const calls = {
		logs: [] as Array<{ level: string; message: string; attributes?: Record<string, unknown> }>,
		breadcrumbs: [] as unknown[],
		captures: [] as unknown[],
		scopes: [] as Array<{
			tags: Record<string, string>;
			contexts: Record<string, Record<string, unknown>>;
		}>,
	};
	const createScope = () => {
		const tags: Record<string, string> = {};
		const contexts: Record<string, Record<string, unknown>> = {};
		const scope = {
			setTag(key: string, value: string) {
				tags[key] = value;
				return scope;
			},
			setContext(key: string, context: Record<string, unknown> | null) {
				if (context !== null) {
					contexts[key] = context;
				}
				return scope;
			},
		};
		return { scope, record: { tags, contexts } };
	};
	const sentry = {
		init() {},
		logger: {
			info(message: string, attributes?: Record<string, unknown>) {
				calls.logs.push({ level: "info", message, attributes });
			},
			warn(message: string, attributes?: Record<string, unknown>) {
				calls.logs.push({ level: "warn", message, attributes });
			},
			error(message: string, attributes?: Record<string, unknown>) {
				calls.logs.push({ level: "error", message, attributes });
			},
		},
		addBreadcrumb(breadcrumb: unknown) {
			calls.breadcrumbs.push(breadcrumb);
		},
		captureException(error: unknown) {
			calls.captures.push(error);
		},
		withScope<T>(callback: (scope: ReturnType<typeof createScope>["scope"]) => T): T {
			const { scope, record } = createScope();
			const result = callback(scope);
			calls.scopes.push(record);
			return result;
		},
		withIsolationScope<T>(callback: (scope: ReturnType<typeof createScope>["scope"]) => T): T {
			const { scope, record } = createScope();
			const result = callback(scope);
			calls.scopes.push(record);
			return result;
		},
	} satisfies SentryClientLike;
	return { sentry, calls };
}
