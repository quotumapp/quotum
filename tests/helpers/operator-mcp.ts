import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
	createOperatorMcpServer,
	type OperatorMcpOptions,
} from "../../src/composition/operator-mcp/server";

export const operatorTestCatalog = {
	features: [
		{
			key: "credits",
			name: "Credits",
			kind: "metered",
			meterKind: "consumable",
			unit: "credit",
			creditScale: 0,
			filterDimensions: [],
		},
	],
	plans: [],
	topups: [],
	rateCards: [],
};

export const operatorTestManifest = {
	version: 1,
	organizations: [
		{
			slug: "mcp-setup",
			name: "MCP setup",
			projects: [
				{
					key: "app",
					name: "App",
					instances: [
						{
							key: "mcp-sandbox",
							environment: "sandbox",
							lifecycleStatus: "active",
							issueCredential: true,
						},
						{
							key: "mcp-production",
							environment: "production",
							lifecycleStatus: "active",
							issueCredential: false,
						},
					],
				},
			],
		},
	],
};

export async function connectOperatorMcp(options: OperatorMcpOptions) {
	const server = createOperatorMcpServer(options);
	const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "operator-test", version: "0.0.0" });
	await client.connect(clientTransport);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}
