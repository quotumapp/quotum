import { SQL } from "bun";

const postgresUri = requiredPostgresUri(process.env.POSTGRES_URI);
const schema = "migration_integrity_test";
const admin = new SQL(postgresUri, { max: 1, prepare: false });

try {
	await admin.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
	await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
	await verifyChecksumDrift(admin);
} finally {
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	await admin.close();
}

// The runner must refuse a database whose applied baseline no longer matches the checked-out file.
async function verifyChecksumDrift(adminSql: SQL): Promise<void> {
	await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
	const testUri = schemaUri(schema);
	const testSql = new SQL(testUri, { max: 1, prepare: false });
	try {
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

		const child = Bun.spawn(["bun", "run", "src/migrate.ts"], {
			cwd: process.cwd(),
			env: { ...process.env, POSTGRES_URI: testUri },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		if (exitCode === 0) {
			throw new Error(`Migration checksum drift was accepted\n${stdout}\n${stderr}`);
		}
		if (!stderr.includes("001_platform.sql - CHECKSUM MISMATCH")) {
			throw new Error(`Checksum failure was not reported\n${stdout}\n${stderr}`);
		}

		console.log("Strict migration integrity verified");
	} finally {
		await testSql.close();
	}
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
