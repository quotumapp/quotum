import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BillingClient } from "../sdk/index";
import { writeStderr } from "../shared/cli-output";
import { McpConfigError, readMcpConfig } from "./config";
import { createGuardedFetch } from "./guarded-fetch";
import { whenIdle } from "./results";
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
	const handle = serveStdio(() => createQuotumMcpServer({ client, log, version }), {
		onerror: (error) => log(`quotum-mcp: ${error.name}: ${error.message}`),
	});

	let closing = false;
	const close = (drain: boolean) => {
		if (closing) return;
		closing = true;
		const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
		// A host that closes stdin may still be waiting for answers to what it already sent. The
		// wait is bounded like the service's own shutdown; a signal means nobody is listening.
		const drained = drain
			? Promise.race([
					pause(50)
						.then(whenIdle)
						.then(() => pause(50)),
					pause(10_000),
				])
			: Promise.resolve();
		void drained.then(() => handle.close()).finally(() => process.exit(0));
	};
	process.once("SIGINT", () => close(false));
	process.once("SIGTERM", () => close(false));
	// The stdio transport ignores end-of-input, which would orphan `docker run -i` containers.
	process.stdin.once("end", () => close(true));
	process.stdin.once("close", () => close(true));
} catch (error) {
	writeStderr(
		error instanceof McpConfigError
			? `quotum-mcp: ${error.message}`
			: "quotum-mcp: failed to start",
	);
	process.exitCode = 1;
}
