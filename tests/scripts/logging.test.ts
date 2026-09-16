import { describe, expect, it } from "bun:test";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";

async function runScript(script: string, args: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn({
		cmd: [process.execPath, "--no-env-file", script, ...args],
		cwd: new URL("../../", import.meta.url).pathname,
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

describe("script output contracts", () => {
	it("keeps release labels and build metadata as plain stdout", async () => {
		const labels = await runScript("scripts/release.ts", ["pr-title"], {
			PR_TITLE: "refactor(logging): replace console diagnostics with Pino",
		});
		expect(labels).toEqual({ stdout: "maintenance\n", stderr: "", exitCode: 0 });
		const build = await runScript("scripts/release.ts", ["build-version"], {
			GITHUB_REF_TYPE: "tag",
			GITHUB_REF_NAME: "v1.2.3",
			GITHUB_SHA: "a".repeat(40),
		});
		expect(build).toEqual({ stdout: "version=1.2.3\n", stderr: "", exitCode: 0 });
	});

	it("reports release failures as JSON on stderr with the same failure exit code", async () => {
		const result = await runScript("scripts/release.ts", ["pr-title"], {
			PR_TITLE: "invalid title",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toMatchObject({ level: 50, msg: expect.any(String) });
	});

	it.each(["scripts/billing-catalog.ts", "scripts/test-load.ts"])(
		"keeps %s help as plain stdout",
		async (script) => {
			const result = await runScript(script, ["--help"]);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain(
				script.includes("billing-catalog") ? "billing-catalog <command>" : "bun run test:load",
			);
			expect(result.stdout).not.toContain('"level":');
		},
	);

	it("logs a missing migration setting before immediate process exit", async () => {
		const result = await runScript("src/migrate.ts", []);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toMatchObject({
			level: 50,
			msg: "POSTGRES_URI environment variable is required",
		});
	});

	it("logs projection receiver events to stderr without its secret", async () => {
		const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
		const port = reservation.port;
		reservation.stop(true);
		const secret = "receiver-secret-never-log";
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				"--no-env-file",
				"scripts/projection-receiver.ts",
				`--port=${port}`,
				`--secret=${secret}`,
			],
			cwd: new URL("../../", import.meta.url).pathname,
			env: createSanitizedProcessEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			const url = `http://127.0.0.1:${port}`;
			let ready = false;
			for (let attempt = 0; attempt < 50; attempt++) {
				try {
					await fetch(url, { signal: AbortSignal.timeout(100) });
					ready = true;
					break;
				} catch {
					await Bun.sleep(20);
				}
			}
			expect(ready).toBe(true);
			const response = await fetch(`${url}/internal/billing/projections`, {
				method: "POST",
				headers: { authorization: `Bearer ${secret}` },
				body: "{}",
				signal: AbortSignal.timeout(1_000),
			});
			expect(response.status).toBe(401);
		} finally {
			child.kill();
			await child.exited;
		}
		expect(await stdout).toBe("");
		const output = await stderr;
		expect(output).not.toContain(secret);
		expect(
			output
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toMatchObject([
			{ level: 30, msg: "Projection receiver listening" },
			{ level: 40, msg: "Projection rejected", context: { status: 401 } },
		]);
	});
});
