import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createApp as createBillingApp } from "../../src/app";
import type { AppDependencies } from "../../src/app/types";
import type { MeteringServiceLike } from "../../src/billing/metering";
import type { UsageApiServiceLike } from "../../src/billing/usage-api";
import { composeRuntimeApp } from "../../src/composition/merchant-runtime";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import type { FixtureBillingEnv as BillingEnv } from "../../src/testing/connection-fixtures";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
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

const auth = { authorization: "Bearer secret" };
const consumePath = "/v1/billing-accounts/user_1/usage/consume";
const validUsage = JSON.stringify({ featureId: "api_calls", value: "1" });

function createApp(
	dependencies: Partial<Omit<AppDependencies, "env">> & {
		rateLimit?: Partial<BillingEnv["rateLimit"]>;
	} = {},
) {
	const { rateLimit, ...rest } = dependencies;
	let credentialLookups = 0;
	const resolver = projectContextResolver({
		contexts: [projectInstanceContext("acme")],
		credentials: { secret: "acme" },
	});
	const app = createBillingApp({
		env: { ...env, rateLimit: { ...env.rateLimit, ...rateLimit } },
		connections: fixtureConnections(env.connectionFixtures),
		projectContextResolver: {
			...resolver,
			resolveCredential(token) {
				credentialLookups += 1;
				return resolver.resolveCredential(token);
			},
		},
		...rest,
	});
	return { app, credentialLookups: () => credentialLookups };
}

function recordingMeteringService() {
	const calls: string[] = [];
	const record =
		(name: string) =>
		async (..._args: unknown[]): Promise<never> => {
			calls.push(name);
			return { recorded: name } as never;
		};
	const service: MeteringServiceLike = {
		getOperation: record("getOperation"),
		getBalance: record("getBalance"),
		check: record("check"),
		consume: record("consume"),
		reserve: record("reserve"),
		confirm: record("confirm"),
		release: record("release"),
		correct: record("correct"),
	};
	return {
		service,
		calls,
		usage: {
			check: record("check"),
			consume: record("consume"),
			createAccount: record("createAccount"),
			getAccount: record("getAccount"),
			getReceipt: record("getReceipt"),
			listReceiptDeductions: record("listReceiptDeductions"),
		} satisfies UsageApiServiceLike,
	};
}

function send(
	app: { handle(request: Request): Promise<Response> },
	url: string,
	init?: RequestInit,
) {
	return app.handle(new Request(new URL(url, "http://localhost"), init));
}

/** A request body that is only produced as the server pulls it, so reads can be measured. */
function meteredStream(totalBytes: number, chunkBytes = 64 * 1024) {
	let pulled = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled >= totalBytes) {
				controller.close();
				return;
			}
			const size = Math.min(chunkBytes, totalBytes - pulled);
			pulled += size;
			controller.enqueue(new Uint8Array(size).fill(120));
		},
	});
	return { stream, pulled: () => pulled };
}

describe("private request bodies", () => {
	it("rejects non-finite JSON filter numbers before invoking metering", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});
		for (const value of ["1e400", "-1e400"]) {
			const response = await send(app, consumePath, {
				method: "POST",
				headers: { ...auth, "idempotency-key": "non-finite", "content-type": "application/json" },
				body: `{"featureKey":"api_calls","quantity":"1","filters":{"size":${value}}}`,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "INVALID_REQUEST",
					message: "Request validation failed",
					requestId: expect.any(String),
				},
			});
		}
		expect(metering.calls).toEqual([]);
	});

	it("rejects form, multipart and binary bodies without reaching the handler", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});
		const form = new FormData();
		form.set("featureKey", "api_calls");
		form.set("quantity", "1");
		const bodies: Array<{ label: string; init: RequestInit }> = [
			{
				label: "urlencoded",
				init: {
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: "featureKey=api_calls&quantity=1",
				},
			},
			{ label: "multipart", init: { body: form } },
			{
				label: "binary",
				init: {
					headers: { "content-type": "application/octet-stream" },
					body: new Uint8Array([0, 1]),
				},
			},
		];

		for (const { label, init } of bodies) {
			const response = await send(app, consumePath, {
				...init,
				method: "POST",
				headers: { ...auth, "idempotency-key": "hardening", ...init.headers },
			});
			expect(response.status, label).toBe(400);
		}
		expect(metering.calls).toEqual([]);
	});

	it("still parses JSON sent with a non-JSON content type, as the API always has", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});

		const response = await send(app, consumePath, {
			method: "POST",
			headers: { ...auth, "idempotency-key": "hardening", "content-type": "text/plain" },
			body: validUsage,
		});

		expect(response.status).toBe(200);
		expect(metering.calls).toEqual(["consume"]);
	});

	it("stops reading oversized chunked bodies of every content type at the cap", async () => {
		for (const contentType of [
			"application/json",
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=quotum",
			"application/octet-stream",
		]) {
			const { app, credentialLookups } = createApp();
			const body = meteredStream(8 * 1024 * 1024);
			const response = await send(app, consumePath, {
				method: "POST",
				// No credentials: the parser runs before authentication, so the cap must hold here.
				headers: { "content-type": contentType },
				body: body.stream,
				duplex: "half",
			} as RequestInit);

			expect(response.status, contentType).toBe(413);
			expect(body.pulled(), contentType).toBeLessThanOrEqual(256 * 1024 + 2 * 64 * 1024);
			expect(credentialLookups(), contentType).toBe(0);
		}
	});

	it("accepts a reservation release without a body", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});

		const response = await send(
			app,
			"/v1/billing-accounts/user_1/usage/reservations/00000000-0000-4000-8000-000000000001/release",
			{ method: "POST", headers: { ...auth, "idempotency-key": "hardening" } },
		);

		expect(response.status).toBe(200);
		expect(metering.calls).toEqual(["release"]);
	});

	it("rejects an empty chunked body instead of handing it to another parser", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});

		const response = await send(
			app,
			"/v1/billing-accounts/user_1/usage/reservations/00000000-0000-4000-8000-000000000001/release",
			{
				method: "POST",
				headers: { ...auth, "idempotency-key": "hardening", "content-type": "application/json" },
				body: meteredStream(0).stream,
				duplex: "half",
			} as RequestInit,
		);

		expect(response.status).toBe(400);
		expect(metering.calls).toEqual([]);
	});
});

/** A request body produced only as the server pulls it, with no read-ahead: unread means zero. */
function unreadStream(totalBytes: number, chunkBytes = 64 * 1024) {
	let pulled = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (pulled >= totalBytes) {
					controller.close();
					return;
				}
				const size = Math.min(chunkBytes, totalBytes - pulled);
				pulled += size;
				controller.enqueue(new Uint8Array(size).fill(120));
			},
		},
		{ highWaterMark: 0 },
	);
	return { stream, pulled: () => pulled };
}

const bodylessOperations = [
	{ method: "POST", path: "/v1/admin/store-events/11111111-1111-4111-8111-111111111111/replay" },
	{ method: "POST", path: "/v1/admin/reconciliation/subscriptions/run" },
	{ method: "POST", path: "/v1/admin/projection-jobs/22222222-2222-4222-8222-222222222222/retry" },
	{ method: "POST", path: "/v1/admin/auto-topups/user_1/7/reset" },
	{ method: "DELETE", path: "/v1/admin/contracts/user_1/8" },
	{ method: "DELETE", path: "/v1/billing-accounts/user_1/license-assignments/9" },
	{
		method: "POST",
		path: "/v1/billing-accounts/user_1/providers/stripe/checkout-sessions/cs_test_1/expire",
	},
] as const;

const bodyContentTypes = [
	"application/json",
	"text/plain",
	"application/x-www-form-urlencoded",
	"multipart/form-data; boundary=quotum",
	"application/octet-stream",
];

/** Services for the body-less operations; each records its call and returns a plain result. */
function bodylessServices() {
	const calls: string[] = [];
	const result =
		(name: string) =>
		async (..._args: unknown[]): Promise<never> => {
			calls.push(name);
			return { handled: name } as never;
		};
	return {
		calls,
		dependencies: {
			adminOperations: {
				replayStoreEvent: result("replayStoreEvent"),
				runSubscriptionReconciliation: result("runSubscriptionReconciliation"),
				retryProjectionSyncJob: result("retryProjectionSyncJob"),
			} as never,
			controlsEnterpriseService: {
				resetAutoTopupCircuit: result("resetAutoTopupCircuit"),
				terminateEnterpriseContract: result("terminateEnterpriseContract"),
				revokeLicense: result("revokeLicense"),
			} as never,
			stripeBillingService: { expireCheckoutSession: result("expireCheckoutSession") } as never,
		},
	};
}

describe("input Postgres would refuse", () => {
	const invalid = { success: false, error: { code: "INVALID_REQUEST" } };

	it("refuses a request body nested deeper than the walk allows", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});
		for (const depth of [100, 100_000]) {
			const response = await send(app, consumePath, {
				method: "POST",
				headers: {
					...auth,
					"idempotency-key": `deep-${depth}`,
					"content-type": "application/json",
				},
				body: `{"featureKey":"api_calls","quantity":"1","metadata":{"x":${"[".repeat(depth)}${"]".repeat(depth)}}}`,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject(invalid);
		}
		expect(metering.calls).toEqual([]);
	});

	it("refuses NUL characters and unpaired surrogates in bodies, paths and queries", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});
		for (const body of [
			'{"featureKey":"api\\u0000calls","quantity":"1"}',
			'{"featureKey":"api_calls","quantity":"1","metadata":{"note":"a\\u0000b"}}',
			'{"featureKey":"api_calls","quantity":"1","metadata":{"a\\u0000b":"note"}}',
			'{"featureKey":"api_calls","quantity":"1","metadata":{"note":"\\ud800"}}',
		]) {
			const response = await send(app, consumePath, {
				method: "POST",
				headers: { ...auth, "idempotency-key": "unstorable", "content-type": "application/json" },
				body,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject(invalid);
		}
		for (const path of [
			"/v1/billing-accounts/user%001/balances/api_calls",
			"/v1/billing-accounts/user_1/usage/events?featureKey=api%00calls",
		]) {
			const response = await send(app, path, { headers: auth });
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject(invalid);
		}
		expect(metering.calls).toEqual([]);
	});

	it("refuses dates a timestamp column cannot hold", async () => {
		const metering = recordingMeteringService();
		const { app } = createApp({
			usageApiService: metering.usage,
			meteringService: metering.service,
		});
		const response = await send(app, consumePath, {
			method: "POST",
			headers: { ...auth, "idempotency-key": "year-zero", "content-type": "application/json" },
			body: JSON.stringify({
				featureKey: "api_calls",
				quantity: "1",
				occurredAt: "0000-01-01T00:00:00Z",
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject(invalid);
		expect(metering.calls).toEqual([]);
	});
});

describe("documented bounds", () => {
	it("refuses a license assignment above the documented quantity limit before the service", async () => {
		const calls: string[] = [];
		const controlsEnterpriseService = new Proxy(
			{},
			{
				get: (_target, name) => async () => {
					calls.push(String(name));
					return {};
				},
			},
		) as NonNullable<AppDependencies["controlsEnterpriseService"]>;
		const { app } = createApp({ controlsEnterpriseService });
		const response = await send(app, "/v1/billing-accounts/user_1/license-assignments", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json", "x-billing-actor": "ops" },
			body: JSON.stringify({ poolId: "1", entityId: "seat_1", quantity: 1_000_001 }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "INVALID_REQUEST" },
		});
		expect(calls).toEqual([]);
	});
});

describe("operations without a request body", () => {
	it("never reads the body of an unauthenticated request", async () => {
		for (const { method, path } of bodylessOperations) {
			for (const contentType of bodyContentTypes) {
				const label = `${method} ${path} ${contentType}`;
				const { app, credentialLookups } = createApp();
				const body = unreadStream(8 * 1024 * 1024);
				const request = new Request(new URL(path, "http://localhost"), {
					method,
					headers: { authorization: "Bearer wrong", "content-type": contentType },
					body: body.stream,
					duplex: "half",
				} as RequestInit);

				const response = await app.handle(request);

				expect(response.status, label).toBe(401);
				expect(await response.json(), label).toEqual({
					success: false,
					error: {
						code: "UNAUTHORIZED",
						message: "Invalid billing API key",
						requestId: expect.any(String),
					},
				});
				expect(credentialLookups(), label).toBe(1);
				expect(body.pulled(), label).toBe(0);
				expect(request.bodyUsed, label).toBe(false);
			}
		}
	});

	it("runs each operation without reading the body it was sent", async () => {
		for (const { method, path } of bodylessOperations) {
			for (const contentType of bodyContentTypes) {
				const label = `${method} ${path} ${contentType}`;
				const services = bodylessServices();
				const { app } = createApp(services.dependencies);
				const body = unreadStream(8 * 1024 * 1024);
				const request = new Request(new URL(path, "http://localhost"), {
					method,
					headers: {
						...auth,
						"x-billing-operator-key": "operator-secret-key",
						"x-billing-actor": "operator@example.com",
						"content-type": contentType,
					},
					body: body.stream,
					duplex: "half",
				} as RequestInit);

				const response = await app.handle(request);

				expect(response.status, label).toBe(200);
				expect(services.calls, label).toHaveLength(1);
				expect(body.pulled(), label).toBe(0);
				expect(request.bodyUsed, label).toBe(false);
			}
		}
	});
});

describe("requests without a usable Host", () => {
	/** Raw HTTP, because a Request object cannot carry the relative URL Bun builds without a Host. */
	async function rawRequest(port: number, head: string): Promise<{ status: number; body: string }> {
		const { connect } = await import("node:net");
		const text = await new Promise<string>((resolve) => {
			let data = "";
			const socket = connect(port, "127.0.0.1", () => socket.write(`${head}\r\n\r\n`));
			socket.on("data", (chunk) => {
				data += chunk;
			});
			socket.on("close", () => resolve(data));
		});
		const [statusLine = "", ...rest] = text.split("\r\n");
		return {
			status: Number(statusLine.split(" ")[1]),
			body: rest.join("\r\n").split("\r\n\r\n").slice(1).join(""),
		};
	}

	it("answers /v1 with a JSON 400 and keeps health checks working", async () => {
		const { app } = createApp();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => app.handle(request),
		});
		try {
			for (const head of [
				"GET /v1/catalog HTTP/1.0",
				"GET /v1/catalog HTTP/1.1\r\nHost: \r\nConnection: close",
				"GET /v1/catalog HTTP/1.1\r\nHost: a b\r\nConnection: close",
			]) {
				const response = await rawRequest(server.port ?? 0, head);
				expect(response.status).toBe(400);
				expect(JSON.parse(response.body)).toMatchObject({
					success: false,
					error: { code: "INVALID_REQUEST" },
				});
			}
			expect((await rawRequest(server.port ?? 0, "GET /livez HTTP/1.0")).status).toBe(200);
		} finally {
			server.stop(true);
		}
	});
});

describe("routing", () => {
	it("keeps the verify limiter on every URL form that reaches the verify handler", async () => {
		const { app } = createApp({ rateLimit: { verifyLimit: 1 } });
		const verify = (url: string) =>
			send(app, url, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: "{}",
			});

		expect((await verify("/v1/purchases/verify")).status).toBe(400);
		expect((await verify("/v1/purchases/verify/")).status).toBe(404);
		const shifted = await verify("http://a/xx/v1/purchases/verify");
		expect(shifted.status).toBe(429);
		expect(shifted.headers.get("ratelimit-remaining")).toBe("0");
	});
});

describe("metering operation metrics", () => {
	function operations(rendered: string): string[] {
		return rendered
			.split("\n")
			.filter((line) => line.startsWith("billing_metering_operations_total{"))
			.sort();
	}

	it("labels operations by routed path and counts every failed authenticated request", async () => {
		const metrics = createInMemoryBillingMetrics();
		const metering = recordingMeteringService();
		const { app } = createApp({
			metrics,
			usageApiService: metering.usage,
			meteringService: metering.service,
			rateLimit: { meteringLimit: 2 },
		});
		const check = (body: string, headers: Record<string, string> = auth) =>
			send(app, "/v1/billing-accounts/user_1/usage/check?trace=1", {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body,
			});

		expect((await check(validUsage)).status).toBe(200);
		expect((await check("{}")).status).toBe(400);
		expect((await check(validUsage, {})).status).toBe(401);
		expect(
			(
				await send(
					app,
					"/v1/billing-accounts/user_1/usage/operations/consume/00000000-0000-4000-8000-000000000001",
					{ headers: auth },
				)
			).status,
		).toBe(200);
		expect((await check(validUsage)).status).toBe(429);
		// Usage insights share the /usage/ prefix but are not metering operations.
		await send(app, "/v1/billing-accounts/user_1/usage/series?featureKey=api_calls", {
			headers: auth,
		});

		expect(operations(metrics.renderPrometheus())).toEqual([
			'billing_metering_operations_total{operation="check",result="completed"} 1',
			'billing_metering_operations_total{operation="check",result="failed"} 2',
			'billing_metering_operations_total{operation="lookup",result="completed"} 1',
		]);
	});
});

describe("composed runtime", () => {
	it("keys client-IP limits by the Bun server's address for the staff app", async () => {
		const { app: staff } = createApp({ rateLimit: { verifyLimit: 1 } });
		const runtime = composeRuntimeApp({ staff, merchant: new Elysia() });
		const verifyFrom = (address: string) => {
			const request = new Request("http://localhost/v1/purchases/verify", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: "{}",
			});
			return runtime.fetch(request, { requestIP: () => ({ address }) });
		};

		expect((await verifyFrom("192.0.2.1")).status).toBe(400);
		expect((await verifyFrom("192.0.2.2")).status).toBe(400);
		expect((await verifyFrom("192.0.2.1")).status).toBe(429);
	});

	it("dispatches /api to the merchant app and everything else to the staff app", async () => {
		const staff = new Elysia().get("/health", () => "staff").get("/", () => "root");
		const merchant = new Elysia().get("/api/platform/config", () => "merchant");
		const runtime = composeRuntimeApp({ staff, merchant });
		const text = async (path: string) =>
			(await runtime.fetch(new Request(`http://localhost${path}`))).text();

		expect(await text("/health")).toBe("staff");
		expect(await text("/")).toBe("root");
		expect(await text("/api/platform/config")).toBe("merchant");
	});
});
