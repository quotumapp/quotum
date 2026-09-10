import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicBillingTableResetOrder } from "../../integration/helpers/catalog-fixtures";

const allowlisted = {
	projects: "platform-owned tenant root",
	catalog_revisions:
		"deleted after truncate because projects.published_catalog_revision_id references it",
	metering_settings: "deleted and reseeded",
	usage_events_default: "partition of usage_events",
} as const;

describe("public billing table reset coverage", () => {
	it("truncates, cascades, or allowlists every non-platform DDL table", () => {
		const sql = ["002_billing_core.sql", "003_metering_and_pricing.sql"]
			.map((file) => readFileSync(join(process.cwd(), "migrations", file), "utf8"))
			.join("\n");
		const tables = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(/g)].map(
			(match) => match[1] ?? "",
		);
		const references = [...sql.matchAll(/REFERENCES (\w+)/g)].map((match) => ({
			from: enclosingTable(sql, match.index ?? 0),
			to: match[1] ?? "",
		}));
		const truncated = new Set(
			publicBillingTableResetOrder.filter((table) => table !== "catalog_revisions"),
		);
		const covered = new Set<string>([...truncated]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const edge of references) {
				if (covered.has(edge.to) && !covered.has(edge.from) && edge.from !== "") {
					covered.add(edge.from);
					grew = true;
				}
			}
		}
		const remaining = tables.filter(
			(table) =>
				!table.startsWith("platform_") &&
				!covered.has(table) &&
				!(table in allowlisted) &&
				table !== "catalog_revisions",
		);
		expect(remaining).toEqual([]);
		expect(sql).toContain("metering_settings");
		expect(sql).toContain("catalog_revisions");
		expect(sql).toContain("usage_events_default");
		expect(readFileSync(join(process.cwd(), "migrations", "001_platform.sql"), "utf8")).toContain(
			"CREATE TABLE",
		);
		expect(readFileSync(join(process.cwd(), "migrations", "001_platform.sql"), "utf8")).toMatch(
			/CREATE TABLE(?: IF NOT EXISTS)? projects \(/,
		);
		for (const table of publicBillingTableResetOrder) {
			expect(tables).toContain(table);
		}
	});
});

function enclosingTable(sql: string, index: number): string {
	const prefix = sql.slice(0, index);
	const matches = [...prefix.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(/g)];
	return matches.at(-1)?.[1] ?? "";
}
