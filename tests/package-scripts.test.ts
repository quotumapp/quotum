import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("package scripts", () => {
	it("keeps Postgres integration tests on an explicit command", () => {
		const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const runner = readFileSync(join(process.cwd(), "scripts/test-integration.ts"), "utf8");
		const e2eRunner = readFileSync(join(process.cwd(), "scripts/test-e2e.ts"), "utf8");
		const postgresLib = readFileSync(
			join(process.cwd(), "scripts/lib/postgres-container.ts"),
			"utf8",
		);

		expect(packageJson.scripts?.test).toBe("bun test tests");
		expect(packageJson.scripts?.migrate).toBe("bun run src/migrate.ts");
		expect(packageJson.scripts?.["migrate:status"]).toBe("bun run src/migrate.ts status");
		expect(packageJson.scripts?.["test:e2e"]).toBe("bun run scripts/test-e2e.ts");
		expect(packageJson.scripts?.["test:integration"]).toBe("bun run scripts/test-integration.ts");
		expect(packageJson.scripts?.["check:boundaries"]).toBe(
			"bun run scripts/check-module-boundaries.ts",
		);
		expect(packageJson.scripts?.quality).toContain("bun run check:boundaries");
		expect(postgresLib).toContain("postgres:18-alpine");
		expect(postgresLib).toContain("@testcontainers/postgresql");
		expect(postgresLib).toContain("PostgreSqlContainer");
		expect(postgresLib).not.toContain('"docker"');
		expect(postgresLib).not.toContain("docker inspect");
		expect(postgresLib).not.toContain("docker rm");
		expect(postgresLib).not.toContain("SELECT 1");
		expect(postgresLib).not.toContain("pg_isready");
		expect(runner).toContain("POSTGRES_URI");
		expect(runner).toContain("getConnectionUri");
		expect(runner).toContain("container.stop");
		expect(runner).toContain('"scripts/test-migration-integrity.ts"');
		expect(runner).toContain('"bun", ["run", "migrate"]');
		expect(runner).toContain('testTargets.length === 0 ? ["tests/integration"] : testTargets');
		expect(e2eRunner).toContain("createSanitizedProcessEnv");
		expect(e2eRunner).toContain("getConnectionUri");
		expect(e2eRunner).toContain("container.stop");
		expect(e2eRunner).toContain("RUN_BILLING_E2E_TESTS");
		expect(e2eRunner).toContain('"--timeout=20000"');
		expect(e2eRunner).toContain(
			'"bun", ["test", "--timeout=20000", ...junitReporterArgs(reportPath), "tests/e2e"]',
		);
		expect(e2eRunner).toContain('"scripts/test-migration-integrity.ts"');
		expect(runner).toContain("BILLING_TEST_LANE");
		expect(e2eRunner).toContain("BILLING_TEST_LANE");
		expect(runner).not.toContain("POSTGRES_URI is required for integration tests");
		expect(postgresLib).not.toContain("supabase");
	});

	it("keeps migration and runtime entrypoints production-safe", () => {
		const migrate = readFileSync(join(process.cwd(), "src/migrate.ts"), "utf8");
		const integrity = readFileSync(join(process.cwd(), "src/db/migration-integrity.ts"), "utf8");
		const index = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");

		expect(migrate).toContain("pg_advisory_lock");
		expect(migrate).toContain("pg_advisory_unlock");
		expect(migrate).toContain("verifyAppliedMigrations(");
		expect(migrate).toContain("shouldRunMigrationInTransaction(");
		expect(migrate).toContain('from "./db/migration-integrity"');
		expect(migrate).toContain('BILLING_ENV !== "test"');
		expect(integrity).toContain("storedChecksum !== currentChecksum");
		expect(integrity).toContain("CREATE\\s+INDEX\\s+CONCURRENTLY");
		expect(migrate).not.toContain("isAcceptedMigrationChecksum");
		expect(integrity).not.toContain("isAcceptedMigrationChecksum");
		expect(index).not.toContain("await import(");
	});

	it("keeps the billing image free of an operator UI", () => {
		const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
		expect(dockerfile).not.toContain("console/");
		expect(dockerfile).not.toContain("quotum-ui");
		expect(dockerfile).toContain("COPY --from=prerelease --chown=bun /usr/src/app/src ./src");
	});
});
