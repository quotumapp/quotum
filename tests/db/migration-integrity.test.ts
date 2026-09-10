import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import { sha256Hex } from "../../src/billing/decimal";
import {
	calculateMigrationChecksum,
	findMigrationIntegrityProblems,
	shouldRunMigrationInTransaction,
	verifyAppliedMigrations,
} from "../../src/db/migration-integrity";

const repositoryRoot = resolve(import.meta.dir, "../..");
const migrationsDir = join(repositoryRoot, "migrations");

describe("calculateMigrationChecksum", () => {
	it("hashes empty, abc, and untrimmed content", () => {
		expect(calculateMigrationChecksum("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(calculateMigrationChecksum("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(calculateMigrationChecksum("a\n")).not.toBe(calculateMigrationChecksum("a"));
	});

	it("matches sha256Hex on the platform baseline", () => {
		const content = readFileSync(join(migrationsDir, "001_platform.sql"), "utf8");
		expect(calculateMigrationChecksum(content)).toBe(sha256Hex(content));
	});
});

describe("findMigrationIntegrityProblems", () => {
	it("lists checksum mismatches and missing files in applied order", async () => {
		const platform = readFileSync(join(migrationsDir, "001_platform.sql"), "utf8");
		const core = readFileSync(join(migrationsDir, "002_billing_core.sql"), "utf8");
		const applied = new Map([
			["001_platform", calculateMigrationChecksum(platform)],
			["002_billing_core", "wrong"],
			["003_missing", "x"],
		]);
		const readMigration = async (filename: string): Promise<string | null> => {
			if (filename === "001_platform.sql") return platform;
			if (filename === "002_billing_core.sql") return core;
			return null;
		};

		expect(await findMigrationIntegrityProblems(applied, readMigration)).toEqual([
			"002_billing_core.sql - CHECKSUM MISMATCH",
			"003_missing.sql - FILE NOT FOUND",
		]);
	});

	it("never calls the source for an empty applied map", async () => {
		let calls = 0;
		await findMigrationIntegrityProblems(new Map(), async () => {
			calls += 1;
			return null;
		});
		expect(calls).toBe(0);
	});
});

describe("verifyAppliedMigrations", () => {
	it("reports every problem then rejects", async () => {
		const reported: string[] = [];
		const applied = new Map([
			["002_billing_core", "wrong"],
			["003_missing", "x"],
		]);
		await expect(
			verifyAppliedMigrations(
				applied,
				async (filename) => {
					if (filename === "002_billing_core.sql") return "content";
					return null;
				},
				(line) => {
					reported.push(line);
				},
			),
		).rejects.toThrow("Migration integrity check failed");
		expect(reported).toEqual([
			"002_billing_core.sql - CHECKSUM MISMATCH",
			"003_missing.sql - FILE NOT FOUND",
		]);
	});

	it("resolves without reporting when every checksum matches", async () => {
		let reported = 0;
		await verifyAppliedMigrations(
			new Map([["001_ok", calculateMigrationChecksum("ok")]]),
			async () => "ok",
			() => {
				reported += 1;
			},
		);
		expect(reported).toBe(0);
	});
});

describe("shouldRunMigrationInTransaction", () => {
	it("treats CONCURRENTLY and the no-transaction marker as non-transactional", () => {
		expect(shouldRunMigrationInTransaction("CREATE INDEX CONCURRENTLY idx ON t (c);")).toBe(false);
		expect(shouldRunMigrationInTransaction("create   index\n\tconcurrently idx on t (c);")).toBe(
			false,
		);
		expect(shouldRunMigrationInTransaction("-- migrate: no-transaction")).toBe(false);
		expect(shouldRunMigrationInTransaction("--migrate:no-transaction")).toBe(false);
		expect(shouldRunMigrationInTransaction("  -- migrate: no-transaction")).toBe(false);
		expect(shouldRunMigrationInTransaction("SELECT 1;\n-- migrate: no-transaction")).toBe(false);
	});

	it("keeps comments that mention concurrently transactional", () => {
		expect(
			shouldRunMigrationInTransaction("-- runs concurrently with writes\nCREATE TABLE t (c int);"),
		).toBe(true);
		expect(shouldRunMigrationInTransaction("CREATE INDEX idx ON t (c);")).toBe(true);
		expect(shouldRunMigrationInTransaction("")).toBe(true);
		expect(shouldRunMigrationInTransaction("SELECT 1; -- migrate: no-transaction")).toBe(true);
	});

	it("treats every current baseline as transactional", () => {
		const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql"));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			expect(shouldRunMigrationInTransaction(readFileSync(join(migrationsDir, file), "utf8"))).toBe(
				true,
			);
		}
	});
});

describe("BILLING_MIGRATIONS_DIR", () => {
	it("exits 1 when the override is set outside BILLING_ENV=test", async () => {
		const processHandle = Bun.spawn([process.execPath, "run", "src/migrate.ts"], {
			cwd: repositoryRoot,
			env: {
				...createSanitizedProcessEnv(),
				POSTGRES_URI: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
				BILLING_MIGRATIONS_DIR: join(repositoryRoot, "migrations"),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(processHandle.stdout).text(),
			new Response(processHandle.stderr).text(),
			processHandle.exited,
		]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("BILLING_MIGRATIONS_DIR is only honoured when BILLING_ENV=test");
		expect(stdout).toBe("");
	});
});
