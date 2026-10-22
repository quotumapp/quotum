import { describe, expect, it } from "bun:test";
import { runEnvironmentsCommand } from "../../../src/composition/cli/environments";

function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return runEnvironmentsCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	}).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

describe("quotum environments", () => {
	it("rejects wrong arguments with exit 64 before it touches the database", async () => {
		for (const [argv, message] of [
			[[], "Missing subcommand."],
			[["list"], 'Unknown subcommand "list".'],
			[["readiness"], "Expected 1 argument before the options."],
			[["readiness", "acme", "extra"], "Expected 1 argument before the options."],
			[["readiness", "acme", "--actor", "ops"], "Unknown option --actor."],
			[["activate", "acme"], 'Unknown subcommand "activate".'],
			[["suspend"], "Expected 1 argument before the options."],
			[["suspend", "acme", "--actor", "ops"], "--reason <why> is required to suspend"],
			[["suspend", "acme", "--reason", "incident"], "Name the operator with --actor"],
			[["suspend", "acme", "--reason", " ", "--actor", "ops"], "--reason must be 1-200"],
			[["resume", "acme", "--reason", "ok"], "Name the operator with --actor"],
			[["resume", "acme", "--actor", "ops", "--credentials-out", "k"], "Unknown option"],
			[["suspend", "acme", "--reason", "x\u202Ey", "--actor", "ops"], "--reason must be 1-200"],
		] as const) {
			// No POSTGRES_URI is set, so any attempt to connect would fail differently.
			const result = await run([...argv]);
			expect(result.code).toBe(64);
			expect(result.err).toContain(message);
			expect(result.out).toBe("");
		}
	});

	it("needs only POSTGRES_URI to suspend or resume", async () => {
		// The connection key and auth secret that readiness reads are not needed.
		for (const argv of [
			["suspend", "acme", "--reason", "incident", "--actor", "ops"],
			["resume", "acme", "--actor", "ops"],
		]) {
			const result = await run(argv);
			expect(result.code).toBe(1);
			expect(result.err).toContain("POSTGRES_URI is required");
		}
	});

	it("needs POSTGRES_URI for readiness", async () => {
		for (const argv of [["readiness", "acme"]]) {
			const result = await run(argv);
			expect(result.code).toBe(1);
			expect(result.err).toContain("POSTGRES_URI is required");
			expect(result.out).toBe("");
		}
	});
});
