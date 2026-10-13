import { describe, expect, it } from "bun:test";
import { runProjectsCommand } from "../../../src/composition/cli/projects";

function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return runProjectsCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	}).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

const rename = ["rename", "acme", "alpha", "--name", "Alpha App", "--actor", "ops-runbook"];

describe("quotum projects", () => {
	it("rejects wrong arguments with exit 64 before it touches the database", async () => {
		for (const [argv, message] of [
			[[], "Missing subcommand."],
			[["delete", "acme", "alpha"], 'Unknown subcommand "delete".'],
			[["rename", "acme"], "Expected 2 arguments before the options."],
			[["rename", "acme", "alpha", "--actor", "ops"], "--name <name> is required."],
			[["rename", "acme", "alpha", "--name", "Alpha"], "Name the operator with --actor"],
			[[...rename, "--key", "beta"], "Unknown option --key."],
			[[...rename, "--member-override-reason", " "], "--member-override-reason must be"],
		] as const) {
			const result = await run([...argv]);
			expect(result.code).toBe(64);
			expect(result.err).toContain(message);
		}
	});

	it("needs POSTGRES_URI and nothing else", async () => {
		const result = await run(rename);
		expect(result.code).toBe(1);
		expect(result.err).toContain("POSTGRES_URI is required");
	});
});
