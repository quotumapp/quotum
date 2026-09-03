import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { run, startPostgresContainer } from "./lib/postgres-container";

const postgresDatabase = "voysee_billing_test";
const testTargets = process.argv.slice(2);

try {
	await runIntegrationTests();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

async function runIntegrationTests(): Promise<void> {
	let container: StartedPostgreSqlContainer | undefined;
	try {
		container = await startPostgresContainer({ postgresDatabase });

		const env = {
			...process.env,
			POSTGRES_URI: container.getConnectionUri(),
			RUN_POSTGRES_INTEGRATION_TESTS: "1",
		};

		run("bun", ["run", "scripts/test-migration-integrity.ts"], { env });
		run("bun", ["run", "migrate"], { env });
		run("bun", ["test", ...(testTargets.length === 0 ? ["tests/integration"] : testTargets)], {
			env,
		});
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
