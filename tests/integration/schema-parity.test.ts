import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/db/schema";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

type Key = {
	type: string;
	columns: string[];
	target?: string;
	target_columns?: string[];
	on_delete?: string;
};
type Column = { name: string; type: string; not_null: boolean; has_default: boolean };
type Index = { name: string; unique: boolean; columns: string[]; predicate: string | null };
type Table = {
	name: string;
	columns: Column[];
	constraints: Key[];
	indexes: Index[];
	checks: string[];
};
type CatalogColumn = Column & { table_name: string };
type CatalogKey = Key & { table_name: string; name: string };
type CatalogIndex = Index & { table_name: string };

const localDescribe = describeLocalPostgres(describe, describe.skip);
const deleteActions: Record<string, string> = {
	"no action": "a",
	restrict: "r",
	cascade: "c",
	"set null": "n",
	"set default": "d",
};
function sorted<T>(values: T[]): T[] {
	return values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
// Postgres adds casts/parentheses and Drizzle qualifies identifiers. Normalize only
// these rendering differences; preserve expression tokens, column order and DESC.
function normalizeExpression(value: string): string {
	const tokens =
		value.replace(/"[a-z_]+"\./g, "").match(/'(?:''|[^'])*'|"[^"]*"|::(?:text|bigint)|\s+|./g) ??
		[];
	const expression = tokens.flatMap((token) => {
		if (token.startsWith("'")) return [token];
		if (token.startsWith("::") || /^\s+$/.test(token)) return [];
		return [token.replaceAll('"', "").toLowerCase()];
	});
	// pg_get_indexdef encloses operator expressions; Drizzle may leave them bare.
	while (expression[0] === "(" && expression.at(-1) === ")") {
		let depth = 0;
		let wrapsAll = true;
		for (const [position, token] of expression.entries()) {
			if (token === "(") depth++;
			if (token === ")") depth--;
			if (depth === 0 && position < expression.length - 1) {
				wrapsAll = false;
				break;
			}
		}
		if (!wrapsAll) break;
		expression.shift();
		expression.pop();
	}
	return expression.join("");
}
function normalizeType(value: string): string {
	return value
		.replace(/timestamp with time zone/g, "timestamptz")
		.replace(/timestamp without time zone/g, "timestamp")
		.replaceAll(" ", "");
}
function normalize(tables: Table[]): Table[] {
	return sorted(
		tables.map((table) => ({
			name: table.name,
			columns: sorted(
				table.columns.map((column) => ({ ...column, type: normalizeType(column.type) })),
			),
			constraints: sorted(table.constraints),
			indexes: sorted(
				table.indexes.map((index) => ({
					...index,
					columns: index.columns.map(normalizeExpression),
				})),
			),
			checks: table.checks.sort(),
		})),
	);
}
function mirrorSchema(): Table[] {
	return normalize(
		Object.values(schema)
			.filter((value) => is(value, PgTable))
			.map(getTableConfig)
			.map((config) => ({
				name: config.name,
				columns: config.columns.map((column) => ({
					name: column.name,
					type: column.getSQLType(),
					not_null: column.notNull,
					has_default: column.hasDefault,
				})),
				constraints: [
					...config.columns
						.filter((column) => column.primary)
						.map((column) => ({ type: "p", columns: [column.name] })),
					...config.primaryKeys.map((key) => ({
						type: "p",
						columns: key.columns.map((column) => column.name),
					})),
					...config.columns
						.filter((column) => column.isUnique)
						.map((column) => ({ type: "u", columns: [column.name] })),
					...config.uniqueConstraints.map((key) => ({
						type: "u",
						columns: key.columns.map((column) => column.name),
					})),
					...config.foreignKeys.map((key) => ({
						type: "f",
						columns: key.reference().columns.map((column) => column.name),
						target: getTableConfig(key.reference().foreignTable).name,
						target_columns: key.reference().foreignColumns.map((column) => column.name),
						on_delete: deleteActions[key.onDelete ?? "no action"],
					})),
					// This cross-owner relationship belongs to migration 001. Billing must not declare
					// platform tables; assert its full shape here at the test's composition boundary.
					...(config.name === "projects"
						? [
								{
									type: "f",
									columns: ["platform_project_id"],
									target: "platform_projects",
									target_columns: ["id"],
									on_delete: "r",
								},
							]
						: []),
				],
				indexes: config.indexes.map((index) => ({
					name: index.config.name ?? "",
					unique: index.config.unique,
					predicate: index.config.where
						? new PgDialect()
								.sqlToQuery(index.config.where.inlineParams())
								.sql.replaceAll(`"${config.name}".`, "")
						: null,
					columns: index.config.columns.map((column) => {
						if (is(column, SQL)) return new PgDialect().sqlToQuery(column).sql;
						if (!("name" in column) || column.name === undefined)
							throw new Error(`Unsupported expression index: ${index.config.name}`);
						return `${column.name}${column.indexConfig?.order === "desc" ? " DESC" : ""}`;
					}),
				})),
				// No CHECK exceptions remain. Keep this exact comparison; an allowlist may only shrink.
				checks: config.checks.map((check) => check.name),
			})),
	);
}
async function migratedSchema(context: LocalPostgresContext): Promise<Table[]> {
	// Inspect root tables only: partition tables and inherited FK copies are generated
	// implementation details. Identity columns have defaults even without pg_attrdef.
	const tables = await context.sql<Array<{ name: string }>>`
		SELECT c.relname AS name
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
			AND NOT c.relispartition AND c.relname !~ '^platform_'
	`;
	const columns = await context.sql<CatalogColumn[]>`
		SELECT c.relname AS table_name, a.attname AS name,
			format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
			(a.atthasdef OR a.attidentity <> '') AS has_default
		FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
			AND NOT c.relispartition AND c.relname !~ '^platform_'
			AND a.attnum > 0 AND NOT a.attisdropped
	`;
	const constraints = await context.sql<CatalogKey[]>`
		SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
			con.confdeltype AS on_delete,
			ARRAY(
				SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
				JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num
				ORDER BY k.ord
			) AS columns, target.relname AS target,
			ARRAY(
				SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
				JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num
				ORDER BY k.ord
			) AS target_columns
		FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_class target ON target.oid = con.confrelid
		WHERE n.nspname = 'public' AND NOT c.relispartition
			AND con.conparentid = 0 AND c.relname !~ '^platform_'
	`;
	const indexes = await context.sql<CatalogIndex[]>`
		SELECT c.relname AS table_name, ic.relname AS name, i.indisunique AS unique,
			pg_get_expr(i.indpred, i.indrelid) AS predicate,
			ARRAY(
				SELECT pg_get_indexdef(i.indexrelid, k, true) ||
					CASE WHEN (i.indoption[k-1] & 1) = 1 THEN ' DESC' ELSE '' END
				FROM generate_series(1, i.indnkeyatts) k
			) AS columns
		FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
		JOIN pg_class ic ON ic.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND NOT c.relispartition AND c.relname !~ '^platform_'
			AND NOT EXISTS (
				SELECT 1 FROM pg_constraint con
				WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u')
			)
	`;

	return normalize(
		tables
			.filter((table) => table.name !== "migrations")
			.map((table) => ({
				name: table.name,
				columns: columns
					.filter((column) => column.table_name === table.name)
					.map(({ name, type, not_null, has_default }) => ({ name, type, not_null, has_default })),
				constraints: constraints
					.filter((key) => key.table_name === table.name && ["p", "u", "f"].includes(key.type))
					.map((key) =>
						key.type === "f"
							? {
									type: key.type,
									columns: key.columns,
									target: key.target,
									target_columns: key.target_columns,
									on_delete: key.on_delete,
								}
							: { type: key.type, columns: key.columns },
					),
				indexes: indexes
					.filter((index) => index.table_name === table.name)
					.map(({ name, unique, columns, predicate }) => ({ name, unique, predicate, columns })),
				checks: constraints
					.filter((key) => key.table_name === table.name && key.type === "c")
					.map((key) => key.name),
			})),
	);
}
// Ask Postgres to canonicalize predicates instead of approximating SQL equivalence:
// it rewrites IN lists, adds casts, and preserves operator precedence. LIKE copies
// column types/collations only; temporary indexes never touch billing data.
async function canonicalizePredicates(
	context: LocalPostgresContext,
	mirror: Table[],
): Promise<void> {
	const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
	await context.sql.begin(async (transaction) => {
		for (const table of mirror) {
			const partial = table.indexes.filter((index) => index.predicate !== null);
			if (partial.length === 0) continue;
			const column = table.columns[0];
			if (!column) throw new Error(`Missing columns for ${table.name}`);
			await transaction.unsafe(
				`CREATE TEMP TABLE schema_parity_predicate (LIKE public.${quote(table.name)}) ON COMMIT DROP`,
			);
			for (const index of partial) {
				await transaction.unsafe(
					`CREATE INDEX schema_parity_index ON schema_parity_predicate (${quote(column.name)}) WHERE ${index.predicate}`,
				);
				const [row] = await transaction<Array<{ predicate: string }>>`
     SELECT pg_get_expr(indpred, indrelid) AS predicate FROM pg_index
     WHERE indexrelid = 'pg_temp.schema_parity_index'::regclass
    `;
				if (!row) throw new Error(`Missing predicate for ${index.name}`);
				index.predicate = row.predicate;
				await transaction`DROP INDEX pg_temp.schema_parity_index`;
			}
			await transaction`DROP TABLE pg_temp.schema_parity_predicate`;
		}
	});
}
localDescribe("Billing schema parity", () => {
	let context: LocalPostgresContext;
	let migrated: Table[];
	let mirror: Table[];
	beforeAll(async () => {
		context = await createLocalPostgresContext();
		migrated = await migratedSchema(context);
		mirror = mirrorSchema();
		await canonicalizePredicates(context, mirror);
	});
	afterAll(async () => {
		await context.sql.close();
	});
	it("matches columns, keys, indexes and checks for every migrated billing table", () => {
		expect(mirror).toEqual(migrated);
	});
	it("detects a removed index", () => {
		const changed = structuredClone(mirror);
		const projects = changed.find((table) => table.name === "projects");
		if (!projects) throw new Error("Missing projects table");
		projects.indexes = projects.indexes.filter(
			(index) => index.name !== "idx_billing_projects_key",
		);
		expect(changed).not.toEqual(migrated);
	});
	it("detects a removed index predicate", () => {
		const changed = structuredClone(mirror);
		const index = changed
			.flatMap((table) => table.indexes)
			.find((index) => index.predicate !== null);
		if (!index) throw new Error("Missing partial index");
		index.predicate = null;
		expect(changed).not.toEqual(migrated);
	});
	it("detects a removed foreign-key delete action", () => {
		const changed = structuredClone(mirror);
		const customers = changed.find((table) => table.name === "customers");
		const key = customers?.constraints.find((key) => key.type === "f" && key.target === "projects");
		if (!key) throw new Error("Missing customer project foreign key");
		key.on_delete = "a";
		expect(changed).not.toEqual(migrated);
	});
});
