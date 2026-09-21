import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createContractStore } from "../../src/mcp/contracts";
import { createQuotumMcpServer } from "../../src/mcp/server";
import { BillingClient } from "../../src/sdk/index";
import { connectMcp, type McpTestConnection, toolJson } from "../helpers/mcp";

let connection: McpTestConnection | undefined;

afterEach(async () => {
	await connection?.close();
	connection = undefined;
});

const unreachable = () => {
	throw new Error("contract tools must not call the billing API");
};

describe("MCP contract tools", () => {
	it("finds trusted-backend operations and never the merchant surface", async () => {
		connection = await connectMcp(unreachable);
		const found = toolJson(
			await connection.client.callTool({
				name: "find_api_operations",
				arguments: { query: "usage/check" },
			}),
		);
		expect(found).toEqual({
			operations: [
				{
					operationId: "postV1BillingAccountsByBillingAccountIdUsageCheck",
					method: "POST",
					path: "/v1/billing-accounts/{billingAccountId}/usage/check",
					tags: ["metering"],
				},
			],
			total: 1,
		});

		const everything = toolJson(
			await connection.client.callTool({ name: "find_api_operations", arguments: { limit: 100 } }),
		) as { operations: Array<{ path: string }>; total: number };
		expect(everything.total).toBeGreaterThan(50);
		expect(everything.operations.every((operation) => operation.path.startsWith("/v1/"))).toBe(
			true,
		);
		expect(connection.calls).toEqual([]);
	});

	it("returns one operation with every schema it references", async () => {
		connection = await connectMcp(unreachable);
		const detail = toolJson(
			await connection.client.callTool({
				name: "get_api_operation",
				arguments: { operationId: "postV1BillingAccountsByBillingAccountIdUsageCheck" },
			}),
		) as { operation: unknown; components: Record<string, unknown> };
		const references = [...JSON.stringify(detail).matchAll(/"\$ref":"(#\/[^"]+)"/gu)].map(
			(match) => match[1] as string,
		);
		expect(references.length).toBeGreaterThan(0);
		for (const reference of references) expect(detail.components).toHaveProperty([reference]);

		const unknown = await connection.client.callTool({
			name: "get_api_operation",
			arguments: { operationId: "deleteEverything" },
		});
		expect(toolJson(unknown)).toMatchObject({ found: false });
	});

	it("serves the error inventory and the capability table as resources, not the 1.8 MB contract", async () => {
		connection = await connectMcp(unreachable);
		const { resources } = await connection.client.listResources();
		expect(resources.map((resource) => resource.uri).sort()).toEqual([
			"quotum://contracts/v1/errors.json",
			"quotum://contracts/v1/provider-capabilities.json",
		]);
		const read = await connection.client.readResource({
			uri: "quotum://contracts/v1/errors.json",
		});
		const text = (read.contents[0] as { text: string }).text;
		expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, codes: expect.any(Array) });
	});

	it("omits the contract tools when the contract is not shipped, and hides a missing file's path", async () => {
		const server = createQuotumMcpServer({
			client: new BillingClient({ baseUrl: "https://billing.example.com", fetch: unreachable }),
			log: () => {},
			version: "0.0.0-test",
		});
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "quotum-mcp-test", version: "0.0.0" });
		await client.connect(clientTransport);
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).not.toContain("find_api_operations");
		expect(names).toContain("check_usage");
		await client.close();
		await server.close();

		const logs: string[] = [];
		const missing = createQuotumMcpServer({
			client: new BillingClient({ baseUrl: "https://billing.example.com", fetch: unreachable }),
			log: (line) => logs.push(line),
			version: "0.0.0-test",
			contracts: createContractStore("/nonexistent/secret-directory"),
		});
		const [missingServer, missingClient] = InMemoryTransport.createLinkedPair();
		await missing.connect(missingServer);
		const reader = new Client({ name: "quotum-mcp-test", version: "0.0.0" });
		await reader.connect(missingClient);
		const error = await reader
			.readResource({ uri: "quotum://contracts/v1/errors.json" })
			.catch((caught: unknown) => caught);
		expect(String((error as Error).message)).not.toContain("secret-directory");
		const tool = await reader.callTool({ name: "find_api_operations", arguments: {} });
		expect(tool.isError).toBe(true);
		expect(JSON.stringify(tool)).toContain("CONTRACT_UNAVAILABLE");
		expect(JSON.stringify(tool)).not.toContain("secret-directory");
		expect(logs.join("\n")).toContain("secret-directory");
		await reader.close();
		await missing.close();
	});
});
