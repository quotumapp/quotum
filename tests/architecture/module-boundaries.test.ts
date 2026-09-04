import { describe, expect, it } from "bun:test";
import {
	analyzeMigrationTableOwnership,
	analyzeModuleBoundaries,
	analyzeRepositoryBoundaries,
	type BoundarySourceFile,
	defaultModuleBoundaryRules,
	type ModuleBoundaryRule,
	platformTablePrefix,
	readBoundaryAnalysisOptions,
	readBoundaryMigrationFiles,
	readBoundarySourceFiles,
} from "../../scripts/lib/module-boundaries";

const source = (path: string, contents = "export {};\n"): BoundarySourceFile => ({
	path,
	source: contents,
});

const violationCodes = async (files: readonly BoundarySourceFile[]) =>
	(await analyzeModuleBoundaries(files)).map((violation) => violation.code);

describe("module boundaries", () => {
	it("allows ownership-local, shared, composition, and test-support dependencies", async () => {
		const violations = await analyzeModuleBoundaries([
			source("src/shared/identifier.ts", "export type Identifier = string;"),
			source(
				"src/shared/value.ts",
				'import type { Identifier } from "./identifier"; export type SharedValue = Identifier;',
			),
			source("src/billing/value.ts", "export type BillingValue = string;"),
			source(
				"src/billing/example.ts",
				'import type { BillingValue } from "./value"; import type { Identifier } from "../shared/identifier"; export type Value = BillingValue | Identifier;',
			),
			source("src/platform/value.ts", "export type PlatformValue = string;"),
			source(
				"src/platform/example.ts",
				'import type { PlatformValue } from "./value"; import type { Identifier } from "../shared/identifier"; export type Value = PlatformValue | Identifier;',
			),
			source(
				"src/app.ts",
				'import "./billing/example"; import "./platform/example"; import "./shared/value"; export {};',
			),
			source(
				"src/composition/wire-platform.ts",
				'import "../billing/example"; import "../platform/example"; export {};',
			),
			source(
				"scripts/provision-catalog.ts",
				'import "../src/composition/wire-platform"; export {};',
			),
			source("src/platform-bootstrap.ts", 'import "./composition/wire-platform"; export {};'),
			source("tests/example.test.ts", 'import "../src/app"; export {};'),
		]);

		expect(violations).toEqual([]);
	});

	it("rejects direct billing and platform dependencies in both directions", async () => {
		expect(
			await violationCodes([
				source("src/billing/example.ts", 'import "../platform/example";'),
				source("src/platform/example.ts", 'import "../billing/example";'),
			]),
		).toEqual(["FORBIDDEN_DEPENDENCY", "FORBIDDEN_DEPENDENCY"]);
	});

	it("treats type imports, re-exports, dynamic imports, and require calls as dependencies", async () => {
		const violations = await analyzeModuleBoundaries([
			source("src/platform/contracts.ts", 'import type { Value } from "../billing/value";'),
			source("src/platform/export.ts", 'export type { Value } from "../billing/value";'),
			source("src/platform/dynamic.ts", 'void import("../billing/value");'),
			source(
				"src/platform/dynamic-options.ts",
				'void import("../billing/value", { with: { type: "json" } });',
			),
			source("src/platform/require.ts", 'require("../billing/value");'),
			source("src/billing/value.ts", "export type Value = string;"),
		]);

		expect(violations.map((violation) => violation.code)).toEqual([
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
		]);
	});

	it("rejects production dependencies on composition and test support", async () => {
		expect(
			await violationCodes([
				source("src/billing/composition.ts", 'import "../runtime";'),
				source("src/billing/test-helper.ts", 'import "../testing/test-stripe-entrypoint";'),
				source("src/runtime.ts"),
				source("src/testing/test-stripe-entrypoint.ts"),
			]),
		).toEqual(["FORBIDDEN_DEPENDENCY", "FORBIDDEN_DEPENDENCY"]);
	});

	it("keeps shared code independent from domain modules", async () => {
		expect(
			await violationCodes([
				source("src/shared/example.ts", 'import "../billing/value";'),
				source("src/billing/value.ts"),
			]),
		).toEqual(["FORBIDDEN_DEPENDENCY"]);
	});

	it("rejects unclassified and multiply classified source files", async () => {
		const overlappingRules: readonly ModuleBoundaryRule[] = [
			...defaultModuleBoundaryRules,
			{
				owner: "shared",
				description: "deliberate test overlap",
				matches: (path) => path === "src/billing/example.ts",
			},
		];
		const violations = await analyzeModuleBoundaries(
			[source("src/billing/example.ts"), source("src/unowned/example.ts")],
			{ rules: overlappingRules },
		);

		expect(violations.map((violation) => violation.code)).toEqual([
			"AMBIGUOUS_OWNER",
			"UNCLASSIFIED_FILE",
		]);
	});

	it("rejects unresolved relative imports", async () => {
		expect(await violationCodes([source("src/billing/example.ts", 'import "./missing";')])).toEqual(
			["UNRESOLVED_INTERNAL_IMPORT"],
		);
	});

	it("rejects self-package imports that bypass relative ownership resolution", async () => {
		expect(
			await violationCodes([
				source("src/platform/example.ts", 'import "quotum-api/sdk";'),
				source("src/sdk/index.ts"),
			]),
		).toEqual(["FORBIDDEN_DEPENDENCY"]);
	});

	it("uses compiler resolution for internal aliases, package imports, and absolute paths", async () => {
		const files = [
			source(
				"src/platform/aliases.ts",
				[
					'import type { Value as PathValue } from "@billing/value";',
					'import type { Value as PackageValue } from "#billing/value";',
					'import type { Value as AbsoluteValue } from "/__quotum_module_boundaries__/src/billing/value";',
					'const pathValue = require("@billing/value");',
					'const packageValue = require("#billing/value");',
					"export type Combined = PathValue | PackageValue | AbsoluteValue;",
					"export { pathValue, packageValue };",
				].join("\n"),
			),
			source("src/billing/value.ts", "export type Value = string;"),
		];
		const violations = await analyzeModuleBoundaries(files, {
			compilerOptions: {
				baseUrl: ".",
				paths: { "@billing/*": ["src/billing/*"] },
			},
			packageJson: {
				imports: { "#billing/*": "./src/billing/*.ts" },
				name: "quotum-api",
			},
		});

		expect(violations.map((violation) => violation.code)).toEqual([
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
			"FORBIDDEN_DEPENDENCY",
		]);
	});

	it("rejects unanalyzable production imports except the catalog file loader", async () => {
		expect(
			await violationCodes([
				source("src/platform/example.ts", "void import(moduleName);"),
				source("scripts/billing-catalog.ts", "void import(catalogFileUrl);"),
			]),
		).toEqual(["NON_LITERAL_MODULE_REFERENCE"]);
	});

	it("blocks platform access to billing persistence and SQL clients", async () => {
		const violations = await analyzeModuleBoundaries([
			source("src/platform/repository.ts", 'import "../db/repository";'),
			source("src/platform/drizzle.ts", 'import { sql } from "drizzle-orm";'),
			source("src/platform/bun-sql.ts", 'import { SQL as Database } from "bun";'),
			source("src/platform/global-sql.ts", "const Database = Bun.SQL;"),
			source("src/platform/global-sql-type.ts", "type Database = Bun.SQL;"),
			source("src/platform/global-sql-element.ts", 'const Database = Bun["SQL"];'),
			source("src/platform/global-sql-destructure.ts", "const { SQL: Database } = Bun;"),
			source(
				"src/platform/imported-sql.ts",
				'import * as Runtime from "bun"; type Database = Runtime.SQL;',
			),
			source(
				"src/platform/import-equals-sql.ts",
				'import Runtime = require("bun"); type Database = Runtime.SQL;',
			),
			source(
				"src/platform/default-sql.ts",
				'import Runtime from "bun"; const Database = Runtime.SQL;',
			),
			source("src/platform/export-sql.ts", 'export { SQL as Database } from "bun";'),
			source("src/platform/export-all-bun.ts", 'export * from "bun";'),
			source("src/platform/dynamic-bun.ts", 'void import("bun");'),
			source("src/platform/require-bun.ts", 'require("bun");'),
			source("src/platform/type-import-sql.ts", 'type Database = import("bun").SQL;'),
			source("src/db/repository.ts"),
		]);

		expect(violations.map((violation) => violation.code)).toEqual([
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
		]);
	});

	it("prevents shared code from wrapping persistence APIs for platform", async () => {
		const violations = await analyzeModuleBoundaries([
			source("src/shared/drizzle.ts", 'export { sql } from "drizzle-orm";'),
			source("src/shared/bun-sql.ts", "export type Database = Bun.SQL;"),
		]);

		expect(violations.map((violation) => violation.code)).toEqual([
			"FORBIDDEN_PERSISTENCE_ACCESS",
			"FORBIDDEN_PERSISTENCE_ACCESS",
		]);
	});

	it("keeps application contracts independent from repository types", async () => {
		expect(
			await violationCodes([
				source("src/app/types.ts", 'import type { Record } from "../db/repository";'),
				source("src/db/repository.ts", "export interface Record {}"),
			]),
		).toEqual(["CONTRACT_PERSISTENCE_LEAK"]);
	});

	it("allows static platform queries only against platform-owned tables", async () => {
		const violations = await analyzeModuleBoundaries([
			source(
				"src/platform/persistence/organization-repository.ts",
				[
					"declare const executor: { query<T>(statement: unknown): Promise<T[]> };",
					"void executor.query({",
					'\ttext: "SELECT o.id FROM platform_organizations o JOIN platform_projects p ON p.organization_id = o.id WHERE o.slug = $1",',
					'\tvalues: ["merchant"],',
					"});",
				].join("\n"),
			),
		]);

		expect(violations).toEqual([]);
	});

	it("rejects platform queries against billing tables", async () => {
		const violations = await analyzeModuleBoundaries([
			source(
				"src/platform/persistence/project-repository.ts",
				'declare const executor: any; void executor.query({ text: "SELECT id FROM projects", values: [] });',
			),
		]);

		expect(violations.map((violation) => violation.code)).toEqual(["FORBIDDEN_TABLE_ACCESS"]);
		expect(violations[0]?.message).toContain("platform source owns only platform_* tables");
	});

	it("rejects non-static SQL in platform persistence", async () => {
		const violations = await analyzeModuleBoundaries([
			source(
				"src/platform/persistence/dynamic-concatenation.ts",
				'declare const executor: any; declare const table: string; void executor.query({ text: "SELECT * FROM " + table, values: [] });',
			),
			source(
				"src/platform/persistence/dynamic-template.ts",
				[
					"declare const executor: any; declare const id: string; void executor.query({ text: `SELECT * FROM platform_projects WHERE id = '${",
					"id}'`, values: [] });",
				].join(""),
			),
			source(
				"src/platform/persistence/dynamic-unsafe.ts",
				"declare const executor: any; declare const statement: string; void executor.unsafe(statement);",
			),
			source(
				"src/platform/persistence/dynamic-variable.ts",
				"declare const executor: any; declare const statement: any; void executor.query(statement);",
			),
		]);

		expect(violations.map((violation) => violation.code)).toEqual([
			"NON_STATIC_SQL",
			"NON_STATIC_SQL",
			"NON_STATIC_SQL",
			"NON_STATIC_SQL",
		]);
	});

	it("rejects non-static SQL outside platform persistence", async () => {
		const violations = await analyzeModuleBoundaries([
			source(
				"src/platform/application/unsafe-query.ts",
				[
					"declare const executor: { query<T>(statement: unknown): Promise<T[]> };",
					"declare const statement: { text: string; values: readonly unknown[] };",
					"void executor.query(statement);",
				].join("\n"),
			),
		]);

		expect(violations.map((violation) => violation.code)).toEqual(["NON_STATIC_SQL"]);
		expect(violations[0]?.message).toContain("dynamic platform SQL");
	});

	it("rejects platform table references from billing source", async () => {
		const violations = await analyzeModuleBoundaries([
			source("src/billing/raw-query.ts", 'const query = "SELECT * FROM platform_projects";'),
			source("src/db/platform-schema.ts", 'const table = pgTable("platform_organizations", {});'),
		]);

		expect(violations.map((violation) => violation.code)).toEqual([
			"FORBIDDEN_TABLE_ACCESS",
			"FORBIDDEN_TABLE_ACCESS",
		]);
	});

	it("keeps cross-domain SQL on the named projects composition adapter", async () => {
		const allowed = await analyzeModuleBoundaries([
			source(
				"src/composition/project-instance-persistence.ts",
				'const query = "SELECT s.id FROM subscriptions s JOIN platform_projects p ON true";',
			),
		]);
		const violations = await analyzeModuleBoundaries([
			source(
				"src/composition/other-adapter.ts",
				'const query = "SELECT * FROM platform_projects";',
			),
		]);

		expect(allowed).toEqual([]);
		expect(violations.map((violation) => violation.code)).toEqual(["FORBIDDEN_TABLE_ACCESS"]);
	});

	it("allows the platform migration to own platform tables and the projects seam", () => {
		const violations = analyzeMigrationTableOwnership([
			source(
				"migrations/001_platform.sql",
				[
					"-- SELECT * FROM forbidden_comment_table;",
					"SELECT 'FROM forbidden_string_table' FROM projects;",
					"DELETE FROM projects WHERE key = 'legacy';",
					"CREATE TABLE platform_projects (id UUID PRIMARY KEY);",
					"CREATE TABLE platform_credentials (project_id UUID REFERENCES projects(id));",
					"ALTER TABLE projects ADD COLUMN platform_project_id UUID REFERENCES platform_projects(id);",
					"CREATE INDEX idx_platform_projects_id ON platform_projects (id);",
				].join("\n"),
			),
		]);

		expect(violations).toEqual([]);
	});

	it("rejects billing table access from the platform migration", () => {
		const violations = analyzeMigrationTableOwnership([
			source(
				"migrations/001_platform.sql",
				[
					"UPDATE metering_settings SET raw_usage_retention_days = 1;",
					"DELETE FROM worker_delivery_claims;",
					"ALTER TABLE commercial_action_previews ADD COLUMN unsafe BOOLEAN;",
					"SELECT * FROM subscriptions;",
				].join("\n"),
			),
		]);

		expect(violations.map((violation) => violation.code)).toEqual([
			"FORBIDDEN_TABLE_ACCESS",
			"FORBIDDEN_TABLE_ACCESS",
			"FORBIDDEN_TABLE_ACCESS",
			"FORBIDDEN_TABLE_ACCESS",
		]);
	});

	it("rejects platform tables in every other migration", () => {
		expect(
			analyzeMigrationTableOwnership([
				source(
					"migrations/002_billing_core.sql",
					"INSERT INTO platform_projects (id) VALUES ('00000000-0000-0000-0000-000000000000');",
				),
			]).map((violation) => violation.code),
		).toEqual(["FORBIDDEN_TABLE_ACCESS"]);
	});

	it("allows dynamic SQL only in the path-exact reviewed migrations", () => {
		const violations = analyzeMigrationTableOwnership([
			source(
				"migrations/003_metering_and_pricing.sql",
				"DO $$ BEGIN EXECUTE format('CREATE TABLE %I PARTITION OF usage_events', partition_name); END $$;",
			),
		]);

		expect(violations).toEqual([]);
	});

	it("rejects dynamic SQL ownership bypasses in every other migration", () => {
		const violations = analyzeMigrationTableOwnership([
			source(
				"migrations/002_billing_core.sql",
				"DO $$ BEGIN EXECUTE format('DROP TABLE platform_projects'); END $$;",
			),
		]);

		expect(violations.map((violation) => violation.code)).toEqual(["NON_STATIC_SQL"]);
		expect(violations[0]?.message).toContain("path-exact reviewed migrations");
	});

	it("reserves the platform table prefix", () => {
		expect(platformTablePrefix).toBe("platform_");
	});

	it("passes against the repository source and migration graph", async () => {
		const [sourceFiles, migrationFiles, options] = await Promise.all([
			readBoundarySourceFiles(process.cwd()),
			readBoundaryMigrationFiles(process.cwd()),
			readBoundaryAnalysisOptions(process.cwd()),
		]);
		expect(await analyzeRepositoryBoundaries(sourceFiles, migrationFiles, options)).toEqual([]);
	});
});
