import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { assertOpenApiResponse, withOpenApiAssertions } from "./openapi";

describe("OpenAPI assertions", () => {
	it("allows unknown templates and 404/405 for undeclared methods", async () => {
		await assertOpenApiResponse(
			"GET",
			"/not-a-documented-route",
			new Response("missing", { status: 404 }),
		);
		await assertOpenApiResponse(
			"PATCH",
			"/v1/billing-accounts/user_1/entitlements",
			new Response("nope", { status: 405 }),
		);
		await assertOpenApiResponse(
			"PATCH",
			"/v1/billing-accounts/user_1/entitlements",
			new Response("nope", { status: 200 }),
			{ allowUndocumented: true },
		);
	});

	it("fails when a documented template is called with an undeclared method", async () => {
		await expect(
			assertOpenApiResponse(
				"PATCH",
				"/v1/billing-accounts/user_1/entitlements",
				new Response("nope", { status: 200 }),
			),
		).rejects.toThrow();
	});

	it("validates 2xx mutation request bodies", async () => {
		const app = withOpenApiAssertions(new Hono());
		app.post("/v1/projects/voysee/webhooks/stripe", (c) =>
			c.json({
				success: true,
				data: { status: "ignored", eventType: "x", entitlements: null },
			}),
		);
		await expect(
			app.request("/v1/projects/voysee/webhooks/stripe", {
				method: "POST",
				headers: { "content-type": "application/json", "stripe-signature": "sig" },
				body: JSON.stringify({ id: "evt" }),
			}),
		).rejects.toThrow();
		const valid = await app.request("/v1/projects/voysee/webhooks/stripe", {
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
});
