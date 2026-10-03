import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type DiagnosticLog, runTool } from "./results";

/** Injected by the remote composition; stdio never receives mutation authority. */
export interface McpChangeTools {
	schema: z.ZodObject;
	capabilities(): Promise<unknown>;
	inspect(input: {
		resource: string;
		parameters: string[];
		query: Record<string, string>;
	}): Promise<unknown>;
	prepare(input: unknown): Promise<unknown>;
	get(id: string): Promise<unknown>;
	list(): Promise<unknown>;
	cancel(id: string): Promise<unknown>;
}
export function registerChangeTools(server: McpServer, port: McpChangeTools, log: DiagnosticLog) {
	server.registerTool(
		"get_billing_configuration",
		{
			description:
				"Inspect entities, shared/entity grants, debits, trials, controls, alerts, top-up policies, license pools, enterprise contracts, or promotions before proposing a change. The first parameter is the billing account ID, or promotion ID for promotion detail/code/redemption reads. topups requires featureKey in query. List reads accept cursor and limit where supported.",
			inputSchema: z
				.object({
					resource: z.enum([
						"entities",
						"grants",
						"debits",
						"trials",
						"alerts",
						"topups",
						"licenses",
						"contracts",
						"controls",
						"promotions",
						"promotions.detail",
						"promotions.codes",
						"promotions.redemptions",
						"account.promotion-redemptions",
					]),
					parameters: z.array(z.string().min(1).max(200)).max(1),
					query: z.record(z.string().max(100), z.string().max(500)).default({}),
				})
				.strict(),
			annotations: { readOnlyHint: true },
		},
		(input) => runTool(() => port.inspect(input), log),
	);
	server.registerTool(
		"get_mcp_capabilities",
		{
			description:
				"Billing operations available to this connection and their approval requirements.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		() => runTool(() => port.capabilities(), log),
	);
	server.registerTool(
		"prepare_billing_change",
		{
			description:
				"Prepare one immutable billing proposal. Return its approval URL to the user. Only the connected user can approve and apply it in Quotum. Never claim it was applied until its status confirms completion.",
			inputSchema: port.schema,
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		(input) => runTool(() => port.prepare(input), log),
	);
	server.registerTool(
		"get_billing_change",
		{
			description: "Read a proposal or its execution result. This never applies a proposal.",
			inputSchema: z.object({ id: z.uuid() }),
			annotations: { readOnlyHint: true },
		},
		({ id }) => runTool(() => port.get(id), log),
	);
	server.registerTool(
		"list_billing_changes",
		{
			description: "Read the latest 25 changes proposed by this connection.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		() => runTool(() => port.list(), log),
	);
	server.registerTool(
		"cancel_billing_change",
		{
			description: "Withdraw a pending proposal. Already applied changes cannot be undone here.",
			inputSchema: z.object({ id: z.uuid() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		({ id }) => runTool(() => port.cancel(id), log),
	);
}
