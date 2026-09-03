import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";

const postgresUri = process.env.POSTGRES_URI;
if (postgresUri === undefined || postgresUri.trim() === "") {
	console.error("POSTGRES_URI environment variable is required");
	process.exit(1);
}

const sql = new SQL(postgresUri, {
	max: 1,
	idleTimeout: 60,
	maxLifetime: 0,
	prepare: false,
	connection: {
		statement_timeout: 0,
		idle_in_transaction_session_timeout: 30_000,
	},
});
const migrationAdvisoryLockNamespace = 760_911;
const migrationAdvisoryLockKey = 520_384_001;
const concurrentIndexPattern = /CREATE\s+INDEX\s+CONCURRENTLY/i;

interface MigrationRow {
	id: string;
	checksum: string;
}

async function calculateHash(content: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

async function ensureMigrationsTable(): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS migrations (
			id TEXT PRIMARY KEY,
			checksum TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;
}

async function getAppliedMigrations(): Promise<Map<string, string>> {
	const rows = await sql<MigrationRow[]>`SELECT id, checksum FROM migrations ORDER BY id`;
	return new Map(rows.map((row) => [row.id, row.checksum]));
}

async function getMigrationFiles(): Promise<string[]> {
	const migrationsDir = join(import.meta.dir, "../migrations");
	const files = await readdir(migrationsDir);
	return files.filter((file) => file.endsWith(".sql")).sort();
}

async function verifyAppliedMigrations(applied: Map<string, string>): Promise<void> {
	const migrationsDir = join(import.meta.dir, "../migrations");
	const errors: string[] = [];

	for (const [id, storedChecksum] of applied) {
		const filename = `${id}.sql`;
		const file = Bun.file(join(migrationsDir, filename));
		if (!(await file.exists())) {
			errors.push(`${filename} - FILE NOT FOUND`);
			continue;
		}

		const currentChecksum = await calculateHash(await file.text());
		if (storedChecksum !== currentChecksum) {
			errors.push(`${filename} - CHECKSUM MISMATCH`);
		}
	}

	if (errors.length > 0) {
		for (const error of errors) {
			console.error(error);
		}
		throw new Error("Migration integrity check failed");
	}
}

async function runMigration(filename: string): Promise<void> {
	const migrationsDir = join(import.meta.dir, "../migrations");
	const migrationId = filename.replace(/\.sql$/, "");
	const content = await Bun.file(join(migrationsDir, filename)).text();
	const checksum = await calculateHash(content);

	console.log(`Running migration ${filename}`);
	if (shouldRunMigrationInTransaction(content)) {
		await sql.begin(async (tx) => {
			await tx.unsafe(content);
			await tx`INSERT INTO migrations (id, checksum) VALUES (${migrationId}, ${checksum})`;
		});
	} else {
		await sql.unsafe(content);
		await sql`INSERT INTO migrations (id, checksum) VALUES (${migrationId}, ${checksum})`;
	}
	console.log(`Applied migration ${filename}`);
}

async function migrate(): Promise<void> {
	await withMigrationAdvisoryLock(async () => {
		await ensureMigrationsTable();
		const applied = await getAppliedMigrations();
		await verifyAppliedMigrations(applied);

		const pending = (await getMigrationFiles()).filter(
			(file) => !applied.has(file.replace(/\.sql$/, "")),
		);
		if (pending.length === 0) {
			console.log("No pending migrations");
			return;
		}

		for (const file of pending) {
			await runMigration(file);
		}
	});
}

function shouldRunMigrationInTransaction(content: string): boolean {
	return (
		!concurrentIndexPattern.test(content) && !/^\s*--\s*migrate:\s*no-transaction/im.test(content)
	);
}

async function withMigrationAdvisoryLock(callback: () => Promise<void>): Promise<void> {
	await sql`SELECT pg_advisory_lock(${migrationAdvisoryLockNamespace}, ${migrationAdvisoryLockKey})`;
	try {
		await callback();
	} finally {
		await sql`SELECT pg_advisory_unlock(${migrationAdvisoryLockNamespace}, ${migrationAdvisoryLockKey})`;
	}
}

async function status(): Promise<void> {
	await ensureMigrationsTable();
	const applied = await getAppliedMigrations();
	await verifyAppliedMigrations(applied);

	for (const file of await getMigrationFiles()) {
		const id = file.replace(/\.sql$/, "");
		console.log(`${applied.has(id) ? "applied" : "pending"} ${file}`);
	}
}

try {
	if (process.argv[2] === "status") {
		await status();
	} else {
		await migrate();
	}
} finally {
	await sql.close();
}
