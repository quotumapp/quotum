import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { run, startPostgresContainer } from "./lib/postgres-container";
import { createContainerTestEnv, createSanitizedProcessEnv } from "./lib/sanitized-env";
import {
	createTestPlatformManifest,
	resolveTestPlatformContexts,
} from "./lib/test-platform-bootstrap";

const postgresDatabase = "voysee_billing_e2e";

try {
	await runE2eTests();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

async function runE2eTests(): Promise<void> {
	let container: StartedPostgreSqlContainer | undefined;
	let credentialDirectory: string | undefined;
	try {
		container = await startPostgresContainer({ postgresDatabase });

		const migrationEnv = {
			...createSanitizedProcessEnv(),
			NODE_ENV: "test",
			POSTGRES_URI: container.getConnectionUri(),
			RUN_BILLING_E2E_TESTS: "1",
		};

		run("bun", ["run", "migrate"], { env: migrationEnv });
		const manifest = createTestPlatformManifest(["voysee", "wiseley"]);
		credentialDirectory = await mkdtemp(join(tmpdir(), "quotum-e2e-platform-"));
		const credentialPath = join(credentialDirectory, "credentials.json");
		const bootstrapEnv = {
			...migrationEnv,
			BILLING_PLATFORM_BOOTSTRAP_JSON: JSON.stringify(manifest),
		};
		run(
			"bun",
			["run", "platform:bootstrap", "--", "--apply", "--credentials-out", credentialPath],
			{ env: bootstrapEnv },
		);
		if (((await stat(credentialPath)).mode & 0o777) !== 0o600) {
			throw new Error("E2E bootstrap credential file is not owner-only");
		}
		const credentials = await readBootstrapCredentials(credentialPath);
		const contexts = await resolveTestPlatformContexts(container.getConnectionUri(), manifest);
		run("bun", ["run", "platform:bootstrap", "--", "--check"], { env: bootstrapEnv });
		const env = {
			...createContainerTestEnv(),
			...migrationEnv,
			BILLING_TEST_PROJECT_CONTEXTS_JSON: JSON.stringify(contexts),
			BILLING_TEST_PROJECT_CREDENTIALS_JSON: JSON.stringify(credentials),
		};
		run("bun", ["test", "--timeout=20000", "tests/e2e"], { env });
	} finally {
		if (container !== undefined) {
			try {
				await container.stop();
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		}
		if (credentialDirectory !== undefined) {
			await rm(credentialDirectory, { recursive: true, force: true });
		}
	}
}

async function readBootstrapCredentials(path: string): Promise<Readonly<Record<string, string>>> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("E2E bootstrap credential output is invalid");
	}
	const output = parsed as Record<string, unknown>;
	if (output.version !== 1 || !Array.isArray(output.credentials)) {
		throw new Error("E2E bootstrap credential output is invalid");
	}
	const credentials: Record<string, string> = {};
	for (const item of output.credentials) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("E2E bootstrap credential output is invalid");
		}
		const record = item as Record<string, unknown>;
		if (
			typeof record.projectInstanceKey !== "string" ||
			typeof record.credential !== "string" ||
			record.projectInstanceKey in credentials
		) {
			throw new Error("E2E bootstrap credential output is invalid");
		}
		credentials[record.projectInstanceKey] = record.credential;
	}
	return credentials;
}
