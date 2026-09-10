import { spawnSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const postgresImage =
	"postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2";
const postgresUser = "postgres";
const postgresPassword = "postgres";

export interface EphemeralPostgresOptions {
	postgresDatabase: string;
}

export function createPostgresContainer(options: EphemeralPostgresOptions): PostgreSqlContainer {
	return new PostgreSqlContainer(postgresImage)
		.withDatabase(options.postgresDatabase)
		.withUsername(postgresUser)
		.withPassword(postgresPassword);
}

export function startPostgresContainer(
	options: EphemeralPostgresOptions,
): Promise<StartedPostgreSqlContainer> {
	applyTestcontainersDefaults(process.env);
	return createPostgresContainer(options).start();
}

export function applyTestcontainersDefaults(env: NodeJS.ProcessEnv): void {
	env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
}

interface RunOptions {
	captureStdout?: boolean;
	env?: NodeJS.ProcessEnv;
}

export function run(command: string, args: string[], options: RunOptions = {}): string {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: options.captureStdout === true ? ["ignore", "pipe", "inherit"] : "inherit",
		env: options.env ?? process.env,
	});

	if (result.error !== undefined) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with status ${result.status ?? 1}`);
	}

	return typeof result.stdout === "string" ? result.stdout.trim() : "";
}
