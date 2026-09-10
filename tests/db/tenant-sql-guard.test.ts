import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowlisted = [
	{
		snippet: "UPDATE purchases pu SET status = CASE WHEN",
		reason: "PK write after a scoped purchase lock in the same transaction",
	},
	{
		snippet: "SELECT id FROM client_idempotency_claims WHERE completed_at IS NOT NULL",
		reason: "maintenance sweep",
	},
	{
		snippet: "SELECT id FROM usage_event_rollups WHERE status = 'open'",
		reason: "maintenance sweep",
	},
	{
		snippet: "SELECT id FROM catalog_drafts WHERE status = 'previewed'",
		reason: "maintenance sweep",
	},
	{
		snippet: "UPDATE balance_allocations SET",
		reason: "PK write after a scoped allocation read in the same transaction",
	},
	{
		snippet: "UPDATE catalog_migration_jobs SET status = 'pending'",
		reason: "PK write after a scoped migration-job read in the same transaction",
	},
	{
		snippet: "UPDATE catalog_migration_jobs SET status = 'waiting_provider'",
		reason: "PK write after a scoped migration-job read in the same transaction",
	},
	{
		snippet: "UPDATE catalog_migration_jobs SET status =",
		reason: "PK write after a scoped migration-job read in the same transaction",
	},
	{
		snippet: "SELECT id FROM customers WHERE id =",
		reason: "PK lock after a scoped customer read in the same transaction",
	},
	{
		snippet: 'SELECT p.id, p.key, p.entitlement_key AS "entitlementKey"',
		reason: "admin catalog list is scoped by the authenticated project in a later predicate",
	},
	{
		snippet: "DELETE FROM client_idempotency_claims WHERE id =",
		reason: "PK delete after a scoped claim read in the same transaction",
	},
	{
		snippet: "SELECT id FROM auto_topup_jobs WHERE (status = 'pending'",
		reason: "global auto-topup queue claim",
	},
	{
		snippet: "SELECT id FROM subscription_changes WHERE (status = 'pending'",
		reason: "global subscription-change queue claim",
	},
	{
		snippet: "SELECT id FROM usage_invoice_periods WHERE status = 'pending'",
		reason: "global recurring-billing queue claim",
	},
	{
		snippet: "FROM store_events se",
		reason: "admin stats query uses projectFilter in the same template",
	},
	{
		snippet: "FROM projection_sync_jobs jobs",
		reason: "admin stats query uses projectFilter in the same template",
	},
	{
		snippet: "COUNT(*) FILTER (WHERE s.status = 'active')",
		reason: "admin stats query uses projectFilter in the same template",
	},
] as const;

describe("tenant SQL guard", () => {
	it("requires project_id on templates that touch tenant tables unless allowlisted", () => {
		const tables = projectIdTables();
		const files = collectTsFiles(join(process.cwd(), "src/db"));
		const unmatchedAllowlist = new Set(allowlisted.map((entry) => entry.snippet));
		const violations: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const template of taggedTemplates(source)) {
				const mentionsTenantTable = tables.some((table) =>
					new RegExp(
						String.raw`\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:ONLY\s+)?${table}\b`,
						"i",
					).test(template),
				);
				if (!mentionsTenantTable || /\bproject_id\b/.test(template)) {
					continue;
				}
				const allow = allowlisted.find((entry) => compact(template).includes(entry.snippet));
				if (allow !== undefined) {
					unmatchedAllowlist.delete(allow.snippet);
					continue;
				}
				violations.push(`${relative(file)}: ${compact(template)}`);
			}
		}
		expect(violations).toEqual([]);
		expect([...unmatchedAllowlist]).toEqual([]);
	});
});

function projectIdTables(): string[] {
	const sql = ["002_billing_core.sql", "003_metering_and_pricing.sql"]
		.map((file) => readFileSync(join(process.cwd(), "migrations", file), "utf8"))
		.join("\n");
	const tables: string[] = [];
	const blocks = sql.split(/CREATE TABLE(?: IF NOT EXISTS)? /).slice(1);
	for (const block of blocks) {
		const name = block.match(/^(\w+)/)?.[1];
		if (name && /\bproject_id\b/.test(block.split(");")[0] ?? "")) {
			tables.push(name);
		}
	}
	return tables;
}

function taggedTemplates(source: string): string[] {
	const templates: string[] = [];
	const covered: Array<[number, number]> = [];
	const pattern = /\b(?:sql|drizzleSql|tx|client)\s*`/g;
	for (const match of source.matchAll(pattern)) {
		const tagStart = match.index ?? 0;
		if (covered.some(([from, to]) => tagStart > from && tagStart < to)) {
			continue;
		}
		const start = tagStart + match[0].length;
		const end = findTemplateEnd(source, start);
		covered.push([tagStart, end + 1]);
		templates.push(source.slice(start, end));
	}
	return templates;
}

function findTemplateEnd(source: string, start: number): number {
	let index = start;
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "`") {
			return index;
		}
		if (char === "$" && source[index + 1] === "{") {
			let depth = 1;
			index += 2;
			while (index < source.length && depth > 0) {
				if (source[index] === "{") depth += 1;
				else if (source[index] === "}") depth -= 1;
				index += 1;
			}
			continue;
		}
		index += 1;
	}
	return source.length;
}

function collectTsFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...collectTsFiles(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function relative(path: string): string {
	return path.replace(`${process.cwd()}/`, "");
}
