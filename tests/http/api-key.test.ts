import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { constantTimeEquals, requireApiKey } from "../../src/http/api-key";
import { createProjectApiKeyResolver } from "../../src/projects/config";
import type { ProjectContext } from "../../src/projects/context";

describe("requireApiKey", () => {
	it("compares bearer tokens exactly without throwing on length mismatches", () => {
		expect(constantTimeEquals("Bearer secret", "Bearer secret")).toBe(true);
		expect(constantTimeEquals("Bearer secret", "Bearer wrong")).toBe(false);
		expect(constantTimeEquals("Bearer secret", "Bearer much-longer-wrong-token")).toBe(false);
	});

	it("allows requests with the configured bearer token", async () => {
		const app = new Hono();
		app.use("*", requireApiKey("secret"));
		app.get("/", (c) => c.json({ ok: true }));

		const response = await app.request("/", {
			headers: { authorization: "Bearer secret" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("rejects missing or wrong bearer tokens", async () => {
		const app = new Hono();
		app.use("*", requireApiKey("secret"));
		app.get("/", (c) => c.json({ ok: true }));

		expect((await app.request("/")).status).toBe(401);
		expect(
			(
				await app.request("/", {
					headers: { authorization: "Bearer wrong" },
				})
			).status,
		).toBe(401);
	});

	it("resolves project-scoped bearer tokens onto request context", async () => {
		const app = new Hono<{ Variables: { project: ProjectContext } }>();
		app.use(
			"*",
			requireApiKey(
				createProjectApiKeyResolver([
					{
						key: "voysee",
						apiKey: "voysee-service-key-123456",
						active: true,
						projectionUrl: "https://voysee.example.com",
						projectionSecret: "voysee-projection-secret",
					},
					{
						key: "wiseley",
						apiKey: "wiseley-service-key-123456",
						active: true,
						projectionUrl: "https://wiseley.example.com",
						projectionSecret: "wiseley-projection-secret",
					},
				]),
			),
		);
		app.get("/", (c) => c.json({ projectKey: c.get("project").projectKey }));

		const voysee = await app.request("/", {
			headers: { authorization: "Bearer voysee-service-key-123456" },
		});
		const wiseley = await app.request("/", {
			headers: { authorization: "Bearer wiseley-service-key-123456" },
		});

		expect(voysee.status).toBe(200);
		expect(await voysee.json()).toEqual({ projectKey: "voysee" });
		expect(wiseley.status).toBe(200);
		expect(await wiseley.json()).toEqual({ projectKey: "wiseley" });
	});
});
