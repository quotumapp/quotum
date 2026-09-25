import { spawnSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient, ImageName, Wait } from "testcontainers";

const postgresImage =
	"postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2";
const postgresUser = "postgres";
const postgresPassword = "postgres";

export interface EphemeralPostgresOptions {
	postgresDatabase: string;
}

export function createPostgresContainer(options: EphemeralPostgresOptions): PostgreSqlContainer {
	return (
		new PostgreSqlContainer(postgresImage)
			.withDatabase(options.postgresDatabase)
			.withUsername(postgresUser)
			.withPassword(postgresPassword)
			// The database is disposable. PostgreSQL 18 keeps its versioned data
			// below /var/lib/postgresql, so put that directory on bounded tmpfs and
			// avoid the storage-constrained nested-Docker overlay in CI.
			.withTmpFs({ "/var/lib/postgresql": "rw,nosuid,nodev,size=512m" })
			.withHealthCheck({
				// The image starts a temporary server during initdb. PID 1 becomes
				// postgres only after the entrypoint hands off to the final server.
				test: [
					"CMD-SHELL",
					'test "$(cat /proc/1/comm)" = postgres && pg_isready --host localhost --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"',
				],
				interval: 250,
				timeout: 1_000,
				retries: 1_000,
			})
			.withWaitStrategy(Wait.forHealthCheck())
	);
}

export async function startPostgresContainer(
	options: EphemeralPostgresOptions,
): Promise<StartedPostgreSqlContainer> {
	await ensurePostgresImage();
	applyTestcontainersDefaults(process.env);
	return createPostgresContainer(options).start();
}

export interface ImageRegistry {
	exists(): Promise<boolean>;
	pull(): Promise<void>;
}

export interface EnsureImageOptions {
	attempts?: number;
	registry?: ImageRegistry;
	sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Hosted runners sometimes get a 5xx from the registry or lose a just-pulled image, and
 * testcontainers then fails the whole lane when it creates the container. Pull the pinned image
 * up front through the testcontainers runtime client, with bounded exponential backoff, so the
 * container start finds it locally.
 */
export async function ensurePostgresImage(options: EnsureImageOptions = {}): Promise<void> {
	const attempts = options.attempts ?? 4;
	const registry = options.registry ?? (await runtimeImageRegistry());
	const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
	if (await registry.exists()) return;
	let failure: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await registry.pull();
			if (await registry.exists()) return;
			failure = new Error("the pull finished but the image is not present");
		} catch (error) {
			failure = error;
		}
		if (attempt < attempts) await sleep(1_000 * 2 ** attempt);
	}
	const reason = failure instanceof Error ? failure.message : String(failure);
	throw new Error(`Could not pull ${postgresImage} after ${attempts} attempts: ${reason}`);
}

async function runtimeImageRegistry(): Promise<ImageRegistry> {
	const client = await getContainerRuntimeClient();
	const image = ImageName.fromString(postgresImage);
	return {
		exists: () => client.image.exists(image),
		pull: () => client.image.pull(image),
	};
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
