import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { admittedProviders, providerCapabilityDeclaration } from "../../src/providers/capabilities";
import { createProviderRegistry } from "../../src/providers/registry";
import {
	type BillingProvider,
	evaluateCapability,
	type ProviderOperation,
} from "../../src/shared/provider-capabilities";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const providerTables = [
	"store_products",
	"provider_customers",
	"subscriptions",
	"purchases",
	"store_events",
	"checkout_requests",
	"credit_grant_provider_objects",
	"catalog_provider_operations",
	"provider_plan_bindings",
	"provider_topup_bindings",
	"provider_price_bindings",
	"subscription_changes",
	"usage_invoice_periods",
	"auto_topup_policies",
	"auto_topup_jobs",
	"promotion_provider_objects",
	"promotion_redemptions",
];

/** Tables whose Drizzle definition mirrors the provider CHECK as `<table>_provider_check`. */
const drizzleMirroredTables = [
	"checkout_requests",
	"credit_grant_provider_objects",
	"provider_customers",
	"purchases",
	"store_events",
	"store_products",
	"subscriptions",
];

const shapeCheck = "promotion_provider_objects_shape_check";

/** How a Drizzle `check()` body interpolates the provider column. */
const drizzleProviderColumn = `\${table.provider}`;

const checkoutOperations: ProviderOperation[] = ["checkout.hosted", "checkout.plan"];

const registry = createProviderRegistry({
	getRepository: () => {
		throw new Error("The CHECK manifest test never builds provider services");
	},
});
const admitted: string[] = [...registry.admitted()].sort();

const migrations = readdirSync(join(process.cwd(), "migrations"))
	.filter((file) => file.endsWith(".sql"))
	.sort()
	.map((file) => ({ file, sql: read(`migrations/${file}`).replace(/--[^\n]*/g, "") }));

const providerColumn = /^\s*provider\s+text\b/i;

const tables = new Map<string, string>();
for (const { sql } of migrations) {
	for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\);/gi)) {
		tables.set(match[1] as string, match[2] as string);
	}
}

const providerChecks = new Map<string, string[]>();
const providerColumnProblems: string[] = [];
let providerColumnCount = 0;
for (const [table, body] of tables) {
	for (const line of body.split("\n")) {
		if (!providerColumn.test(line)) continue;
		providerColumnCount += 1;
		const values = checkValues(line, /CHECK \(provider (IN \([^)]*\)|= '[^']*')\)/);
		if ([...line.matchAll(/\bCHECK\s*\(/gi)].length !== 1 || values === null) {
			providerColumnProblems.push(`${table}: ${line.trim()}`);
			continue;
		}
		providerChecks.set(table, values);
	}
}

describe("provider CHECK constraints", () => {
	it("pins the tables that store a provider", () => {
		expect([...providerChecks.keys()].sort()).toEqual([...providerTables].sort());
	});

	it("gives every provider column exactly one provider CHECK, declared in its CREATE TABLE", () => {
		expect(providerColumnProblems).toEqual([]);
		const declared = migrations.flatMap(({ sql }) => [...sql.matchAll(/\bprovider\s+text\b/gi)]);
		expect(declared).toHaveLength(providerColumnCount);
	});

	it("restricts providers nowhere else than the column CHECKs and the promotion shape check", () => {
		const restrictions: string[] = [];
		for (const { file, sql } of migrations) {
			for (const match of sql.matchAll(/\bCHECK\s*\(/gi)) {
				const start = sql.lastIndexOf("\n", match.index) + 1;
				if (providerColumn.test(sql.slice(start, sql.indexOf("\n", match.index)))) continue;
				const body = balancedParentheses(sql, match.index + match[0].length - 1);
				if (!/\bprovider\b/i.test(body)) continue;
				const name = sql.slice(start, match.index).match(/CONSTRAINT (\w+)\s*$/i)?.[1];
				if (name === shapeCheck) continue;
				restrictions.push(`${file}: ${name ?? "unnamed"} CHECK ${body.replace(/\s+/g, " ")}`);
			}
		}
		expect(restrictions).toEqual([]);
	});

	it("matches the providers the registry admits", () => {
		expect(admitted).toEqual([...admittedProviders()].sort());
		const expected = new Map(providerTables.map((table) => [table, admitted]));
		expected.set("checkout_requests", checkoutProviders());
		expected.set("promotion_redemptions", [...admitted, "quotum"].sort());
		expect(Object.fromEntries(providerChecks)).toEqual(Object.fromEntries(expected));
	});

	it("limits checkout requests to providers that implement checkout", () => {
		expect(providerChecks.get("checkout_requests")).toEqual(checkoutProviders());
		const drizzleType = read("src/db/schema.ts").match(
			/checkoutRequests = pgTable\([\s\S]*?provider: text\("provider"\)\.\$type<([^>]*)>\(\)/,
		);
		expect(drizzleType).not.toBeNull();
		expect(literals(drizzleType?.[1] ?? "", /"([a-z_]+)"/g)).toEqual(checkoutProviders());
	});

	it("keeps promotion provider object shapes within the admitted providers", () => {
		const providers = sqlShapeProviders();
		expect(providers.length).toBeGreaterThan(0);
		for (const provider of providers) expect(admitted).toContain(provider);
	});

	it("mirrors the SQL provider CHECK sets in Drizzle", () => {
		const drizzleChecks = new Map(
			[...read("src/db/schema.ts").matchAll(/check\(\s*"(\w+)",\s*sql`([^`]*)`/g)].map((match) => [
				match[1] as string,
				match[2] as string,
			]),
		);
		const providerCheckNames = [...drizzleChecks]
			.filter(([, body]) => body.includes(drizzleProviderColumn))
			.map(([name]) => name)
			.sort();
		expect(providerCheckNames).toEqual(
			[...drizzleMirroredTables.map((table) => `${table}_provider_check`), shapeCheck].sort(),
		);
		for (const table of drizzleMirroredTables) {
			const body = (drizzleChecks.get(`${table}_provider_check`) ?? "").replace(
				drizzleProviderColumn,
				"provider",
			);
			const values = checkValues(body, /^provider (IN \([^)]*\)|= '[^']*')$/);
			expect({ table, values }).toEqual({ table, values: providerChecks.get(table) ?? null });
		}
		const drizzleShape = drizzleChecks.get(shapeCheck) ?? "";
		expect(literals(drizzleShape, /\$\{table\.provider\} = '([a-z_]+)'/g)).toEqual(
			sqlShapeProviders(),
		);
	});
});

function checkoutProviders(): string[] {
	const implementsCheckout = (provider: BillingProvider) =>
		checkoutOperations.some((operation) => {
			const declaration = providerCapabilityDeclaration(provider);
			const verdict = evaluateCapability(declaration, operation, {}, { through: "implementation" });
			return verdict.outcome !== "blocked";
		});
	return registry.admitted().filter(implementsCheckout).sort();
}

function sqlShapeProviders(): string[] {
	const body = tables.get("promotion_provider_objects") ?? "";
	const start = body.indexOf(`CONSTRAINT ${shapeCheck} CHECK (`);
	if (start === -1) throw new Error(`Constraint ${shapeCheck} was not found`);
	return literals(balancedParentheses(body, body.indexOf("(", start)), /\bprovider = '([a-z_]+)'/g);
}

function checkValues(text: string, pattern: RegExp): string[] | null {
	const clause = text.match(pattern)?.[1];
	return clause === undefined ? null : literals(clause, /'([^']*)'/g);
}

function literals(text: string, pattern: RegExp): string[] {
	return [...new Set([...text.matchAll(pattern)].map((match) => match[1] as string))].sort();
}

/** The text from the opening parenthesis at `open` through its matching closing one. */
function balancedParentheses(text: string, open: number): string {
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		if (text[index] === "(") depth += 1;
		if (text[index] === ")") depth -= 1;
		if (depth === 0) return text.slice(open, index + 1);
	}
	throw new Error(`Parenthesis at ${open} is not closed`);
}
