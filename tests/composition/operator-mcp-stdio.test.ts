import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";

const root = resolve(import.meta.dir, "../..");
function spawn(args: string[]) {
	return Bun.spawn({
		cmd: [process.execPath, "--no-env-file", join(root, "src/cli.ts"), "mcp", "operator", ...args],
		cwd: root,
		env: {
			...createSanitizedProcessEnv(),
			QUOTUM_AUTH_SECRET: "do-not-echo-this-secret",
			BILLING_PROJECT_API_KEY: `pqpk_${"x".repeat(43)}`,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("operator MCP stdio process", () => {
	it("requires explicit write opt-in, actor and a private directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "operator-launch-"));
		try {
			for (const args of [
				["--actor", "ops", "--directory", directory],
				["--allow-writes", "--directory", directory],
				["--allow-writes", "--actor", "ops"],
			]) {
				const child = spawn(args);
				child.stdin.end();
				expect(await child.exited).toBe(1);
				expect(await new Response(child.stdout).text()).toBe("");
				const stderr = await new Response(child.stderr).text();
				expect(stderr).toContain("startup refused");
				expect(stderr).not.toContain("do-not-echo");
			}
			await chmod(directory, 0o755);
			const child = spawn(["--allow-writes", "--actor", "ops", "--directory", directory]);
			child.stdin.end();
			expect(await child.exited).toBe(1);
			expect(await new Response(child.stdout).text()).toBe("");
			expect(await new Response(child.stderr).text()).toContain("startup refused");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);

	it("uses only JSON-RPC stdout and answers pending requests before stdin closes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "operator-launch-"));
		try {
			const child = spawn(["--allow-writes", "--actor", "ops", "--directory", directory]);
			for (const message of [
				{
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "test", version: "1" },
					},
				},
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
				{
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: { name: "get_setup_status", arguments: {} },
				},
			])
				child.stdin.write(`${JSON.stringify(message)}\n`);
			child.stdin.end();
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code).toBe(0);
			expect(stderr).toBe("");
			const messages = stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(messages).toHaveLength(3);
			for (const message of messages) expect(message.jsonrpc).toBe("2.0");
			expect(messages.find((message) => message.id === 1).result.serverInfo.name).toBe(
				"quotum-operator",
			);
			expect(
				messages
					.find((message) => message.id === 2)
					.result.tools.map((tool: { name: string }) => tool.name),
			).toContain("apply_bootstrap");
			expect(JSON.stringify(messages.find((message) => message.id === 3).result)).toContain(
				"POSTGRES_URI",
			);
			expect(stdout).not.toContain("do-not-echo-this-secret");
			expect(stdout).not.toContain("pqpk_");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
