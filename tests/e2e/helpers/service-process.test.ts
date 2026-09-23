import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSanitizedProcessEnv } from "../../../scripts/lib/sanitized-env";
import { startBillingService } from "./service-process";

describe("billing service process", () => {
	it("stops a service that never becomes live", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-service-process-"));
		const pidFile = join(directory, "pid");
		let pid: number | null = null;
		try {
			const entrypoint = join(directory, "never-live.ts");
			// Records its pid, then stays up without ever answering /livez.
			await writeFile(
				entrypoint,
				`await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1_000);\n`,
			);
			expect(
				await startBillingService(
					{ ...createSanitizedProcessEnv(), BILLING_ENV: "test" },
					{ entrypoint, startupTimeoutMs: 2_000 },
				).then(
					() => "started",
					(error: Error) => error.message,
				),
			).toStartWith("Timed out waiting for billing service /livez");
			pid = Number(await readFile(pidFile, "utf8"));
			expect(isRunning(pid)).toBe(false);
		} finally {
			if (pid !== null && isRunning(pid)) process.kill(pid, "SIGKILL");
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
