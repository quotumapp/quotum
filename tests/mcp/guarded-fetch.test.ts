import { describe, expect, it } from "bun:test";
import { createGuardedFetch, McpRequestBlockedError } from "../../src/mcp/guarded-fetch";

const baseUrl = "https://billing.example.com/quotum";

function guarded(
	respond: (request: Request) => Response | Promise<Response> = () => Response.json({}),
) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetch = createGuardedFetch({
		baseUrl,
		timeoutMs: 50,
		maxResponseBytes: 64,
		fetch: async (input, init) => {
			calls.push({ url: String(input), init });
			return respond(new Request(input, init));
		},
	});
	return { fetch, calls };
}

describe("MCP guarded fetch", () => {
	it("passes the listed reads and the read-only check under the base path", async () => {
		const { fetch, calls } = guarded();
		await fetch(`${baseUrl}/v1/admin/projection-jobs?status=failed`);
		await fetch(`${baseUrl}/v1/billing-accounts/account%2Fone/usage/check`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ featureKey: "tokens", quantity: "1" }),
		});
		expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
			`GET ${baseUrl}/v1/admin/projection-jobs?status=failed`,
			`POST ${baseUrl}/v1/billing-accounts/account%2Fone/usage/check`,
		]);
		expect(calls[0]?.init?.redirect).toBe("error");
		expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
		expect(calls[1]?.init?.body).toBe('{"featureKey":"tokens","quantity":"1"}');
	});

	it("blocks writes, unlisted reads and other origins before anything is sent", async () => {
		const { fetch, calls } = guarded();
		const blocked: Array<[string, RequestInit?]> = [
			[`${baseUrl}/v1/billing-accounts/a/usage/consume`, { method: "POST", body: "{}" }],
			[`${baseUrl}/v1/billing-accounts/a/usage/check/extra`, { method: "POST", body: "{}" }],
			[`${baseUrl}/v1/admin/projection-jobs/job/retry`, { method: "POST" }],
			[`${baseUrl}/v1/admin/store-events`, { method: "DELETE" }],
			[`${baseUrl}/v1/admin/catalog`],
			[`${baseUrl}/v1/admin/promotions`],
			[`${baseUrl}/v1/admin/metrics`],
			[`${baseUrl}/v1/billing-accounts/a/providers/apple/account-token`],
			["https://billing.example.com/v1/catalog"],
			["https://evil.example.com/quotum/v1/catalog"],
		];
		for (const [url, init] of blocked) {
			await expect(fetch(url, init)).rejects.toBeInstanceOf(McpRequestBlockedError);
		}
		expect(calls).toEqual([]);
	});

	it("blocks raw payload reads and operator or idempotency headers", async () => {
		const { fetch, calls } = guarded();
		await expect(
			fetch(`${baseUrl}/v1/admin/store-events/event-1?includeRawPayload=true`),
		).rejects.toBeInstanceOf(McpRequestBlockedError);
		for (const header of ["x-billing-operator-key", "x-billing-actor", "idempotency-key"]) {
			await expect(
				fetch(`${baseUrl}/v1/catalog`, { headers: { [header]: "value" } }),
			).rejects.toBeInstanceOf(McpRequestBlockedError);
		}
		expect(calls).toEqual([]);
	});

	it("caps the response size and times out a stalled API", async () => {
		const large = guarded(() => new Response("x".repeat(65)));
		await expect(large.fetch(`${baseUrl}/v1/catalog`)).rejects.toBeInstanceOf(
			McpRequestBlockedError,
		);

		const stalled = createGuardedFetch({
			baseUrl,
			timeoutMs: 20,
			fetch: (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		});
		const error = await stalled(`${baseUrl}/v1/catalog`).catch((caught: unknown) => caught);
		expect((error as Error).name).toBe("TimeoutError");
	});

	it("returns the API response unchanged within the cap", async () => {
		const { fetch } = guarded(() =>
			Response.json({ success: true }, { status: 429, headers: { "ratelimit-reset": "soon" } }),
		);
		const response = await fetch(`${baseUrl}/v1/catalog`);
		expect(response.status).toBe(429);
		expect(response.headers.get("ratelimit-reset")).toBe("soon");
		expect(await response.json()).toEqual({ success: true });
	});
});
