import { describe, expect, it } from "bun:test";
import { type BetterAuthOptions, betterAuth, type GenericEndpointContext } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware, dispatchAuthEndpoint } from "better-auth/api";
import { containMcpRefreshInvalidation } from "../../../src/platform/mcp/refresh-invalidation";

type Adapter = GenericEndpointContext["context"]["adapter"];
const clientId = "quotum-claude-code";
const userId = "same-user";
const family = {
	model: "oauthRefreshToken",
	where: [
		{ field: "clientId", value: clientId },
		{ field: "userId", value: userId },
	],
};

async function fixture() {
	const revoked: string[] = [];
	const tokens = [
		{ grant: "selected", revoked: false },
		{ grant: "sibling", revoked: false },
	];
	const options: BetterAuthOptions = {
		baseURL: "https://merchant.example.test",
		secret: "synthetic-refresh-test-secret-at-least-32-characters",
		logger: { disabled: true },
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.body?.bind !== true) return;
				containMcpRefreshInvalidation(ctx, { client_id: clientId, userId }, async () => {
					revoked.push("selected");
					for (const token of tokens) if (token.grant === "selected") token.revoked = true;
				});
			}),
		},
	};
	const auth = betterAuth(options);
	const context = await auth.$context;
	const reads: Parameters<Adapter["findMany"]>[0][] = [];
	const deletes: Parameters<Adapter["deleteMany"]>[0][] = [];
	const adapter: Adapter = {
		...context.adapter,
		async findMany<T>(query: Parameters<Adapter["findMany"]>[0]): Promise<T[]> {
			reads.push(query);
			return [];
		},
		async deleteMany(query) {
			deletes.push(query);
			return 0;
		},
	};
	context.adapter = adapter;
	return { context, adapter, revoked, tokens, reads, deletes };
}

describe("MCP refresh invalidation containment", () => {
	it("contains the provider's family invalidation when grace expires after the precheck", async () => {
		const f = await fixture();
		const endpoint = createAuthEndpoint("/test-refresh", { method: "POST" }, async (ctx) => {
			// Deterministic seam for Better Auth 1.7.5 invalidateRefreshFamily: its first
			// read and final deletion otherwise target every grant for this user/client.
			await ctx.context.adapter.findMany(family);
			await ctx.context.adapter.deleteMany(family);
			return { unexpected: true };
		});
		const result = (await dispatchAuthEndpoint(endpoint, {
			context: f.context,
			body: { bind: true },
			asResponse: true,
		})) as Response;
		expect(result.status).toBe(400);
		expect(await result.json()).toEqual({
			error: "invalid_grant",
			error_description: "Reconnect Quotum to authorize access.",
		});
		expect(f.revoked).toEqual(["selected"]);
		expect(f.tokens).toEqual([
			{ grant: "selected", revoked: true },
			{ grant: "sibling", revoked: false },
		]);
		expect(f.reads).toEqual([]);
		expect(f.deletes).toEqual([]);
		expect(f.context.adapter).toBe(f.adapter);
		// A separate dispatch uses the original adapter, without leaked request binding.
		const other = (await dispatchAuthEndpoint(endpoint, {
			context: f.context,
			body: { bind: false },
			asResponse: true,
		})) as Response;
		expect(other.status).toBe(200);
		expect(f.reads).toEqual([family]);
		expect(f.deletes).toEqual([family]);
		expect(f.revoked).toHaveLength(1);
	});

	it("contains a direct family deletion without passing it to the shared adapter", async () => {
		const f = await fixture();
		const endpoint = createAuthEndpoint("/test-refresh", { method: "POST" }, async (ctx) => {
			await ctx.context.adapter.deleteMany(family);
			return { unexpected: true };
		});
		const result = (await dispatchAuthEndpoint(endpoint, {
			context: f.context,
			body: { bind: true },
			asResponse: true,
		})) as Response;
		expect(result.status).toBe(400);
		expect(f.revoked).toEqual(["selected"]);
		expect(f.deletes).toEqual([]);
	});

	it("passes token-scoped and unrelated adapter operations through unchanged", async () => {
		const f = await fixture();
		const selected = {
			model: "oauthRefreshToken",
			where: [{ field: "authorizationCodeId", value: "selected-code" }],
		};
		const unrelated = { ...family, model: "oauthConsent" };
		const endpoint = createAuthEndpoint("/test-refresh", { method: "POST" }, async (ctx) => {
			expect(ctx.context.adapter).not.toBe(f.adapter);
			expect(ctx.context.adapter.findOne).toBe(f.adapter.findOne);
			await ctx.context.adapter.findMany(selected);
			await ctx.context.adapter.deleteMany(selected);
			await ctx.context.adapter.findMany(unrelated);
			return { ok: true };
		});
		const result = (await dispatchAuthEndpoint(endpoint, {
			context: f.context,
			body: { bind: true },
			asResponse: true,
		})) as Response;
		expect(result.status).toBe(200);
		expect(f.reads).toEqual([selected, unrelated]);
		expect(f.deletes).toEqual([selected]);
		expect(f.revoked).toEqual([]);
	});

	it("refuses a mismatched family without revoking either grant", async () => {
		const f = await fixture();
		const endpoint = createAuthEndpoint("/test-refresh", { method: "POST" }, async (ctx) => {
			await ctx.context.adapter.findMany({
				...family,
				where: [
					{ field: "clientId", value: "another-client" },
					{ field: "userId", value: userId },
				],
			});
			return { unexpected: true };
		});
		const result = (await dispatchAuthEndpoint(endpoint, {
			context: f.context,
			body: { bind: true },
			asResponse: true,
		})) as Response;
		expect(result.status).toBe(400);
		expect(f.reads).toEqual([]);
		expect(f.revoked).toEqual([]);
		expect(f.tokens.every((token) => !token.revoked)).toBe(true);
	});
});
