import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createContractStore } from "../../src/mcp/contracts";
import { createGuardedFetch } from "../../src/mcp/guarded-fetch";
import { createQuotumMcpServer } from "../../src/mcp/server";
import { BillingClient } from "../../src/sdk";

export const mcpTestBaseUrl = "https://billing.example.com";
export const mcpTestApiKey = `sqpk_${"a".repeat(43)}`;

const contracts = createContractStore(resolve(import.meta.dir, "../../contracts/v1"));

export type McpTestResponder = (request: Request) => Response | Promise<Response>;

export interface McpTestConnection {
	client: Client;
	calls: Request[];
	logs: string[];
	close(): Promise<void>;
}

/** A real MCP client and server linked in memory, over the guarded fetch and a stub billing API. */
export async function connectMcp(respond: McpTestResponder): Promise<McpTestConnection> {
	const calls: Request[] = [];
	const logs: string[] = [];
	const billing = new BillingClient({
		baseUrl: mcpTestBaseUrl,
		apiKey: mcpTestApiKey,
		fetch: createGuardedFetch({
			baseUrl: mcpTestBaseUrl,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				calls.push(request.clone());
				return respond(request);
			},
		}),
	});
	const server = createQuotumMcpServer({
		client: billing,
		version: "0.0.0-test",
		log: (line) => logs.push(line),
		contracts,
	});
	const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "quotum-mcp-test", version: "0.0.0" });
	await client.connect(clientTransport);
	return {
		client,
		calls,
		logs,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

export function toolText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content.map((item) => item.text ?? "").join("");
}

export function toolJson(result: unknown): unknown {
	return JSON.parse(toolText(result));
}
