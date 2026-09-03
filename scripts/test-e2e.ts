import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { run, startPostgresContainer } from "./lib/postgres-container";
import { createSanitizedProcessEnv } from "./lib/sanitized-env";

const postgresDatabase = "voysee_billing_e2e";

try {
	await runE2eTests();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

async function runE2eTests(): Promise<void> {
	let container: StartedPostgreSqlContainer | undefined;
	try {
		container = await startPostgresContainer({ postgresDatabase });

		const env = {
			...createSanitizedProcessEnv(),
			NODE_ENV: "test",
			POSTGRES_URI: container.getConnectionUri(),
			RUN_BILLING_E2E_TESTS: "1",
		};

		run("bun", ["run", "migrate"], { env });
		run("bun", ["test", "--timeout=20000", "tests/e2e"], { env });
	} finally {
		if (container !== undefined) {
			try {
				await container.stop();
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		}
	}
}
