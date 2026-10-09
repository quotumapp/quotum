import { afterEach, describe, expect, it } from "bun:test";
import Ajv from "ajv/dist/2020";
import { z } from "zod";
import { prepareBillingChangeSchema } from "../../src/composition/billing-change-actions";
import type { McpChangeTools } from "../../src/mcp/change-tools";
import { connectMcp, type McpTestConnection } from "../helpers/mcp";

let connection: McpTestConnection | undefined;

afterEach(async () => {
	await connection?.close();
	connection = undefined;
});

// Clients check every tool schema against the JSON Schema 2020-12 meta-schema before they list the
// tool, and drop the ones that fail, so one invalid shape hides a tool without any server error.
const ajv = new Ajv({ strict: false, allErrors: true });
function metaSchemaErrors(schema: unknown): string[] {
	return ajv.validateSchema(schema as object)
		? []
		: (ajv.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

const changes: McpChangeTools = {
	schema: prepareBillingChangeSchema,
	capabilities: async () => ({}),
	inspect: async () => ({}),
	prepare: async () => ({}),
	get: async () => ({}),
	list: async () => ({}),
	cancel: async () => ({}),
};

describe("MCP tool schemas", () => {
	it("are valid JSON Schema 2020-12 for every tool, including the write tools", async () => {
		connection = await connectMcp(() => Response.json({ success: true, data: {} }), { changes });
		const { tools } = await connection.client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("prepare_billing_change");
		for (const tool of tools) {
			expect([tool.name, "input", metaSchemaErrors(tool.inputSchema)]).toEqual([
				tool.name,
				"input",
				[],
			]);
			if (tool.outputSchema !== undefined)
				expect([tool.name, "output", metaSchemaErrors(tool.outputSchema)]).toEqual([
					tool.name,
					"output",
					[],
				]);
		}
	});

	it("catches an empty tuple, which Zod emits as an empty prefixItems", () => {
		expect(metaSchemaErrors(z.toJSONSchema(z.tuple([]))).join("\n")).toContain("prefixItems");
	});
});
