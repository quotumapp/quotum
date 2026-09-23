import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { artifactJson } from "../../scripts/openapi";
import { ProviderCapabilityMatrixSchema } from "../../src/app/contracts/provider-responses";
import {
	type ProviderCapabilityContract,
	providerCapabilityBlockEnd,
	providerCapabilityBlockStart,
	providerCapabilityContract,
	renderProviderCapabilityBlock,
	replaceProviderCapabilityBlock,
} from "../../src/composition/provider-capabilities";
import { providerCapabilityDeclarations } from "../../src/providers/capabilities";
import {
	capabilityStatusLabels,
	declaredProviders,
	providerOperationDomains,
	providerOperations,
	supportLevels,
} from "../../src/shared/provider-capabilities";

const root = resolve(import.meta.dir, "../..");
const committedContract = readFileSync(
	resolve(root, "contracts/v1/provider-capabilities.json"),
	"utf8",
);
const providersGuide = readFileSync(resolve(root, "docs/providers.md"), "utf8");

/** Cells of a Markdown table row, split on unescaped pipes. */
function cells(row: string): string[] {
	return row.split(/(?<!\\)\|/).slice(1, -1);
}

function tableRows(block: string): string[] {
	return block.split("\n").filter((line) => line.startsWith("|"));
}

describe("provider capability contract", () => {
	it("is committed as the canonical artifact and parses as the named component", () => {
		const contract = providerCapabilityContract();
		expect(committedContract).toBe(artifactJson(contract));
		const parsed = JSON.parse(committedContract);
		expect(ProviderCapabilityMatrixSchema.parse(parsed)).toEqual(parsed);
	});

	it("carries the vocabulary and every declaration in contract order", () => {
		const contract = providerCapabilityContract();
		expect(contract.schemaVersion).toBe(1);
		expect(contract.domains.map((domain) => domain.id)).toEqual([...providerOperationDomains]);
		expect(contract.operations.map((operation) => operation.id)).toEqual([...providerOperations]);
		expect(contract.labels.map((label) => label.id)).toEqual(
			capabilityStatusLabels.map((label) => label.id),
		);
		expect(contract.supportLevels.map((level) => level.id)).toEqual([...supportLevels]);
		expect(contract.providers.map((declaration) => declaration.provider)).toEqual([
			...declaredProviders,
		]);
		expect(contract.providers).toEqual([...providerCapabilityDeclarations]);
	});

	it("is deterministic and never shares declaration objects", () => {
		const first = providerCapabilityContract();
		expect(artifactJson(providerCapabilityContract())).toBe(artifactJson(first));
		expect(committedContract).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
		first.providers[0]?.operations["checkout.hosted"].conditions.push({ kind: "catalog_bound" });
		expect(providerCapabilityContract()).not.toEqual(first);
	});
});

describe("renderProviderCapabilityBlock", () => {
	it("renders one table row per operation and one column per declared provider", () => {
		const contract = providerCapabilityContract();
		const rows = tableRows(renderProviderCapabilityBlock(contract));
		const width = contract.providers.length + 1;
		for (const row of rows) expect(cells(row)).toHaveLength(width);

		const header = cells(rows[0] ?? "").map((cell) => cell.trim());
		expect(header).toEqual(["Operation", "Apple", "Google", "Stripe", "Paddle (planned)"]);
		for (const operation of providerOperations) {
			expect(rows.filter((row) => row.includes(`\`${operation}\``))).toHaveLength(1);
		}
		for (const domain of contract.domains) {
			expect(rows).toContain(`| **${domain.title}** |${" |".repeat(contract.providers.length)}`);
		}
		expect(rows).toHaveLength(2 + contract.domains.length + providerOperations.length);
	});

	it("renders statuses, conditions, evidence and the legend", () => {
		const block = renderProviderCapabilityBlock(providerCapabilityContract());
		const row = (operation: string) =>
			cells(tableRows(block).find((line) => line.includes(`\`${operation}\``)) ?? "");

		const [, apple, , stripe, paddle] = row("topup.automatic");
		expect(apple?.trim()).toBe("Unsupported");
		expect(stripe).toContain(
			"Conditional · Quotum-composed via Stripe invoices with a top-up price line<br>The customer must have a saved payment method",
		);
		expect(stripe).toContain("[workers/auto-topup](../tests/workers/auto-topup.test.ts)");
		expect(paddle).toContain(
			"Requires policy decision (DEC-14) · Quotum-composed via one-time subscription charge",
		);
		expect(paddle).toContain('The connection setting "spmConsent" must be true.');
		expect(paddle).toContain("Questions: Q-SET-02");
		expect(row("subscription.cancel")[1]?.trim()).toBe("Managed by provider, mirrored by Quotum");
		expect(row("catalog.trial")[1]).toContain(
			"Managed by provider, mirrored by Quotum<br>Tests: [providers/apple/normalizer](../tests/providers/apple/normalizer.test.ts)",
		);
		const [, applePreview, googlePreview, stripePreview] = row("subscription.change.preview");
		expect([applePreview?.trim(), googlePreview?.trim()]).toEqual(["Unsupported", "Unsupported"]);
		expect(stripePreview).toContain("active, grace_period, billing_retry or cancelled.");

		for (const label of capabilityStatusLabels) {
			expect(block).toContain(`- **${label.label}**: `);
		}
		expect(block).toContain("Support kinds: Native; Quotum-composed; ");
		expect(block).toContain("are not commitments");
		expect(block).not.toMatch(/\b(GET|POST|PUT|PATCH|DELETE) \//);
	});

	it("links only to existing repository files", () => {
		const block = renderProviderCapabilityBlock(providerCapabilityContract());
		const links = [...block.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) {
			expect(link).toStartWith("../tests/");
			expect(existsSync(resolve(root, "docs", link))).toBe(true);
		}
	});

	it("is a pure function of the committed artifact", () => {
		const fromArtifact = ProviderCapabilityMatrixSchema.parse(
			JSON.parse(committedContract),
		) as ProviderCapabilityContract;
		const block = renderProviderCapabilityBlock(providerCapabilityContract());
		expect(renderProviderCapabilityBlock(fromArtifact)).toBe(block);
		expect(renderProviderCapabilityBlock(providerCapabilityContract())).toBe(block);
	});

	it("escapes Markdown in text and rejects evidence outside the repository", () => {
		const contract = providerCapabilityContract();
		const [first] = contract.operations;
		if (first === undefined) throw new Error("No operations");
		first.title = "Plans | *bundles* _x_ <b>";
		const row = tableRows(renderProviderCapabilityBlock(contract)).find((line) =>
			line.includes(`\`${first.id}\``),
		);
		expect(cells(row ?? "")).toHaveLength(contract.providers.length + 1);
		expect(row).toContain("Plans \\| \\*bundles\\* \\_x\\_ &lt;b&gt;<br>");

		const stripe = contract.providers.find((declaration) => declaration.provider === "stripe");
		const verification = stripe?.operations["checkout.hosted"].verification;
		if (verification?.status !== "verified") throw new Error("Stripe checkout is not verified");
		verification.evidence.tests = ["../outside.test.ts"];
		expect(() => renderProviderCapabilityBlock(contract)).toThrow(
			"Capability evidence test must be a repository-relative path",
		);
	});
});

describe("replaceProviderCapabilityBlock", () => {
	const markdown = `# Guide\n\n${providerCapabilityBlockStart}\nold\n${providerCapabilityBlockEnd}\n\n## Next\n`;

	it("replaces only the marked content and is idempotent", () => {
		const once = replaceProviderCapabilityBlock(markdown, "new\ncontent");
		expect(once).toBe(
			`# Guide\n\n${providerCapabilityBlockStart}\nnew\ncontent\n${providerCapabilityBlockEnd}\n\n## Next\n`,
		);
		expect(replaceProviderCapabilityBlock(once, "new\ncontent")).toBe(once);
	});

	it("rejects missing, duplicated and reversed markers", () => {
		expect(() => replaceProviderCapabilityBlock("# Guide\n", "block")).toThrow(
			"Provider capability markers are missing",
		);
		expect(() =>
			replaceProviderCapabilityBlock(`${providerCapabilityBlockStart}\n`, "block"),
		).toThrow("Provider capability markers are missing");
		expect(() => replaceProviderCapabilityBlock(`${markdown}${markdown}`, "block")).toThrow(
			"Provider capability markers must appear exactly once",
		);
		expect(() =>
			replaceProviderCapabilityBlock(
				`${providerCapabilityBlockEnd}\n${providerCapabilityBlockStart}\n`,
				"block",
			),
		).toThrow("end marker precedes its start marker");
	});

	it("finds the current block in the providers guide", () => {
		const block = renderProviderCapabilityBlock(providerCapabilityContract());
		expect(replaceProviderCapabilityBlock(providersGuide, block)).toBe(providersGuide);
		expect(providersGuide.indexOf("## Provider capabilities")).toBeLessThan(
			providersGuide.indexOf(providerCapabilityBlockStart),
		);
		expect(providersGuide.indexOf(providerCapabilityBlockEnd)).toBeLessThan(
			providersGuide.indexOf("## Apple StoreKit"),
		);
	});
});
