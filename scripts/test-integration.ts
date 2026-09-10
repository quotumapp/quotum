import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { trapInterrupts } from "./lib/interrupts";
import { run, startPostgresContainer } from "./lib/postgres-container";
import { createSanitizedProcessEnv } from "./lib/sanitized-env";
import { bootstrapTestPlatform } from "./lib/test-platform-bootstrap";
import { assertLaneReport, junitReporterArgs, readJunitSummary } from "./lib/test-report";

const postgresDatabase = "voysee_billing_test";
const testTargets = process.argv.slice(2);
const projectInstanceKeys = ["voysee", "wiseley"] as const;
const merchantLane = testTargets.some((target) => target.startsWith("integration/merchant"));
const lane = merchantLane ? "merchant" : "integration";

const interrupts = trapInterrupts();
try {
	await runIntegrationTests();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = interrupts.exitCode() ?? 1;
}

async function runIntegrationTests(): Promise<void> {
	let container: StartedPostgreSqlContainer | undefined;
	let reportDirectory: string | undefined;
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
		const env = merchantLane
			? { ...migrationEnv, BILLING_TEST_LANE: lane }
			: await withBootstrappedProjects(migrationEnv, container.getConnectionUri());
		reportDirectory = await mkdtemp(join(tmpdir(), "quotum-lane-report-"));
		const reportPath = join(reportDirectory, "junit.xml");
		run(
			"bun",
			[
				"test",
				...junitReporterArgs(reportPath),
				...(testTargets.length === 0 ? ["tests/integration"] : testTargets),
			],
			{ env },
		);
		assertLaneReport(readJunitSummary(await readFile(reportPath, "utf8")), lane);
	} finally {
		if (container !== undefined) {
			try {
				await container.stop();
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		}
		if (reportDirectory !== undefined) {
			await rm(reportDirectory, { recursive: true, force: true });
		}
	}
}

async function withBootstrappedProjects(
	migrationEnv: NodeJS.ProcessEnv,
	postgresUri: string,
): Promise<NodeJS.ProcessEnv> {
	const platform = await bootstrapTestPlatform(postgresUri, projectInstanceKeys);
	return {
		...migrationEnv,
		BILLING_TEST_LANE: lane,
		BILLING_TEST_CONNECTIONS_JSON: JSON.stringify(
			platform.contexts.map((project) => ({
				projectInstanceKey: project.projectInstanceKey,
				projectionUrl: `https://${project.projectInstanceKey}.projection.integration.test`,
				projectionSecret: `${project.projectInstanceKey}-projection-secret`,
			})),
		),
		BILLING_TEST_PROJECT_CONTEXTS_JSON: JSON.stringify(platform.contexts),
		BILLING_TEST_PROJECT_CREDENTIALS_JSON: JSON.stringify(platform.credentials),
	};
}
