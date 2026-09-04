import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { run, startPostgresContainer } from "./lib/postgres-container";
import { createSanitizedProcessEnv } from "./lib/sanitized-env";
import { bootstrapTestPlatform } from "./lib/test-platform-bootstrap";

const postgresDatabase = "voysee_billing_test";
const testTargets = process.argv.slice(2);
const projectInstanceKeys = ["voysee", "wiseley"] as const;

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

		const migrationEnv = {
			...createSanitizedProcessEnv(),
			POSTGRES_URI: container.getConnectionUri(),
			RUN_POSTGRES_INTEGRATION_TESTS: "1",
			BILLING_ENV: "test",
		};

		run("bun", ["run", "scripts/test-migration-integrity.ts"], { env: migrationEnv });
		run("bun", ["run", "migrate"], { env: migrationEnv });
		const platform = await bootstrapTestPlatform(container.getConnectionUri(), projectInstanceKeys);
		const env = {
			...migrationEnv,
			BILLING_PROJECT_RUNTIME_JSON: JSON.stringify(
				platform.contexts.map((project) => ({
					projectInstanceKey: project.projectInstanceKey,
					projectionUrl: `https://${project.projectInstanceKey}.projection.integration.test`,
					projectionSecret: `${project.projectInstanceKey}-projection-secret`,
				})),
			),
			BILLING_TEST_PROJECT_CONTEXTS_JSON: JSON.stringify(platform.contexts),
			BILLING_TEST_PROJECT_CREDENTIALS_JSON: JSON.stringify(platform.credentials),
		};
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
