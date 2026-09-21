import { describe, expect, it } from "bun:test";
import { McpConfigError, readMcpConfig } from "../../src/mcp/config";
import { generateProjectApiCredential } from "../../src/platform/credentials/project-api-token";

const sandboxKey = generateProjectApiCredential("sandbox").token;
const productionKey = generateProjectApiCredential("production").token;

function failure(env: Record<string, string | undefined>): string {
	try {
		readMcpConfig(env);
	} catch (error) {
		expect(error).toBeInstanceOf(McpConfigError);
		return (error as Error).message;
	}
	throw new Error("expected the configuration to be rejected");
}

describe("MCP configuration", () => {
	it("accepts an issued sandbox key and normalizes the base URL", () => {
		expect(
			readMcpConfig({
				QUOTUM_MCP_BASE_URL: " https://billing.example.com/quotum// ",
				QUOTUM_MCP_API_KEY: ` ${sandboxKey} `,
			}),
		).toEqual({
			baseUrl: "https://billing.example.com/quotum",
			apiKey: sandboxKey,
			insecureHttp: false,
		});
	});

	it("refuses issued production keys and anything that is not a sandbox key", () => {
		const base = { QUOTUM_MCP_BASE_URL: "https://billing.example.com" };
		const production = failure({ ...base, QUOTUM_MCP_API_KEY: productionKey });
		expect(production).toContain("production key");
		expect(production).not.toContain(productionKey);

		for (const key of ["", "qpk_v1_legacy", `${sandboxKey}x`, sandboxKey.slice(0, -1)]) {
			const message = failure({ ...base, QUOTUM_MCP_API_KEY: key });
			if (key !== "") expect(message).not.toContain(key);
		}
	});

	it("ignores the variable names a product backend or the catalog CLI uses", () => {
		expect(
			failure({
				BILLING_BASE_URL: "https://billing.example.com",
				BILLING_PROJECT_API_KEY: sandboxKey,
				BILLING_OPERATOR_API_KEY: "operator-secret-value",
			}),
		).toBe("QUOTUM_MCP_BASE_URL is required");
	});

	it("requires https off loopback unless plain http is explicitly allowed", () => {
		const key = { QUOTUM_MCP_API_KEY: sandboxKey };
		for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
			expect(readMcpConfig({ ...key, QUOTUM_MCP_BASE_URL: url }).baseUrl).toBe(url);
		}
		expect(failure({ ...key, QUOTUM_MCP_BASE_URL: "http://billing.internal:3000" })).toContain(
			"QUOTUM_MCP_ALLOW_INSECURE_HTTP",
		);
		expect(
			readMcpConfig({
				...key,
				QUOTUM_MCP_BASE_URL: "http://host.docker.internal:3000",
				QUOTUM_MCP_ALLOW_INSECURE_HTTP: "true",
			}),
		).toMatchObject({ baseUrl: "http://host.docker.internal:3000", insecureHttp: true });
	});

	it("rejects base URLs that carry credentials, a query, a fragment or another scheme", () => {
		const key = { QUOTUM_MCP_API_KEY: sandboxKey };
		for (const url of [
			"https://user:pass@billing.example.com",
			"https://billing.example.com?projectId=1",
			"https://billing.example.com#x",
			"ftp://billing.example.com",
			"not a url",
		]) {
			failure({ ...key, QUOTUM_MCP_BASE_URL: url });
		}
	});
});
