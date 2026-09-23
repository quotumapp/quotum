import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { composeRuntimeApp } from "../../src/composition/merchant-runtime";
import { createRemoteMcpApp } from "../../src/composition/remote-mcp";
import type { MerchantBillingPort } from "../../src/platform/application/billing-port";
import type { MerchantAuth } from "../../src/platform/auth";
import { MerchantError } from "../../src/platform/security";
import type { MerchantStore } from "../../src/platform/store";
import { assertOpenApiResponse } from "../helpers/openapi";

function staffApp() {
	return new Elysia().get("/v1/ping", () => ({ scope: "staff" }));
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
});
