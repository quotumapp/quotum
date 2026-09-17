import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { composeRuntimeApp } from "../../src/composition/merchant-runtime";

function staffApp() {
	return new Elysia().get("/v1/ping", () => ({ scope: "staff" }));
}

function merchantApp() {
	return new Elysia().get("/api/ping", () => ({ scope: "merchant" }));
}

describe("composeRuntimeApp request scopes", () => {
	it("runs /api inside merchant scope and fallback inside staff scope", async () => {
		const calls: string[] = [];
		const staffRequestScope = {
			run<T>(request: Request, dispatch: () => T): T {
				calls.push(`staff:${new URL(request.url).pathname}`);
				return dispatch();
			},
		};
		const merchantRequestScope = {
			run<T>(request: Request, dispatch: () => T): T {
				calls.push(`merchant:${new URL(request.url).pathname}`);
				return dispatch();
			},
		};
		const app = composeRuntimeApp({
			staff: staffApp(),
			merchant: merchantApp(),
			staffRequestScope,
			merchantRequestScope,
		});

		const merchantResponse = await app.fetch(new Request("http://localhost/api/ping"));
		expect(merchantResponse.status).toBe(200);
		const staffResponse = await app.fetch(new Request("http://localhost/v1/ping"));
		expect(staffResponse.status).toBe(200);

		expect(calls).toEqual(["merchant:/api/ping", "staff:/v1/ping"]);
	});

	it("neither scope wraps the other", async () => {
		const calls: string[] = [];
		const app = composeRuntimeApp({
			staff: staffApp(),
			merchant: merchantApp(),
			staffRequestScope: {
				run<T>(request: Request, dispatch: () => T): T {
					calls.push(`staff:${new URL(request.url).pathname}`);
					return dispatch();
				},
			},
			merchantRequestScope: {
				run<T>(request: Request, dispatch: () => T): T {
					calls.push(`merchant:${new URL(request.url).pathname}`);
					return dispatch();
				},
			},
		});

		await app.fetch(new Request("http://localhost/api/ping"));
		expect(calls).toEqual(["merchant:/api/ping"]);

		calls.length = 0;
		await app.fetch(new Request("http://localhost/v1/ping"));
		expect(calls).toEqual(["staff:/v1/ping"]);
	});

	it("works without scopes", async () => {
		const app = composeRuntimeApp({ staff: staffApp(), merchant: merchantApp() });

		expect((await app.fetch(new Request("http://localhost/api/ping"))).status).toBe(200);
		expect((await app.fetch(new Request("http://localhost/v1/ping"))).status).toBe(200);
	});
});
