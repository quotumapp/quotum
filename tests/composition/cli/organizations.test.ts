import { describe, expect, it } from "bun:test";
import { runOrganizationsCommand } from "../../../src/composition/cli/organizations";

function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return runOrganizationsCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	}).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

const addOwner = ["add-owner", "acme", "--email", "owner@acme.example", "--actor", "ops-runbook"];

describe("quotum organizations", () => {
	it("rejects wrong arguments with exit 64 before it touches the database", async () => {
		for (const [argv, message] of [
			[[], "Missing subcommand."],
			[["list"], 'Unknown subcommand "list".'],
			[["add-owner"], "Expected 1 argument before the options."],
			[["add-owner", "acme", "--actor", "ops"], "--email <address> is required."],
			[["add-owner", "acme", "--email", "not-an-address", "--actor", "ops"], "--email must be one"],
			[["add-owner", "acme", "--email", "a@b.example"], "Name the operator with --actor"],
			[[...addOwner, "--member-override-reason", " "], "--member-override-reason must be"],
			[[...addOwner, "--role", "Owner"], "Unknown option --role."],
		] as const) {
			// No POSTGRES_URI is set, so any attempt to connect would fail differently.
			const result = await run([...argv]);
			expect(result.code).toBe(64);
			expect(result.err).toContain(message);
		}
	});

	it("refuses a headless deployment, which has no merchant application to sign in to", async () => {
		// Headless is the default, so an unset flag is refused like an explicit false.
		for (const flag of [undefined, "false"]) {
			const result = await run(addOwner, {
				POSTGRES_URI: "postgres://unused.invalid/none",
				QUOTUM_CONSOLE_ENABLED: flag,
			});
			expect(result.code).toBe(1);
			expect(result.err).toContain("QUOTUM_CONSOLE_ENABLED is not true");
			expect(result.err).toContain("no merchant application");
		}
	});

	it("needs POSTGRES_URI", async () => {
		const result = await run(addOwner, { QUOTUM_CONSOLE_ENABLED: "true" });
		expect(result.code).toBe(1);
		expect(result.err).toContain("POSTGRES_URI is required");
	});
});
