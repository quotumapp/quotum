import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkNewCatalogIntent } from "../../../src/catalog/control-plane";
import {
	catalogFileLanguage,
	formatCatalogSource,
	runCatalogCommand,
	runCatalogFormat,
} from "../../../src/composition/cli/catalog";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

function captured() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		output: {
			stdout: (value: string) => out.push(value),
			stderr: (value: string) => err.push(value),
		},
	};
}

/** A directory outside the package, so a written module loads without `quotum-api` beside it. */
async function scratch(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "quotum-catalog-format-"));
	temporaryDirectories.push(directory);
	return directory;
}

const stripeBinding = (productKey: string) => ({ productKey, provider: "stripe", channel: "web" });

/** A catalog in the legacy spelling, with one item of each kind the canonical spelling renames. */
const legacyCatalog = {
	features: [
		{
			key: "ai_credits",
			name: "AI credits",
			kind: "metered",
			meterKind: "consumable",
			unit: "credit",
			creditScale: 0,
			filterDimensions: [],
		},
		{
			key: "exports",
			name: "Exports",
			kind: "metered",
			meterKind: "consumable",
			unit: "export",
			creditScale: 0,
			filterDimensions: [],
		},
	],
	plans: [
		{
			key: "pro",
			name: "Pro",
			version: 1,
			trialDays: null,
			currency: "USD",
			baseAmountMinor: 2000,
			billingInterval: "month",
			// The legacy fields and the base price agree, and the plan-level binding is the base
			// price's, as legacy catalogs spelled a Stripe-priced plan.
			basePrice: {
				key: "pro_monthly",
				currency: "USD",
				unitAmountMinor: 2000,
				billingUnits: "1",
				billingInterval: "month",
				minimumQuantity: 1,
				maximumQuantity: 1,
				taxBehavior: "exclusive",
				providerBindings: [stripeBinding("pro_monthly")],
			},
			providerBindings: [stripeBinding("pro_monthly")],
			items: [
				{
					featureKey: "ai_credits",
					itemKind: "allocation",
					quantity: "1000",
					resetInterval: "month",
					expiresAfterSeconds: 86400,
					overagePolicy: "blocked",
				},
				{
					featureKey: "exports",
					itemKind: "meter_limit",
					quantity: "100",
					resetInterval: "day",
					expiresAfterSeconds: null,
					overagePolicy: "blocked",
				},
			],
		},
		{
			key: "unlimited_exports",
			name: "Unlimited exports",
			version: 1,
			kind: "addon",
			basePrice: {
				key: "unlimited",
				currency: "USD",
				unitAmountMinor: 500,
				billingUnits: "1",
				billingInterval: "month",
				minimumQuantity: 1,
				maximumQuantity: 1,
				taxBehavior: "exclusive",
				providerBindings: [stripeBinding("unlimited_exports")],
			},
			providerPriced: null,
			items: [{ itemKind: "unlimited_usage", featureKey: "exports" }],
		},
	],
	topups: [
		{
			key: "credits_10",
			featureKey: "ai_credits",
			quantity: "10",
			expiresAfterSeconds: null,
			providerBindings: [stripeBinding("credits_10")],
		},
		{
			key: "credits_1000",
			featureKey: "ai_credits",
			quantity: "1000",
			expiry: { mode: "after", interval: "year", intervalCount: 1 },
			providerBindings: [stripeBinding("credits_1000")],
		},
	],
	rateCards: [],
};

describe("quotum catalog format", () => {
	it("prints a legacy TypeScript catalog in the canonical spelling and keeps an explicit null revision", async () => {
		const directory = await scratch();
		const file = join(directory, "billing.catalog.ts");
		await writeFile(
			file,
			`export const expectedRevision = null;\nexport const catalog = ${JSON.stringify(legacyCatalog)};\n`,
			"utf8",
		);
		const first = captured();
		expect(await runCatalogCommand(["format", file], {}, first.output)).toBe(0);
		expect(first.err).toEqual([]);
		const text = first.out.join("\n");
		expect(text).toContain("export const expectedRevision: number | null = null;");
		const module = text.slice(
			text.indexOf("{", text.indexOf("export const catalog")),
			text.lastIndexOf("}") + 1,
		);
		const canonical = JSON.parse(module);
		const [pro, addon] = canonical.plans;
		expect(pro).toMatchObject({
			basePrice: {
				currency: "USD",
				unitAmountMinor: 2000,
				billingInterval: "month",
				billingIntervalCount: 1,
			},
			providerPriced: null,
		});
		expect(pro).not.toHaveProperty("baseAmountMinor");
		expect(pro.items).toEqual([
			{
				itemKind: "allocation",
				featureKey: "ai_credits",
				quantity: "1000",
				reset: { interval: "month", intervalCount: 1 },
				expiry: { mode: "after_seconds", seconds: 86400 },
				allocationScope: "account",
				rollover: null,
			},
			{
				itemKind: "meter_limit",
				featureKey: "exports",
				quantity: "100",
				reset: { interval: "day", intervalCount: 1 },
				overage: { policy: "blocked" },
				allocationScope: "account",
			},
		]);
		expect(addon.items).toEqual([{ itemKind: "unlimited_usage", featureKey: "exports" }]);
		expect(canonical.topups.map((topup: { expiry: unknown }) => topup.expiry)).toEqual([
			{ mode: "forever" },
			{ mode: "after", interval: "year", intervalCount: 1 },
		]);

		// Formatting the output again changes nothing, and the module loads where the package is not
		// installed: its type import is erased. Bun caches a directory's listing on first import, so
		// the formatted file goes in a directory nothing has been imported from yet.
		const formatted = join(await scratch(), "formatted.catalog.ts");
		await writeFile(formatted, `${text}\n`, "utf8");
		const again = captured();
		const againCode = await runCatalogFormat([formatted], again.output);
		expect(again.err).toEqual([]);
		expect(againCode).toBe(0);
		expect(again.out.join("\n")).toBe(text);
	});

	it("rewrites the file with --write and leaves a revision the file never declared undeclared", async () => {
		const directory = await scratch();
		const file = join(directory, "catalog.mjs");
		await writeFile(file, `export default ${JSON.stringify(legacyCatalog)};\n`, "utf8");
		const write = captured();
		expect(await runCatalogFormat([file, "--write"], write.output)).toBe(0);
		expect(write.out).toEqual([`Wrote ${file} in the canonical spelling.`]);
		const rewritten = await readFile(file, "utf8");
		expect(rewritten).not.toContain("expectedRevision");
		expect(rewritten).not.toContain("import");
		expect(rewritten).toContain("export const catalog = {");
		const print = captured();
		expect(await runCatalogFormat(["--write", file], print.output)).toBe(0);
		expect(await readFile(file, "utf8")).toBe(rewritten);
	});

	it("keeps the shipped plan examples as they are, in the canonical intent preview computes", async () => {
		const file = join(repositoryRoot, "examples", "quickstart", "catalog-plans.json");
		const result = captured();
		expect(await runCatalogFormat([file], result.output)).toBe(0);
		expect(result.err).toEqual([]);
		const example = JSON.parse(await readFile(file, "utf8"));
		expect(JSON.parse(result.out.join("\n"))).toEqual(checkNewCatalogIntent(example).canonical);
	});

	it("prints Stripe prices left to Stripe as advice, not as an error", () => {
		const advised = formatCatalogSource(
			{
				catalog: {
					...legacyCatalog,
					plans: [
						{
							...legacyCatalog.plans[1],
							kind: "base",
							basePrice: null,
							providerPriced: {
								billingInterval: "month",
								providerBindings: [stripeBinding("dashboard_priced")],
							},
							items: [],
						},
					],
				},
			},
			"json",
		);
		expect(advised.advisories).toEqual([
			{
				path: "plans[0].providerPriced.providerBindings[0]",
				message: "Use `basePrice` when Quotum should model the price.",
			},
		]);
	});

	it("refuses wrong arguments with 64 and an invalid catalog with 1, on one line", async () => {
		const directory = await scratch();
		const valid = join(directory, "catalog.json");
		await writeFile(valid, JSON.stringify(legacyCatalog), "utf8");
		const cases: Array<[string[], number, string]> = [
			[[], 64, "format requires one catalog file. Run `quotum catalog --help` for usage."],
			[
				[valid, valid],
				64,
				"format requires one catalog file. Run `quotum catalog --help` for usage.",
			],
			[[valid, "--check"], 64, "Unknown option --check. Run `quotum catalog --help` for usage."],
			[
				[join(directory, "catalog.yaml")],
				64,
				"format reads a .ts, .js or .json catalog file. Run `quotum catalog --help` for usage.",
			],
		];
		for (const [args, code, message] of cases) {
			const result = captured();
			expect(await runCatalogFormat(args, result.output)).toBe(code);
			expect(result.err).toEqual([message]);
			expect(result.out).toEqual([]);
		}

		const unknownField = join(directory, "unknown.json");
		await writeFile(
			unknownField,
			JSON.stringify({
				...legacyCatalog,
				plans: [{ ...legacyCatalog.plans[0], items: [{ itemKind: "allocation" }] }],
			}),
			"utf8",
		);
		const schema = captured();
		expect(await runCatalogFormat([unknownField], schema.output)).toBe(1);
		expect(schema.err).toHaveLength(1);
		expect(schema.err[0]).toStartWith("Catalog is invalid at plans[0].items[0]");

		const conflicting = join(directory, "conflicting.json");
		await writeFile(
			conflicting,
			JSON.stringify({
				...legacyCatalog,
				plans: [
					{
						...legacyCatalog.plans[1],
						providerPriced: {
							billingInterval: "year",
							providerBindings: [stripeBinding("yearly")],
						},
					},
				],
			}),
			"utf8",
		);
		const rule = captured();
		expect(await runCatalogFormat([conflicting], rule.output)).toBe(1);
		expect(rule.err).toHaveLength(1);
		expect(rule.err[0]).toContain("unlimited_exports");

		const missing = captured();
		expect(await runCatalogFormat([join(directory, "missing.json")], missing.output)).toBe(1);
		expect(missing.err).toHaveLength(1);
	});

	it("reads the language from the file extension", () => {
		expect(catalogFileLanguage("a/catalog.JSON")).toBe("json");
		expect(catalogFileLanguage("catalog.mts")).toBe("ts");
		expect(catalogFileLanguage("catalog.cjs")).toBe("js");
	});
});
