import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";

const repositoryRoot = resolve(import.meta.dir, "../..");

const guards = [
	{
		entrypoint: "src/testing/test-stripe-entrypoint.ts",
		message: "Fake Stripe entrypoint requires BILLING_ENV=test and BILLING_TEST_FAKE_STRIPE=true",
		partial: { BILLING_ENV: "test" },
	},
	{
		entrypoint: "src/testing/test-runtime-entrypoint.ts",
		message: "Loopback projection transport is restricted to explicit tests",
		partial: { BILLING_ENV: "test" },
	},
	{
		entrypoint: "src/testing/test-merchant-entrypoint.ts",
		message: "Merchant test entrypoint requires explicitly enabled test mode and fake providers",
		partial: { BILLING_ENV: "test", BILLING_TEST_FAKE_STRIPE: "true" },
	},
] as const;

describe("test entrypoint guards", () => {
	it("strips billing and database env from the sanitized process env", () => {
		const env = createSanitizedProcessEnv();
		expect(env.BILLING_ENV).toBeUndefined();
		expect(env.POSTGRES_URI).toBeUndefined();
	});

	for (const guard of guards) {
		it(`rejects ${guard.entrypoint} without the required flags`, async () => {
			const sanitized = createSanitizedProcessEnv();
			const [missing, partial] = await Promise.all([
				spawnEntrypoint(guard.entrypoint, sanitized),
				spawnEntrypoint(guard.entrypoint, { ...sanitized, ...guard.partial }),
			]);
			for (const result of [missing, partial]) {
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain(guard.message);
				expect(result.stdout).toBe("");
			}
		});
	}
});

async function spawnEntrypoint(
	entrypoint: string,
	env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const processHandle = Bun.spawn([process.execPath, "run", entrypoint], {
		cwd: repositoryRoot,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return { exitCode, stdout, stderr };
}
