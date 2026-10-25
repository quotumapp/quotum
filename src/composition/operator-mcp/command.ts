import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../../mcp/results";
import { maxResultBytes } from "../../mcp/results";
import { resolveQuotumCommand } from "../cli/dispatch";

export type OperatorEnvironment = Readonly<Record<string, string | undefined>>;
export interface OperatorCommand {
	args: string[];
	env?: Record<string, string>;
	/** JSON data only; never import agent-authored JavaScript or TypeScript. */
	input?: unknown;
}

export interface OperatorCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	outputTruncated?: boolean;
}

export type OperatorCommandRunner = (command: OperatorCommand) => Promise<OperatorCommandResult>;

const sourceRoot = join(import.meta.dir, "../..");
const outputLimit = 1_000_000;

/** Fixed argv from typed setup tools, never a shell or a model-supplied command. */
export function createOperatorCommandRunner(env: OperatorEnvironment): {
	run: OperatorCommandRunner;
	close(): void;
} {
	const children = new Set<ReturnType<typeof Bun.spawn>>();
	let closed = false;
	return {
		async run(command) {
			if (closed) throw new Error("Operator session is closed.");
			const directory = await mkdtemp(join(tmpdir(), "quotum-mcp-"));
			try {
				const inputPath = join(directory, "input.json");
				if (command.input !== undefined) {
					const input = JSON.stringify(command.input);
					if (Buffer.byteLength(input) > 256 * 1024) throw new Error("Setup input exceeds 256 KB.");
					await writeFile(inputPath, input, { mode: 0o600 });
				}
				if (closed) throw new Error("Operator session is closed.");
				const args = [...command.args];
				const inputIndex = args.indexOf("<input>");
				if (command.input !== undefined && inputIndex !== -1) args[inputIndex] = inputPath;
				const selected = resolveQuotumCommand(args);
				if (selected.kind !== "command") throw new Error("Invalid operator command.");
				const child = Bun.spawn({
					cmd: [
						process.execPath,
						"--no-env-file",
						join(sourceRoot, selected.command.file),
						...selected.args,
					],
					cwd: sourceRoot,
					env: { ...env, ...command.env },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				children.add(child);
				// Bound runaway commands without treating a timeout as proof a write rolled back.
				const timeout = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
				try {
					const [exitCode, stdout, stderr] = await Promise.all([
						child.exited,
						readOutput(child.stdout),
						readOutput(child.stderr),
					]);
					return {
						exitCode,
						stdout: stdout.text,
						stderr: stderr.text,
						outputTruncated: stdout.truncated,
					};
				} finally {
					clearTimeout(timeout);
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
					children.delete(child);
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		close() {
			closed = true;
			for (const child of children) child.kill("SIGTERM");
		},
	};
}

async function readOutput(
	stream: ReadableStream<Uint8Array>,
): Promise<{ text: string; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of stream) {
		length += chunk.byteLength;
		if (length <= outputLimit) chunks.push(chunk);
	}
	// Keep draining even after the cap, so a command cannot block with a full stdout pipe.
	return {
		text: length > outputLimit ? "" : Buffer.concat(chunks).toString("utf8"),
		truncated: length > outputLimit,
	};
}

/** A single filename inside the host-selected private directory. Output files use CLI wx/0600. */
export async function operatorFile(
	directory: string,
	name: string,
	input: boolean,
): Promise<string> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
		throw new Error("Use a filename in the configured setup directory, without path separators.");
	const path = join(directory, name);
	if (input) {
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024)
			throw new Error("The secrets file must be a regular JSON file of at most 64 KB.");
		if ((await realpath(path)) !== path) throw new Error("Secrets files cannot be symlinks.");
		const secrets: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			typeof secrets !== "object" ||
			secrets === null ||
			Array.isArray(secrets) ||
			!Object.values(secrets).every((value) => typeof value === "string")
		)
			throw new Error("The secrets file must hold a JSON object of string values.");
	}
	return path;
}

/**
 * CLI diagnostics can contain provider/database errors. Do not pass raw stderr or exceptions to
 * the model. Expose only a code, plus commands' deliberate JSON results (which exclude secrets).
 */
export function operatorResult(result: OperatorCommandResult): ToolResult {
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		const lines = result.stdout.trim().split("\n");
		data = lines.every((line) => /^(applied|pending) [a-z0-9_]+\.sql$/.test(line))
			? {
					migrations: lines.map((line) => {
						const [status, file] = line.split(" ");
						return { status, file };
					}),
				}
			: undefined;
	}
	const failed = result.exitCode !== 0 && result.exitCode !== 2;
	const errorCode = /^([A-Z][A-Z0-9_]{2,80}):/.exec(result.stderr)?.[1];
	const body = failed
		? {
				exitCode: result.exitCode,
				error: errorCode ?? "Operator command failed.",
				hint: "Inspect setup configuration and the target's current state before retrying. A failed or interrupted command may have committed; reuse the same requestKey where supported.",
			}
		: { exitCode: result.exitCode, ...(data === undefined ? { completed: true } : { data }) };
	const text = JSON.stringify(body);
	return {
		content: [
			{
				type: "text",
				text:
					Buffer.byteLength(text) <= maxResultBytes && (!result.outputTruncated || failed)
						? text
						: JSON.stringify({
								exitCode: result.exitCode,
								completed: true,
								resultOmitted: "Result exceeds the MCP response limit; the command completed.",
							}),
			},
		],
		...(failed ? { isError: true } : {}),
	};
}
