import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";
import {
	calculateMigrationChecksum,
	type MigrationSource,
	shouldRunMigrationInTransaction,
	verifyAppliedMigrations,
} from "./db/migration-integrity";

const postgresUri = process.env.POSTGRES_URI;
if (postgresUri === undefined || postgresUri.trim() === "") {
	console.error("POSTGRES_URI environment variable is required");
	process.exit(1);
}

const migrationsDir = resolveMigrationsDir();
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

interface MigrationRow {
	id: string;
	checksum: string;
}

const readMigration: MigrationSource = async (filename) => {
	const file = Bun.file(join(migrationsDir, filename));
	return (await file.exists()) ? await file.text() : null;
};

function resolveMigrationsDir(): string {
	const override = process.env.BILLING_MIGRATIONS_DIR?.trim();
	if (override === undefined || override === "") {
		return join(import.meta.dir, "../migrations");
	}
	if (process.env.BILLING_ENV !== "test") {
		console.error("BILLING_MIGRATIONS_DIR is only honoured when BILLING_ENV=test");
		process.exit(1);
	}
	return override;
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
	const files = await readdir(migrationsDir);
	return files.filter((file) => file.endsWith(".sql")).sort();
}

async function runMigration(filename: string): Promise<void> {
	const migrationId = filename.replace(/\.sql$/, "");
	const content = await Bun.file(join(migrationsDir, filename)).text();
	const checksum = calculateMigrationChecksum(content);

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
		await verifyAppliedMigrations(applied, readMigration);

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
	await verifyAppliedMigrations(applied, readMigration);

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
