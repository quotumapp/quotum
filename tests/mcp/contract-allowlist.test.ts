import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { allowedRequests } from "../../src/mcp/guarded-fetch";

interface Operation {
	"x-quotum-credential-access"?: string;
}

const document = JSON.parse(
	readFileSync(new URL("../../contracts/v1/openapi.json", import.meta.url), "utf8"),
) as { paths: Record<string, Record<string, Operation>> };

describe("MCP allowlist against the contract", () => {
	it("allows only operations a read-only credential may call", () => {
		const notReadOnly: string[] = [];
		for (const [method, pattern] of allowedRequests) {
			const matches = Object.entries(document.paths).filter(([path, item]) => {
				const sample = path.replace(/\{[^}]+\}/gu, "x");
				return pattern.test(sample) && item[method.toLowerCase()] !== undefined;
			});
			expect(matches.length, `${method} ${pattern}`).toBeGreaterThan(0);
			for (const [path, item] of matches) {
				if (item[method.toLowerCase()]?.["x-quotum-credential-access"] !== "read_only") {
					notReadOnly.push(`${method} ${path}`);
				}
			}
		}
		// Otherwise a tool would work with a sandbox full key and fail with a production read-only one.
		expect(notReadOnly).toEqual([]);
	});
});
