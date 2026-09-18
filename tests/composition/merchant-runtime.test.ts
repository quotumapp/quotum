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
