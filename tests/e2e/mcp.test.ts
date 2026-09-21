import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import {
	type BillingDatabaseConnection,
	createBillingDatabaseConnection,
} from "../../src/db/client";
import { BillingRepository } from "../../src/db/repository";
import {
	resetAndSeedIntegrationData,
	seedIntegrationProjectsAndCatalog,
} from "../integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../integration/helpers/metering-catalog";
import { integrationProjectContext } from "../integration/helpers/platform-fixture";
import { e2eApiKey, e2eSandboxApiKey, e2eServiceEnv } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { type BillingServiceProcess, startBillingService } from "./helpers/service-process";

const e2eDescribe = describeE2e(describe, describe.skip);
const repositoryRoot = resolve(import.meta.dir, "../..");
let connection: BillingDatabaseConnection;
let service: BillingServiceProcess | null = null;
let client: Client | null = null;

/** Only what a host would pass: the runner's env also holds the operator key and production keys. */
function mcpEnv(baseUrl: string, apiKey: string): Record<string, string> {
	return {
		...(createSanitizedProcessEnv() as Record<string, string>),
		QUOTUM_MCP_BASE_URL: baseUrl,
		QUOTUM_MCP_API_KEY: apiKey,
	};
}

function toolJson(result: unknown): unknown {
	const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
	return JSON.parse(content.map((item) => item.text ?? "").join(""));
}

e2eDescribe("E2E MCP server", () => {
	beforeEach(async () => {
		const postgresUri = process.env.POSTGRES_URI ?? "";
		if (!postgresUri) throw new Error("POSTGRES_URI is required");
		connection = createBillingDatabaseConnection({ postgresUri });
		await resetAndSeedIntegrationData(connection.sql);
		// The shared fixtures seed production instances only; the MCP server accepts sandbox keys.
		await seedIntegrationProjectsAndCatalog(connection.sql, [
			{
				projectInstanceKey: "voysee-sandbox",
				name: "Voysee Sandbox",
				projectionUrl: "https://voysee-sandbox.projection.integration.test",
				projectionSecret: "voysee-sandbox-projection-secret",
			},
		]);
		const repository = new BillingRepository(connection.db as never);
		const sandbox = integrationProjectContext("voysee-sandbox");
		await publishAiCreditsCatalog(repository, sandbox);
		await repository.grantAllocation(sandbox, {
			billingAccountId: "mcp-account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "e2e-mcp",
		});
		service = await startBillingService(e2eServiceEnv({ postgresUri }));
	});
	afterEach(async () => {
		await client?.close();
		client = null;
		await service?.stop();
		service = null;
		await connection?.sql.close();
	});

	it("explains a denial and finds the customer through the real API with a sandbox key", async () => {
		if (service === null) throw new Error("Service not started");
		expect(e2eSandboxApiKey.startsWith("sqpk_")).toBe(true);
		client = new Client({ name: "quotum-e2e", version: "0.0.0" });
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: ["--no-env-file", "src/mcp/index.ts"],
				cwd: repositoryRoot,
				env: mcpEnv(service.baseUrl, e2eSandboxApiKey),
				stderr: "pipe",
			}),
		);

		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("check_usage");

		const allowed = await client.callTool({
			name: "check_usage",
			arguments: { billingAccountId: "mcp-account", featureKey: "ai_credits", quantity: "10" },
		});
		expect(toolJson(allowed)).toMatchObject({ allowed: true });
		const denied = await client.callTool({
			name: "check_usage",
			arguments: { billingAccountId: "mcp-account", featureKey: "ai_credits", quantity: "11" },
		});
		expect(denied.isError).toBeUndefined();
		expect(toolJson(denied)).toMatchObject({ allowed: false, reason: expect.any(String) });

		const balance = await client.callTool({
			name: "get_balance",
			arguments: { billingAccountId: "mcp-account", featureKey: "ai_credits" },
		});
		expect(toolJson(balance)).toMatchObject({ granted: "10", consumed: "0", available: "10" });

		const found = await client.callTool({
			name: "find_customer",
			arguments: { query: "mcp-acc" },
		});
		expect(toolJson(found)).toMatchObject({
			data: [{ matchType: "billing_account_id", matchedValue: "mcp-account" }],
		});

		const overview = await client.callTool({
			name: "get_customer_overview",
			arguments: { billingAccountId: "mcp-account" },
		});
		expect(toolJson(overview)).toMatchObject({
			customer: { customer: { billingAccountId: "mcp-account" } },
			controls: expect.any(Array),
		});

		for (const name of ["get_project_stats", "list_projection_jobs", "list_store_events"]) {
			const result = await client.callTool({ name, arguments: {} });
			expect([name, result.isError]).toEqual([name, undefined]);
		}

		const missing = await client.callTool({
			name: "get_usage_operation",
			arguments: { billingAccountId: "mcp-account", operationId: "never-sent" },
		});
		expect(toolJson(missing)).toMatchObject({ operations: [] });
	}, 60_000);

	it("refuses the production key of the same project", async () => {
		if (service === null) throw new Error("Service not started");
		expect(e2eApiKey.startsWith("pqpk_")).toBe(true);
		const child = Bun.spawn([process.execPath, "--no-env-file", "src/mcp/index.ts"], {
			cwd: repositoryRoot,
			env: mcpEnv(service.baseUrl, e2eApiKey),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.end();
		expect(await child.exited).toBe(1);
		expect(await new Response(child.stderr).text()).toContain("production key");
	}, 60_000);
});
