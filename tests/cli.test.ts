import { describe, expect, it } from "bun:test";
import { createSanitizedProcessEnv } from "../scripts/lib/sanitized-env";

const repositoryRoot = new URL("../", import.meta.url).pathname;

async function run(cmd: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn({
		cmd,
		cwd: repositoryRoot,
		env: { ...createSanitizedProcessEnv(), ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("quotum CLI process", () => {
	it("prints help from the bin wrapper the image puts on PATH", async () => {
		const result = await run(["bin/quotum", "help"]);
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(result.stdout).toContain("Usage: quotum <command>");
	});

	it("keeps a command's own exit code and diagnostics", async () => {
		const direct = await run([process.execPath, "--no-env-file", "src/migrate.ts"]);
		const dispatched = await run([process.execPath, "--no-env-file", "src/cli.ts", "migrate"]);
		expect(direct.exitCode).toBe(1);
		expect(dispatched.exitCode).toBe(direct.exitCode);
		expect(dispatched.stdout).toBe("");
		expect(JSON.parse(dispatched.stderr)).toMatchObject({
			level: 50,
			msg: "POSTGRES_URI environment variable is required",
		});
	});

	it("prints a command's help without running it", async () => {
		// Without POSTGRES_URI the migration runner would exit 1; help never reaches it.
		const result = await run(["bin/quotum", "migrate", "--help"]);
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(result.stdout).toStartWith("Usage: quotum migrate [status]\n");
	});

	it("exits 64 with help on stderr for an unknown command", async () => {
		const result = await run([process.execPath, "--no-env-file", "src/cli.ts", "nope"]);
		expect(result.exitCode).toBe(64);
		expect(result.stdout).toBe("");
		expect(result.stderr).toStartWith("Unknown command: nope\nUsage: quotum <command>");
	});
});
