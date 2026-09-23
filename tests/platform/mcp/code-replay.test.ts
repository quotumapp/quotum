import { describe, expect, it } from "bun:test";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware, dispatchAuthEndpoint } from "better-auth/api";
import { containMcpCodeReplay } from "../../../src/platform/mcp/code-replay";

describe("MCP authorization code replay containment", () => {
	it("keeps the consumption wrapper request local and forwards other verification values", async () => {
		let revocations = 0;
		const consumed: string[] = [];
		const options: BetterAuthOptions = {
			baseURL: "https://merchant.example.test",
			secret: "synthetic-code-test-secret-at-least-32-characters",
			logger: { disabled: true },
			hooks: {
				before: createAuthMiddleware(async (ctx) => {
					if (ctx.body?.bind)
						containMcpCodeReplay(ctx, "selected-code", async () => {
							revocations += 1;
						});
				}),
			},
		};
		const context = await betterAuth(options).$context;
		const verification = {
			id: "verification-id",
			identifier: "live-code",
			value: "value",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const adapter = {
			...context.internalAdapter,
			async consumeVerificationValue(identifier: string) {
				consumed.push(identifier);
				return identifier === "live-code" ? verification : null;
			},
		};
		context.internalAdapter = adapter;
		const endpoint = createAuthEndpoint("/test-code", { method: "POST" }, async (ctx) => {
			const value = await ctx.context.internalAdapter.consumeVerificationValue(ctx.body.code);
			return { value };
		});
		const run = (code: string, bind = true) =>
			dispatchAuthEndpoint(endpoint, { context, body: { code, bind }, asResponse: true });
		const missing = (await run("selected-code")) as Response;
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({
			error: "invalid_grant",
			error_description: "Reconnect Quotum to authorize access.",
		});
		expect(revocations).toBe(1);
		expect(context.internalAdapter).toBe(adapter);
		for (const [code, bind] of [
			["selected-code", false],
			["unrelated-code", true],
			["live-code", true],
		] as const) {
			const response = (await run(code, bind)) as Response;
			expect(response.status).toBe(200);
			const result = await response.json();
			expect(result.value?.id ?? null).toBe(code === "live-code" ? verification.id : null);
		}
		expect(revocations).toBe(1);
		expect(consumed).toEqual(["selected-code", "selected-code", "unrelated-code", "live-code"]);
	});
});
