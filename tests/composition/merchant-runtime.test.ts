import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { attachHeadlessRuntime, composeRuntimeApp } from "../../src/composition/merchant-runtime";
import { createRemoteMcpApp } from "../../src/composition/remote-mcp";
import type { MerchantBillingPort } from "../../src/platform/application/billing-port";
import type { MerchantAuth } from "../../src/platform/auth";
import { MerchantError } from "../../src/platform/security";
import type { MerchantStore } from "../../src/platform/store";
import type { AppElysia } from "../../src/shared/http";
import { assertOpenApiResponse } from "../helpers/openapi";

function staffApp() {
	return new Elysia().get("/v1/ping", () => ({ scope: "staff" }));
}

/** Runs synchronous composition with process settings it reads at construction, then restores them. */
function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	const assign = (entries: Record<string, string | undefined>) => {
		for (const [name, value] of Object.entries(entries)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	assign(values);
	try {
		return run();
	} finally {
		assign(previous);
	}
}

function merchantApp() {
	return new Elysia().get("/api/ping", () => ({ scope: "merchant" }));
}

describe("composeRuntimeApp request scopes", () => {
	it("isolates MCP Host, Origin, rate limits and error handling from health and API routes", async () => {
		const calls: string[] = [];
		let rateLimits = 0;
		const store = {
			config: { origin: "https://app.example.test", mcp: { origin: "https://api.example.test" } },
			async rateLimit() {
				if (++rateLimits > 3) throw new MerchantError("RATE_LIMITED", "Too many requests.", 429);
			},
		} as unknown as MerchantStore;
		const remoteMcp = createRemoteMcpApp({
			store,
			auth: {} as MerchantAuth,
			port: {} as MerchantBillingPort,
		});
		const app = composeRuntimeApp({
			staff: staffApp()
				.get("/livez", () => "live")
				.get("/ready", () => "ready"),
			merchant: merchantApp(),
			remoteMcp,
			mcpRequestScope: {
				run(request, dispatch) {
					calls.push(new URL(request.url).pathname);
					return dispatch();
				},
			},
		});
		for (const path of ["/livez", "/ready", "/v1/ping", "/api/ping"])
			expect(
				(
					await app.fetch(
						new Request(`http://127.0.0.1${path}`, {
							headers: { origin: "https://product.example.test" },
						}),
					)
				).status,
			).toBe(200);
		expect(rateLimits).toBe(0);
		expect(calls).toEqual([]);
		expect((await app.fetch(new Request("https://wrong.example.test/mcp"))).status).toBe(403);
		expect(
			(
				await app.fetch(
					new Request("https://api.example.test/mcp", {
						headers: { origin: "https://wrong.example.test" },
					}),
				)
			).status,
		).toBe(403);
		for (const path of [
			"/.well-known/oauth-authorization-server",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/mcp",
		]) {
			const response = await app.fetch(new Request(`https://api.example.test${path}`));
			expect(response.status).toBe(200);
			await assertOpenApiResponse("GET", path, response);
		}
		const limited = await app.fetch(new Request("https://api.example.test/mcp"));
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({ error: "RATE_LIMITED" });
		expect((await app.fetch(new Request("http://127.0.0.1/livez"))).status).toBe(200);
		expect(calls).toHaveLength(6);
	});

	it("reports unexpected MCP errors with request context without returning diagnostics", async () => {
		const failure = new Error("private database failure");
		const reports: Array<{ error: unknown; route: string; requestId: string }> = [];
		const remoteMcp = createRemoteMcpApp({
			store: {
				config: { origin: "https://app.example.test", mcp: { origin: "https://api.example.test" } },
				async rateLimit() {
					throw failure;
				},
			} as unknown as MerchantStore,
			auth: {} as MerchantAuth,
			port: {} as MerchantBillingPort,
			onUnexpectedError: (error, report) => {
				reports.push({ error, ...report });
			},
		});
		const app = composeRuntimeApp({ staff: staffApp(), merchant: merchantApp(), remoteMcp });
		const response = await app.fetch(new Request("https://api.example.test/mcp"));
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("private database failure");
		expect(reports).toHaveLength(1);
		expect(reports[0]?.error).toBe(failure);
		expect(reports[0]?.requestId).toBe(response.headers.get("x-request-id") ?? "");
	});

	it("runs /api inside only the merchant scope and the fallback inside only the staff scope", async () => {
		const calls: string[] = [];
		const recordingScope = (name: string) => ({
			run<T>(request: Request, dispatch: () => T): T {
				calls.push(`${name}:${new URL(request.url).pathname}`);
				return dispatch();
			},
		});
		const app = composeRuntimeApp({
			staff: staffApp(),
			merchant: merchantApp(),
			staffRequestScope: recordingScope("staff"),
			merchantRequestScope: recordingScope("merchant"),
		});

		const merchantResponse = await app.fetch(new Request("http://localhost/api/ping"));
		expect(await merchantResponse.json()).toEqual({ scope: "merchant" });
		expect(calls).toEqual(["merchant:/api/ping"]);

		const staffResponse = await app.fetch(new Request("http://localhost/v1/ping"));
		expect(await staffResponse.json()).toEqual({ scope: "staff" });
		expect(calls).toEqual(["merchant:/api/ping", "staff:/v1/ping"]);
	});

	it("works without scopes", async () => {
		const app = composeRuntimeApp({ staff: staffApp(), merchant: merchantApp() });

		expect((await app.fetch(new Request("http://localhost/api/ping"))).status).toBe(200);
		expect((await app.fetch(new Request("http://localhost/v1/ping"))).status).toBe(200);
	});

	it("sends /api to the staff API's not-found response when headless, keeping ingress", async () => {
		const calls: string[] = [];
		const ingress: AppElysia = new Elysia();
		ingress.post("/v1/setup/ping", () => ({ scope: "ingress" }));
		const app = composeRuntimeApp({
			staff: staffApp(),
			ingress: [ingress],
			staffRequestScope: {
				run(request, dispatch) {
					calls.push(new URL(request.url).pathname);
					return dispatch();
				},
			},
		});

		expect((await app.fetch(new Request("http://localhost/api/ping"))).status).toBe(404);
		expect(await (await app.fetch(new Request("http://localhost/v1/ping"))).json()).toEqual({
			scope: "staff",
		});
		const setup = await app.fetch(
			new Request("http://localhost/v1/setup/ping", { method: "POST" }),
		);
		expect(await setup.json()).toEqual({ scope: "ingress" });
		expect(calls).toEqual(["/api/ping", "/v1/ping"]);
	});

	it("keys the headless setup ingress on the forwarded client only when proxy headers are trusted", async () => {
		// The setup ingress limiter allows 120 per minute; keep the burst inside one window.
		const remaining = 60_000 - (Date.now() % 60_000);
		if (remaining < 2_000) await Bun.sleep(remaining + 10);
		const lastStatus = async (trustProxyHeaders: boolean) => {
			const app = withEnv(
				{
					QUOTUM_SECRETS_KEY_ID: "unit",
					QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
					STRIPE_APP_CLIENT_ID: undefined,
				},
				() => attachHeadlessRuntime(new Elysia(), { trustProxyHeaders }),
			);
			// Every request arrives from the proxy's socket; an unsupported provider is answered
			// before any connection lookup.
			const from = (client: string) =>
				app.fetch(
					new Request(
						`http://localhost/v1/projects/voysee/connections/${crypto.randomUUID()}/webhooks/paddle`,
						{ method: "POST", headers: { "x-forwarded-for": client }, body: "{}" },
					),
					{ requestIP: () => ({ address: "10.0.0.2" }) },
				);
			for (let index = 0; index < 121; index += 1) await from("198.51.100.66");
			return (await from("203.0.113.9")).status;
		};

		expect(await lastStatus(true)).toBe(404);
		expect(await lastStatus(false)).toBe(429);
	});
});
