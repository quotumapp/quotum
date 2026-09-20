import { type McpServer, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ContractStore, contractDocuments } from "./contracts";
import { type DiagnosticLog, runTool } from "./results";

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

const documentDescriptions = {
	"errors.json":
		"Every literal error code the API can return, with the source files that raise it.",
	"provider-capabilities.json":
		"Which operations Apple, Google and Stripe support, with support levels and reasons.",
} as const;

/** Lookups over the generated contract shipped next to the server; they never call the API. */
export function registerContractTools(
	server: McpServer,
	{ contracts, log }: { contracts: ContractStore; log: DiagnosticLog },
): void {
	server.registerTool(
		"find_api_operations",
		{
			title: "Find /v1 API operations",
			description:
				"Searches the generated OpenAPI contract for trusted-backend (/v1) operations by path or operationId substring, optionally by tag. Returns operationId, method, path and tags; pass an operationId to get_api_operation for the schemas.",
			inputSchema: z.object({
				query: z.string().max(200).optional(),
				tag: z.string().min(1).max(64).optional(),
				limit: z.number().int().min(1).max(100).default(25),
			}),
			annotations: readOnly,
		},
		(filter) => runTool(() => contracts.findOperations(filter), log),
	);

	server.registerTool(
		"get_api_operation",
		{
			title: "One /v1 API operation",
			description:
				"The full OpenAPI operation for an operationId: parameters, required headers, request body and every response, plus each referenced component schema. Use this instead of reading the whole contract.",
			inputSchema: z.object({ operationId: z.string().min(1).max(200) }),
			annotations: readOnly,
		},
		({ operationId }) =>
			runTool(
				async () =>
					(await contracts.getOperation(operationId)) ?? {
						found: false,
						hint: "Unknown operationId. Use find_api_operations to list the available ones.",
					},
				log,
			),
	);

	for (const name of contractDocuments) {
		const uri = `quotum://contracts/v1/${name}`;
		server.registerResource(
			name,
			uri,
			{ title: name, description: documentDescriptions[name], mimeType: "application/json" },
			async (requested) => {
				try {
					return {
						contents: [
							{
								uri: requested.href,
								mimeType: "application/json",
								text: await contracts.readDocument(name),
							},
						],
					};
				} catch (error) {
					log(`contract read failed: ${error instanceof Error ? error.message : "unknown"}`);
					throw new ResourceNotFoundError(requested.href, "The contract document is unavailable");
				}
			},
		);
	}
}
