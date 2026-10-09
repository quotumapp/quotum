import { describe, expect, it } from "bun:test";
import { runEnvironmentsCommand } from "../../../src/composition/cli/environments";

function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return runEnvironmentsCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	}).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

const activate = ["activate", "acme", "--credentials-out", "keys.json", "--actor", "ops-runbook"];

describe("quotum environments", () => {
	it("rejects wrong arguments with exit 64 before it touches the database", async () => {
		for (const [argv, message] of [
			[[], "Missing subcommand."],
			[["list"], 'Unknown subcommand "list".'],
			[["readiness"], "Expected 1 argument before the options."],
			[["readiness", "acme", "extra"], "Expected 1 argument before the options."],
			[["readiness", "acme", "--actor", "ops"], "Unknown option --actor."],
			[["activate"], "Expected 1 argument before the options."],
			[["activate", "acme", "--actor", "ops"], "--credentials-out <new-file> is required."],
			[["activate", "acme", "--credentials-out", "keys.json"], "Name the operator with --actor"],
			[[...activate, "--access", "full"], "Unknown option --access."],
			[[...activate, "--request-key", "short"], "--request-key must be"],
			[[...activate, "--member-override-reason", " "], "--member-override-reason must be"],
			[
				[...activate, "--credentials-out", "again.json"],
				"--credentials-out is given more than once.",
			],
		] as const) {
			// No POSTGRES_URI is set, so any attempt to connect would fail differently.
			const result = await run([...argv]);
			expect(result.code).toBe(64);
			expect(result.err).toContain(message);
			expect(result.out).toBe("");
		}
	});

	it("needs POSTGRES_URI for both subcommands", async () => {
		for (const argv of [["readiness", "acme"], activate]) {
			const result = await run(argv);
			expect(result.code).toBe(1);
			expect(result.err).toContain("POSTGRES_URI is required");
			expect(result.out).toBe("");
		}
	});
});
