import { describe, expect, it } from "bun:test";
import { runSecondFactorCommand } from "../../../src/composition/cli/second-factor";

function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return runSecondFactorCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	}).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

const reset = [
	"reset",
	"--email",
	"owner@acme.example",
	"--reason",
	"Verified by video call",
	"--actor",
	"ops-runbook",
];

describe("quotum second-factor", () => {
	it("rejects wrong arguments with exit 64 before it touches the database", async () => {
		for (const [argv, message] of [
			[[], "Missing subcommand."],
			[["disable"], 'Unknown subcommand "disable".'],
			[["reset", "acme"], "Expected 0 argument"],
			[["reset", "--reason", "x", "--actor", "ops"], "--email <address> is required."],
			[
				["reset", "--email", "not-an-address", "--reason", "x", "--actor", "ops"],
				"--email must be one",
			],
			[["reset", "--email", "a@b.example", "--actor", "ops"], "--reason <why> is required."],
			[
				["reset", "--email", "a@b.example", "--reason", "bad‮reason", "--actor", "ops"],
				"--reason must be 1-200 printable characters.",
			],
			[["reset", "--email", "a@b.example", "--reason", "x"], "Name the operator with --actor"],
			[[...reset, "--member-override-reason", "x"], "Unknown option --member-override-reason."],
		] as const) {
			// No POSTGRES_URI is set, so any attempt to connect would fail differently.
			const result = await run([...argv]);
			expect(result.code).toBe(64);
			expect(result.err).toContain(message);
		}
	});

	it("refuses a headless deployment, which has no merchant sign-in", async () => {
		for (const flag of [undefined, "false"]) {
			const result = await run(reset, {
				POSTGRES_URI: "postgres://unused.invalid/none",
				QUOTUM_CONSOLE_ENABLED: flag,
			});
			expect(result.code).toBe(1);
			expect(result.err).toContain("QUOTUM_CONSOLE_ENABLED is not true");
		}
	});

	it("needs POSTGRES_URI", async () => {
		const result = await run(reset, { QUOTUM_CONSOLE_ENABLED: "true" });
		expect(result.code).toBe(1);
		expect(result.err).toContain("POSTGRES_URI is required");
	});
});
