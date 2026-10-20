import { describe, expect, it } from "bun:test";
import { assertOpenApiResponse, testRequest, withOpenApiAssertions } from "./openapi";

describe("OpenAPI assertions", () => {
	it("allows unknown templates and 404/405 for undeclared methods", async () => {
		await expect(
			assertOpenApiResponse(
				"GET",
				"/not-a-documented-route",
				new Response("missing", { status: 404 }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertOpenApiResponse(
				"PATCH",
				"/v1/billing-accounts/user_1/entitlements",
				new Response("nope", { status: 405 }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertOpenApiResponse(
				"PATCH",
				"/v1/billing-accounts/user_1/entitlements",
				new Response("nope", { status: 200 }),
				{ allowUndocumented: true },
			),
		).resolves.toBeUndefined();
	});

	it("fails when a documented template is called with an undeclared method", async () => {
		await expect(
			assertOpenApiResponse(
				"PATCH",
				"/v1/billing-accounts/user_1/entitlements",
				new Response("nope", { status: 200 }),
			),
		).rejects.toThrow("undocumented method (200)");
	});

	it("validates an error response against the shared error envelope", async () => {
		const json = { "content-type": "application/json" };
		const envelope = { success: false, error: { code: "INVALID_REQUEST", message: "Bad input." } };
		const path = "/v1/billing-accounts/user_1/entitlements";
		await expect(
			assertOpenApiResponse(
				"GET",
				path,
				new Response(JSON.stringify(envelope), { status: 400, headers: json }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertOpenApiResponse(
				"GET",
				path,
				new Response(JSON.stringify({ message: "not an envelope" }), {
					status: 400,
					headers: json,
				}),
			),
		).rejects.toThrow("400");
	});

	it("validates a request body that operations share through components", async () => {
		await expect(
			assertOpenApiResponse(
				"POST",
				"/v1/admin/catalog/publish",
				new Response(JSON.stringify({ success: true, data: {} }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				{ requestBody: "not an object" },
			),
		).rejects.toThrow("POST /v1/admin/catalog/publish request body");
	});

	it("validates 2xx mutation request bodies", async () => {
		const app = withOpenApiAssertions({
			handle: async () =>
				new Response(
					JSON.stringify({
						success: true,
						data: { status: "ignored", eventType: "x", entitlements: null },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		});
		await expect(
			testRequest(app, "/v1/projects/acme/webhooks/stripe", {
				method: "POST",
				headers: { "content-type": "application/json", "stripe-signature": "sig" },
				body: JSON.stringify({ id: "evt" }),
			}),
		).rejects.toThrow("data must have required property 'type'");
		const valid = await testRequest(app, "/v1/projects/acme/webhooks/stripe", {
			method: "POST",
			headers: { "content-type": "application/json", "stripe-signature": "sig" },
			body: JSON.stringify({
				id: "evt",
				type: "checkout.session.completed",
				data: { object: {} },
			}),
		});
		expect(valid.status).toBe(200);
	});

	it("fails a 2xx response served with an undocumented media type", async () => {
		const app = withOpenApiAssertions({
			handle: async () => new Response("ignored", { headers: { "content-type": "text/plain" } }),
		});
		await expect(
			testRequest(app, "/v1/projects/acme/webhooks/stripe", {
				method: "POST",
				headers: { "content-type": "application/json", "stripe-signature": "sig" },
				body: JSON.stringify({
					id: "evt",
					type: "checkout.session.completed",
					data: { object: {} },
				}),
			}),
		).rejects.toThrow(/undocumented media text\/plain/);
	});
});
