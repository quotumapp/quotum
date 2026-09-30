import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BillingClient } from "../sdk/index";
import { writeStderr } from "../shared/cli-output";
import { McpConfigError, readMcpConfig } from "./config";
import { createContractStore } from "./contracts";
import { DrainingStdioTransport } from "./draining-stdio-transport";
import { createGuardedFetch } from "./guarded-fetch";
import { createQuotumMcpServer } from "./server";

// stdout carries the protocol, so every diagnostic goes to stderr.
try {
	const config = readMcpConfig(process.env);
	const log = (line: string) => writeStderr(line.replaceAll(config.apiKey, "[redacted]"));
	if (config.insecureHttp) log("quotum-mcp: sending the project key over plain http");

	const client = new BillingClient({
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		fetch: createGuardedFetch({ baseUrl: config.baseUrl }),
	});
	const version = process.env.BUILD_VERSION?.trim() || "0.0.0-dev";
	const contractsDirectory = resolve(import.meta.dir, "../../contracts/v1");
	const contracts = existsSync(resolve(contractsDirectory, "openapi.json"))
		? createContractStore(contractsDirectory)
		: undefined;
	if (contracts === undefined) log("quotum-mcp: contracts/v1 not found; contract tools are off");
	// When stdin ends, the transport answers what the host already sent, bounded like the service's
	// own shutdown, and then closes, which also ends `docker run -i` containers. A signal means
	// nobody is listening, so it closes at once.
	const transport = new DrainingStdioTransport(process.stdin, process.stdout);
	const handle = serveStdio(() => createQuotumMcpServer({ client, log, version, contracts }), {
		transport,
		onerror: (error) => log(`quotum-mcp: ${error.name}: ${error.message}`),
	});
	const exit = () => void handle.close().finally(() => process.exit(0));
	void transport.closed.then(exit);
	process.once("SIGINT", exit);
	process.once("SIGTERM", exit);
} catch (error) {
	writeStderr(
		error instanceof McpConfigError
			? `quotum-mcp: ${error.message}`
			: "quotum-mcp: failed to start",
	);
	process.exitCode = 1;
}
