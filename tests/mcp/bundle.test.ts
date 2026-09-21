import { describe, expect, it } from "bun:test";
import { join } from "node:path";

describe("MCP server bundle", () => {
	it("pulls in the SDK as an HTTP client only, never the service runtime", async () => {
		const build = await Bun.build({
			entrypoints: [join(process.cwd(), "src/mcp/index.ts")],
			target: "bun",
			metafile: true,
		});
		expect(build.success).toBe(true);
		const inputs = Object.keys(build.metafile?.inputs ?? {});
		expect(inputs.some((path) => path.includes("src/mcp/index.ts"))).toBe(true);
		const forbidden = inputs.filter(
			(path) =>
				/node_modules\/(drizzle-orm|pino|elysia|stripe|better-auth|@sentry)\//u.test(path) ||
				/(^|\/)src\/(db|app|billing|platform|workers|providers|composition|observability)\//u.test(
					path,
				) ||
				path.endsWith("src/env.ts"),
		);
		expect(forbidden).toEqual([]);
	});
});
