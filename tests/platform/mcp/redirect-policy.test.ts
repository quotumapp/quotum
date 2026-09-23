import { describe, expect, it } from "bun:test";
import { validateCimdMetadata } from "@better-auth/cimd";
import { isMcpRedirectUri, withMcpRedirectPolicy } from "../../../src/platform/mcp/redirect-policy";

const clientId = "https://client.example.test/oauth.json";

describe("MCP redirect policy", () => {
	it("permits HTTPS and loopback HTTP, rejecting custom schemes and routable HTTP", () => {
		for (const uri of [
			"https://client.example.test/callback",
			"http://localhost:8787/callback",
			"http://127.0.0.1:8000/callback",
			"http://[::1]:8000/callback",
		])
			expect(isMcpRedirectUri(uri)).toBe(true);
		for (const uri of [
			"com.example.client:/callback",
			"http://client.example.test/callback",
			"http://localhost.evil.test/callback",
			"http://[::2]/callback",
			"https://user:secret@client.example.test/callback",
			"https://client.example.test/callback#fragment",
			"javascript:alert(1)",
			"/callback",
		])
			expect(isMcpRedirectUri(uri)).toBe(false);
	});

	it("rejects a private-use URI before a CIMD response can reach registration, including mixed metadata", async () => {
		for (const redirects of [
			["com.example.client:/callback"],
			["https://client.example.test/callback", "com.example.client:/callback"],
		]) {
			const metadata = { client_id: clientId, client_name: "Client", redirect_uris: redirects };
			// The installed generic CIMD profile admits this; application_type is absent.
			expect(
				validateCimdMetadata(clientId, metadata, { metadataProfile: "mcp-2026-07-28" }).valid,
			).toBe(true);
			const guarded = withMcpRedirectPolicy(async () => Response.json(metadata));
			await expect(guarded(clientId)).rejects.toMatchObject({
				body: { error: "invalid_client_metadata" },
			});
		}
	});

	it("preserves allowed documents, validators and transport options", async () => {
		const metadata = {
			client_id: clientId,
			client_name: "Client",
			redirect_uris: ["https://client.example.test/callback", "http://localhost:9000/callback"],
		};
		const signal = new AbortController().signal;
		const init = { redirect: "error" as const, signal, headers: { "if-none-match": '"v1"' } };
		let requests = 0;
		const guarded = withMcpRedirectPolicy(async (input, options) => {
			expect(input).toBe(clientId);
			expect(options).toBe(init);
			return ++requests === 1
				? Response.json(metadata, { headers: { etag: '"v1"', "cache-control": "max-age=60" } })
				: new Response(null, { status: 304, headers: { etag: '"v1"' } });
		});
		const response = await guarded(clientId, init);
		expect(await response.json()).toEqual(metadata);
		expect(response.headers.get("etag")).toBe('"v1"');
		expect(response.headers.get("cache-control")).toBe("max-age=60");
		const cached = await guarded(clientId, init);
		expect(cached.status).toBe(304);
		expect(cached.body).toBeNull();
	});

	it("caps streamed metadata before parsing it", async () => {
		let cancelled = false;
		const guarded = withMcpRedirectPolicy(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(5 * 1024 + 1));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		);
		await expect(guarded(clientId)).rejects.toBeDefined();
		expect(cancelled).toBe(true);
	});
});
