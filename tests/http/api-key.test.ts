import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { constantTimeEquals, requireApiKey } from "../../src/http/api-key";
import type { ProjectInstanceContext } from "../../src/projects/context";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

describe("requireApiKey", () => {
	it("compares bearer tokens exactly without throwing on length mismatches", () => {
		expect(constantTimeEquals("Bearer secret", "Bearer secret")).toBe(true);
		expect(constantTimeEquals("Bearer secret", "Bearer wrong")).toBe(false);
		expect(constantTimeEquals("Bearer secret", "Bearer much-longer-wrong-token")).toBe(false);
	});

	it("allows requests with the configured bearer token", async () => {
		const app = new Hono();
		app.use("*", requireApiKey(projectContextResolver({ credentials: { secret: "voysee" } })));
		app.get("/", (c) => c.json({ ok: true }));

		const response = await app.request("/", {
			headers: { authorization: "Bearer secret" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("rejects missing or wrong bearer tokens", async () => {
		const app = new Hono();
		app.use("*", requireApiKey(projectContextResolver({ credentials: { secret: "voysee" } })));
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
		const app = new Hono<{ Variables: { project: ProjectInstanceContext } }>();
		const contexts = [projectInstanceContext(), projectInstanceContext("wiseley")];
		app.use(
			"*",
			requireApiKey(
				projectContextResolver({
					contexts,
					credentials: {
						"voysee-service-key-123456": "voysee",
						"wiseley-service-key-123456": "wiseley",
					},
				}),
			),
		);
		app.get("/", (c) =>
			c.json({
				projectInstanceId: c.get("project").projectInstanceId,
				projectInstanceKey: c.get("project").projectInstanceKey,
			}),
		);

		const voysee = await app.request("/", {
			headers: { authorization: "Bearer voysee-service-key-123456" },
		});
		const wiseley = await app.request("/", {
			headers: { authorization: "Bearer wiseley-service-key-123456" },
		});

		expect(voysee.status).toBe(200);
		expect(await voysee.json()).toEqual({
			projectInstanceId: contexts[0]?.projectInstanceId,
			projectInstanceKey: "voysee",
		});
		expect(wiseley.status).toBe(200);
		expect(await wiseley.json()).toEqual({
			projectInstanceId: contexts[1]?.projectInstanceId,
			projectInstanceKey: "wiseley",
		});
	});

	it("fails closed when project persistence is unavailable", async () => {
		const app = new Hono();
		app.use("*", requireApiKey(projectContextResolver({ unavailable: true })));
		app.get("/", (c) => c.json({ ok: true }));

		const response = await app.request("/", {
			headers: { authorization: "Bearer test-api-key" },
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "BILLING_PROJECT_CONTEXT_UNAVAILABLE" },
		});
	});

	it("rejects suspended and internal project instances", async () => {
		for (const context of [
			projectInstanceContext("voysee", { lifecycleStatus: "suspended" }),
			projectInstanceContext("voysee", { environment: "internal", internalProject: true }),
		]) {
			const app = new Hono();
			app.use("*", requireApiKey(projectContextResolver({ contexts: [context] })));
			app.get("/", (c) => c.json({ ok: true }));

			expect(
				(await app.request("/", { headers: { authorization: "Bearer test-api-key" } })).status,
			).toBe(401);
		}
	});
});
