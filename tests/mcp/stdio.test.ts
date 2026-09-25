import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";

const repositoryRoot = resolve(import.meta.dir, "../..");
const sandboxKey = `sqpk_${"b".repeat(43)}`;
const productionKey = `pqpk_${"b".repeat(43)}`;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function fakeBillingApi(delayMs = 0): { baseUrl: string; calls: string[] } {
	const calls: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			calls.push(`${request.method} ${url.pathname} ${request.headers.get("authorization")}`);
			if (delayMs > 0) await Bun.sleep(delayMs);
			return Response.json({ success: true, data: { storeEvents: { failed: 2 } } });
		},
	});
	servers.push(server);
	return { baseUrl: `http://127.0.0.1:${server.port}`, calls };
}

function spawnServer(env: Record<string, string>) {
	return Bun.spawn([process.execPath, "--no-env-file", "src/mcp/index.ts"], {
		cwd: repositoryRoot,
		env: {
			...createSanitizedProcessEnv(),
			// Names a backend would carry; the server must not read them.
			BILLING_OPERATOR_API_KEY: "operator-secret-value",
			BILLING_PROJECT_API_KEY: productionKey,
			...env,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("MCP stdio server", () => {
	it("speaks only JSON-RPC on stdout and exits when the host closes stdin", async () => {
		const api = fakeBillingApi();
		const child = spawnServer({
			QUOTUM_MCP_BASE_URL: api.baseUrl,
			QUOTUM_MCP_API_KEY: sandboxKey,
		});
		const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "stdio-test", version: "0.0.0" },
			},
		});
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		send({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "get_project_stats", arguments: {} },
		});

		const messages = await readMessages(child.stdout, 3);
		child.stdin.end();
		expect(await child.exited).toBe(0);

		const resultOf = (id: number) => messages.find((message) => message.id === id)?.result;
		expect(resultOf(1)).toMatchObject({ serverInfo: { name: "quotum" } });
		expect((resultOf(2) as { tools?: unknown[] } | undefined)?.tools?.length).toBeGreaterThan(10);
		expect(JSON.stringify(resultOf(3))).toContain("storeEvents");
		expect(api.calls).toEqual([`GET /v1/admin/stats/summary Bearer ${sandboxKey}`]);

		const stderr = await new Response(child.stderr).text();
		expect(stderr).not.toContain(sandboxKey);
		expect(stderr).not.toContain("operator-secret-value");
	}, 20_000);

	it("answers what was already sent when stdin closes straight after the request", async () => {
		const api = fakeBillingApi(200);
		const child = spawnServer({
			QUOTUM_MCP_BASE_URL: api.baseUrl,
			QUOTUM_MCP_API_KEY: sandboxKey,
		});
		for (const message of [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "stdio-test", version: "0.0.0" },
				},
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "get_project_stats", arguments: {} },
			},
		]) {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		}
		child.stdin.end();

		const messages = await readMessages(child.stdout, 2);
		expect(await child.exited).toBe(0);
		expect(JSON.stringify(messages.find((message) => message.id === 2)?.result)).toContain(
			"storeEvents",
		);
	}, 20_000);

	it("refuses a production key before contacting the API", async () => {
		const api = fakeBillingApi();
		const child = spawnServer({
			QUOTUM_MCP_BASE_URL: api.baseUrl,
			QUOTUM_MCP_API_KEY: productionKey,
		});
		child.stdin.end();
		expect(await child.exited).toBe(1);
		expect(await new Response(child.stdout).text()).toBe("");
		const stderr = await new Response(child.stderr).text();
		expect(stderr).toContain("production key");
		expect(stderr).not.toContain(productionKey);
		expect(api.calls).toEqual([]);
	}, 20_000);

	it("does not fall back to the backend's BILLING_* variables", async () => {
		const child = spawnServer({});
		child.stdin.end();
		expect(await child.exited).toBe(1);
		expect(await new Response(child.stderr).text()).toContain("QUOTUM_MCP_BASE_URL is required");
	}, 20_000);
});

interface JsonRpcMessage {
	jsonrpc: string;
	id?: number;
	result?: unknown;
}

/** Every stdout line must be a JSON-RPC message; anything else corrupts the protocol stream. */
async function readMessages(
	stdout: ReadableStream<Uint8Array>,
	responses: number,
): Promise<JsonRpcMessage[]> {
	const messages: JsonRpcMessage[] = [];
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of stdout) {
		buffered += decoder.decode(chunk, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines.filter((candidate) => candidate.trim() !== "")) {
			const message = JSON.parse(line) as JsonRpcMessage;
			expect(message.jsonrpc).toBe("2.0");
			messages.push(message);
		}
		if (messages.filter((message) => message.id !== undefined).length >= responses) break;
	}
	return messages;
}
