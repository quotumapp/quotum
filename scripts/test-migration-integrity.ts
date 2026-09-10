import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";

const postgresUri = requiredPostgresUri(process.env.POSTGRES_URI);
const schema = "migration_integrity_test";
const admin = new SQL(postgresUri, { max: 1, prepare: false });

try {
	await admin.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
	await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
	await verifyChecksumDrift(admin);
	await verifyMissingFile(admin);
	await verifyStatusExitCodes(admin);
	await verifyMidFileFailureRollback(admin);
	await verifyConcurrentIndexBranch(admin);
	await verifyAdvisoryLockExclusion(admin);
} finally {
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	await admin.close();
}

async function verifyChecksumDrift(adminSql: SQL): Promise<void> {
	await withScratchSchema(adminSql, async (testUri, testSql) => {
		await testSql.unsafe(`
			CREATE TABLE migrations (
				id TEXT PRIMARY KEY,
				checksum TEXT NOT NULL,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`);
		await testSql`
			INSERT INTO migrations (id, checksum)
			VALUES ('001_platform', 'not-the-canonical-checksum')
		`;

		const child = await spawnMigrate(testUri);
		if (child.exitCode === 0) {
			throw new Error(`Migration checksum drift was accepted\n${child.stdout}\n${child.stderr}`);
		}
		if (!child.stderr.includes("001_platform.sql - CHECKSUM MISMATCH")) {
			throw new Error(`Checksum failure was not reported\n${child.stdout}\n${child.stderr}`);
		}

		console.log("Strict migration integrity verified");
	});
}

async function verifyMissingFile(adminSql: SQL): Promise<void> {
	await withScratchSchema(adminSql, async (testUri, testSql) => {
		await testSql.unsafe(`
			CREATE TABLE migrations (
				id TEXT PRIMARY KEY,
				checksum TEXT NOT NULL,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`);
		await testSql`
			INSERT INTO migrations (id, checksum)
			VALUES ('999_missing', 'x')
		`;

		const child = await spawnMigrate(testUri);
		if (child.exitCode === 0) {
			throw new Error(`Missing migration file was accepted\n${child.stdout}\n${child.stderr}`);
		}
		if (!child.stderr.includes("999_missing.sql - FILE NOT FOUND")) {
			throw new Error(`Missing file was not reported\n${child.stdout}\n${child.stderr}`);
		}

		console.log("Missing migration file verified");
	});
}

async function verifyStatusExitCodes(adminSql: SQL): Promise<void> {
	await withScratchSchema(adminSql, async (testUri, testSql) => {
		const statusOk = await spawnMigrate(testUri, ["status"]);
		if (statusOk.exitCode !== 0) {
			throw new Error(`status failed on an empty schema\n${statusOk.stdout}\n${statusOk.stderr}`);
		}

		await testSql`
			INSERT INTO migrations (id, checksum)
			VALUES ('001_platform', 'not-the-canonical-checksum')
		`;
		const statusMismatch = await spawnMigrate(testUri, ["status"]);
		if (statusMismatch.exitCode === 0) {
			throw new Error("status accepted a checksum mismatch");
		}
		if (!statusMismatch.stderr.includes("001_platform.sql - CHECKSUM MISMATCH")) {
			throw new Error(
				`status did not report checksum mismatch\n${statusMismatch.stdout}\n${statusMismatch.stderr}`,
			);
		}

		await testSql`DELETE FROM migrations`;
		await testSql`
			INSERT INTO migrations (id, checksum)
			VALUES ('999_missing', 'x')
		`;
		const statusMissing = await spawnMigrate(testUri, ["status"]);
		if (statusMissing.exitCode === 0) {
			throw new Error("status accepted a missing file");
		}
		if (!statusMissing.stderr.includes("999_missing.sql - FILE NOT FOUND")) {
			throw new Error(
				`status did not report missing file\n${statusMissing.stdout}\n${statusMissing.stderr}`,
			);
		}

		console.log("Migration status exit codes verified");
	});
}

async function verifyMidFileFailureRollback(adminSql: SQL): Promise<void> {
	await withScratchSchema(adminSql, async (testUri, testSql) => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-migrate-"));
		try {
			const failing = [
				"CREATE TABLE migration_integrity_rollback_probe (id int);",
				"SELECT 1 / 0;",
				"",
			].join("\n");
			await writeFile(join(directory, "001_fail.sql"), failing);

			const failed = await spawnMigrate(testUri, [], { BILLING_MIGRATIONS_DIR: directory });
			if (failed.exitCode === 0) {
				throw new Error(`Failing migration was accepted\n${failed.stdout}\n${failed.stderr}`);
			}

			const leftover = await testSql<{ exists: boolean }[]>`
				SELECT to_regclass('migration_integrity_rollback_probe') IS NOT NULL AS exists
			`;
			if (leftover[0]?.exists === true) {
				throw new Error("Failed transactional migration left a table behind");
			}
			const applied = await testSql<{ id: string }[]>`SELECT id FROM migrations`;
			if (applied.length !== 0) {
				throw new Error("Failed transactional migration recorded an applied row");
			}

			const succeeding = "CREATE TABLE migration_integrity_rollback_probe (id int);\n";
			await writeFile(join(directory, "001_fail.sql"), succeeding);
			const rerun = await spawnMigrate(testUri, [], { BILLING_MIGRATIONS_DIR: directory });
			if (rerun.exitCode !== 0) {
				throw new Error(`Rerun after rollback failed\n${rerun.stdout}\n${rerun.stderr}`);
			}
			const created = await testSql<{ exists: boolean }[]>`
				SELECT to_regclass('migration_integrity_rollback_probe') IS NOT NULL AS exists
			`;
			if (created[0]?.exists !== true) {
				throw new Error("Rerun after rollback did not apply the repaired migration");
			}

			console.log("Transactional migration rollback and rerun verified");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

async function verifyConcurrentIndexBranch(adminSql: SQL): Promise<void> {
	await withScratchSchema(adminSql, async (testUri, testSql) => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-migrate-"));
		try {
			await writeFile(
				join(directory, "001_table.sql"),
				"CREATE TABLE migration_integrity_concurrent_probe (id int);\n",
			);
			await writeFile(
				join(directory, "002_index.sql"),
				[
					"-- migrate: no-transaction",
					"CREATE INDEX CONCURRENTLY migration_integrity_concurrent_probe_idx",
					"ON migration_integrity_concurrent_probe (id);",
					"",
				].join("\n"),
			);

			const child = await spawnMigrate(testUri, [], { BILLING_MIGRATIONS_DIR: directory });
			if (child.exitCode !== 0) {
				throw new Error(
					`CREATE INDEX CONCURRENTLY migration failed\n${child.stdout}\n${child.stderr}`,
				);
			}

			const index = await testSql<{ exists: boolean }[]>`
				SELECT to_regclass('migration_integrity_concurrent_probe_idx') IS NOT NULL AS exists
			`;
			if (index[0]?.exists !== true) {
				throw new Error("CREATE INDEX CONCURRENTLY did not create the index");
			}

			console.log("Non-transactional CREATE INDEX CONCURRENTLY verified");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

async function verifyAdvisoryLockExclusion(adminSql: SQL): Promise<void> {
	await withScratchSchema(adminSql, async (testUri) => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-migrate-"));
		try {
			const content = "CREATE TABLE migration_integrity_lock_probe (id int);\n";
			await writeFile(join(directory, "001_lock.sql"), content);

			await adminSql`SELECT pg_advisory_lock(760911, 520384001)`;
			const child = spawnMigrateProcess(testUri, [], { BILLING_MIGRATIONS_DIR: directory });
			try {
				const waiting = await waitForWaitingAdvisoryLock(adminSql, 5_000);
				if (!waiting) {
					child.kill();
					const result = await readSpawn(child);
					throw new Error(
						`Second migrate did not wait on the advisory lock\n${result.stdout}\n${result.stderr}`,
					);
				}
			} finally {
				await adminSql`SELECT pg_advisory_unlock(760911, 520384001)`;
			}

			const result = await readSpawn(child);
			if (result.exitCode !== 0) {
				throw new Error(
					`Migrate failed after the advisory lock was released\n${result.stdout}\n${result.stderr}`,
				);
			}
			if (!result.stdout.includes("Applied migration 001_lock.sql")) {
				throw new Error(
					`Migrate did not apply after lock release\n${result.stdout}\n${result.stderr}`,
				);
			}

			console.log("Advisory-lock exclusion verified");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

async function withScratchSchema(
	adminSql: SQL,
	run: (testUri: string, testSql: SQL) => Promise<void>,
): Promise<void> {
	await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
	const testUri = schemaUri(schema);
	const testSql = new SQL(testUri, { max: 1, prepare: false });
	try {
		await run(testUri, testSql);
	} finally {
		await testSql.close();
		await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	}
}

async function spawnMigrate(
	postgresUriForChild: string,
	args: string[] = [],
	extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return readSpawn(spawnMigrateProcess(postgresUriForChild, args, extraEnv));
}

interface PipedSpawn {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(): void;
}

function spawnMigrateProcess(
	postgresUriForChild: string,
	args: string[] = [],
	extraEnv: Record<string, string> = {},
): PipedSpawn {
	return Bun.spawn(["bun", "run", "src/migrate.ts", ...args], {
		cwd: process.cwd(),
		env: {
			...process.env,
			POSTGRES_URI: postgresUriForChild,
			BILLING_ENV: "test",
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function readSpawn(
	child: PipedSpawn,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function waitForWaitingAdvisoryLock(sql: SQL, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = await sql<{ waiting: number }[]>`
			SELECT count(*)::int AS waiting
			FROM pg_locks
			WHERE locktype = 'advisory'
				AND classid = 760911
				AND objid = 520384001
				AND NOT granted
		`;
		if ((rows[0]?.waiting ?? 0) > 0) {
			return true;
		}
		await Bun.sleep(25);
	}
	return false;
}

function schemaUri(schemaName: string): string {
	const testUri = new URL(postgresUri);
	testUri.searchParams.set("options", `-csearch_path=${schemaName},public`);
	return testUri.toString();
}

function requiredPostgresUri(value: string | undefined): string {
	if (value === undefined || value.trim() === "") throw new Error("POSTGRES_URI is required");
	return value;
}
