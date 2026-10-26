import { realpath, stat } from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DrainingStdioTransport } from "../../mcp/draining-stdio-transport";
import { writeStderr } from "../../shared/cli-output";
import { operatorActor, parseArguments } from "../cli/operator-context";
import { createOperatorCommandRunner } from "./command";
import { createOperatorMcpServer } from "./server";

/** A separate opt-in process; this is never mounted in the HTTP or read-only MCP servers. */
export async function startOperatorMcp(args: readonly string[]): Promise<void> {
	if (args.filter((arg) => arg === "--allow-writes").length !== 1)
		throw new Error("Local operator MCP requires --allow-writes. Run quotum mcp operator --help.");
	const { options } = parseArguments(
		args.filter((arg) => arg !== "--allow-writes"),
		["directory", "actor"],
		0,
	);
	const actor = operatorActor(options, {});
	const selectedDirectory = options.get("directory");
	if (!selectedDirectory) throw new Error("--directory <private-setup-directory> is required.");
	const directory = await realpath(selectedDirectory);
	const metadata = await stat(directory);
	if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
		throw new Error(
			"The setup directory must be private (chmod 700) and accessible to this process.",
		);
	const runner = createOperatorCommandRunner(process.env);
	const transport = new DrainingStdioTransport(process.stdin, process.stdout, {
		drainTimeoutMs: 30_000,
	});
	const handle = serveStdio(
		() =>
			createOperatorMcpServer({
				version: process.env.BUILD_VERSION?.trim() || "0.0.0-dev",
				actor,
				directory,
				env: process.env,
				run: runner.run,
			}),
		{
			transport,
			onerror: () => writeStderr("quotum-operator: protocol error"),
		},
	);
	const exit = () => {
		runner.close();
		void handle.close().finally(() => process.exit(0));
	};
	void transport.closed.then(exit);
	process.once("SIGINT", exit);
	process.once("SIGTERM", exit);
}

if (import.meta.main) {
	try {
		await startOperatorMcp(process.argv.slice(2));
	} catch {
		// Startup exceptions can carry path or configuration content. Help is available separately.
		writeStderr(
			"quotum-operator: startup refused; provide --allow-writes, --actor and a private --directory. Run quotum mcp operator --help.",
		);
		process.exitCode = 1;
	}
}
