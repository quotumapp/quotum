import { describe, expect, it } from "bun:test";
import { runAuditCommand } from "../../../src/composition/cli/audit";

function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	return runAuditCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	}).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

describe("quotum audit", () => {
	it("rejects wrong arguments with exit 64 before it touches the database", async () => {
		for (const [argv, message] of [
			[[], "Missing subcommand."],
			[["export"], 'Unknown subcommand "export".'],
			[["list", "acme"], "Expected 0 arguments before the options."],
			[["list", "--format", "csv"], "Unknown option --format."],
			[["list", "--limit", "0"], "--limit must be a whole number from 1 to 500."],
			[["list", "--limit", "501"], "--limit must be a whole number from 1 to 500."],
			[["list", "--limit", "ten"], "--limit must be a whole number from 1 to 500."],
			[["list", "--since", "yesterday"], "--since must be an ISO 8601 timestamp with a zone"],
			[["list", "--until", "2026-10-13"], "--until must be an ISO 8601 timestamp with a zone"],
			[["list", "--until", "2026-10-13T09:00:00"], "--until must be an ISO 8601 timestamp"],
			[["list", "--since", "2026-13-45T09:00:00Z"], "--since must be an ISO 8601 timestamp"],
			[["list", "--before", "not-an-id"], "--before must be an audit event id."],
			[["list", "--action", "Credential Rotated"], "--action must be an event name"],
			[["list", "--organization"], "--organization needs a value."],
			[["list", "--limit", "5", "--limit", "6"], "--limit is given more than once."],
		] as const) {
			// No POSTGRES_URI is set, so any attempt to connect would fail differently.
			const result = await run([...argv]);
			expect(result.code).toBe(64);
			expect(result.err).toContain(message);
		}
	});

	it("needs POSTGRES_URI and nothing else", async () => {
		const result = await run(["list"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("POSTGRES_URI is required");
	});
});
