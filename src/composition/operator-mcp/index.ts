import { realpath, stat } from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DrainingStdioTransport } from "../../mcp/draining-stdio-transport";
import { writeStderr } from "../../shared/cli-output";
import { operatorActor, parseArguments } from "../cli/operator-context";
import { createOperatorMcpServer } from "./server";

async function main() {
	const args = process.argv.slice(2);
	if (args.filter((value) => value === "--allow-writes").length !== 1)
		throw new Error("Explicit opt-in required");
	const { options } = parseArguments(
		args.filter((value) => value !== "--allow-writes"),
		["actor", "directory"],
		0,
	);
	const actor = operatorActor(options, {});
	const directoryOption = options.get("directory");
	if (!directoryOption) throw new Error("Private directory required");
	const directory = await realpath(directoryOption);
	const metadata = await stat(directory);
	if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
		throw new Error("Private directory required");
	const transport = new DrainingStdioTransport(process.stdin, process.stdout);
	const handle = serveStdio(() => createOperatorMcpServer({ actor, directory, env: process.env }), {
		transport,
		onerror: () => writeStderr("quotum-operator: protocol error"),
	});
	const exit = () => void handle.close().finally(() => process.exit(0));
	void transport.closed.then(exit);
	process.once("SIGINT", exit);
	process.once("SIGTERM", exit);
}

if (import.meta.main)
	main().catch(() => {
		writeStderr(
			"quotum-operator: supply --allow-writes, --actor and a private --directory. See quotum mcp operator --help.",
		);
		process.exitCode = 1;
	});
