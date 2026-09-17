import type { z } from "zod";
import type { ProviderCapabilityMatrixSchema } from "../app/contracts/provider-responses";
import { providerCapabilityDeclarations } from "../providers/capabilities";
import {
	assertValidDeclaration,
	type CapabilityEvidence,
	type CapabilityStatusLabel,
	capabilityStatusLabels,
	describeCondition,
	type OperationSupport,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	type ProviderOperationDefinition,
	type ProviderOperationDomain,
	providerOperationDefinitions,
	providerOperationDomains,
	providerOperationDomainTitles,
	providerOperations,
	renderCapabilityStatus,
	type SupportLevel,
	supportLevelLabels,
	supportLevels,
} from "../shared/provider-capabilities";

export const providerCapabilityBlockStart = "<!-- provider-capabilities:start -->";
export const providerCapabilityBlockEnd = "<!-- provider-capabilities:end -->";

/** The committed `contracts/v1/provider-capabilities.json` artifact. */
export interface ProviderCapabilityContract {
	schemaVersion: 1;
	domains: Array<{ id: ProviderOperationDomain; title: string }>;
	operations: Array<{ id: ProviderOperation } & ProviderOperationDefinition>;
	labels: CapabilityStatusLabel[];
	supportLevels: Array<{ id: SupportLevel; label: string }>;
	/** Every declaration, planned providers included, in catalog order. */
	providers: ProviderCapabilityDeclaration[];
}

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
/** Fails typechecking when the named wire component drifts from the artifact type. */
export type ProviderCapabilityMatrixMirror = Expect<
	MutuallyAssignable<z.infer<typeof ProviderCapabilityMatrixSchema>, ProviderCapabilityContract>
>;

/** Deterministic: no timestamps, vocabulary in contract order, declarations validated first. */
export function providerCapabilityContract(): ProviderCapabilityContract {
	for (const declaration of providerCapabilityDeclarations) assertValidDeclaration(declaration);
	return {
		schemaVersion: 1,
		domains: providerOperationDomains.map((id) => ({
			id,
			title: providerOperationDomainTitles[id],
		})),
		operations: providerOperations.map((id) => {
			const { domain, title, description } = providerOperationDefinitions[id];
			return { id, domain, title, description };
		}),
		labels: capabilityStatusLabels.map(({ id, label, rule }) => ({ id, label, rule })),
		supportLevels: supportLevels.map((id) => ({ id, label: supportLevelLabels[id] })),
		providers: providerCapabilityDeclarations.map((declaration) => structuredClone(declaration)),
	};
}

/**
 * The Markdown between the provider capability markers in `docs/providers.md`: one row per
 * operation grouped by domain, one column per declared provider, then the legend. Links stay inside
 * the repository and the block carries no HTTP examples.
 */
export function renderProviderCapabilityBlock(contract: ProviderCapabilityContract): string {
	const providers = contract.providers;
	const lines = [
		"<!-- Generated from contracts/v1/provider-capabilities.json by bun run openapi:generate; do not edit. -->",
		"",
		tableRow(["Operation", ...providers.map(providerHeading)]),
		tableRow(["---", ...providers.map(() => "---")]),
	];
	for (const domain of contract.domains) {
		const operations = contract.operations.filter((operation) => operation.domain === domain.id);
		if (operations.length === 0) continue;
		lines.push(tableRow([`**${escapeMarkdown(domain.title)}**`, ...providers.map(() => "")]));
		for (const operation of operations) {
			lines.push(
				tableRow([
					`${escapeMarkdown(operation.title)}<br>\`${operation.id}\``,
					...providers.map((declaration) =>
						supportCell(contract, declaration.operations[operation.id]),
					),
				]),
			);
		}
	}
	const kinds = contract.supportLevels.map((level) => escapeMarkdown(level.label)).join("; ");
	lines.push(
		"",
		"Statuses:",
		"",
		...contract.labels.map(
			(entry) => `- **${escapeMarkdown(entry.label)}**: ${escapeMarkdown(entry.rule)}`,
		),
		"",
		`Support kinds: ${kinds}. A Quotum-composed cell names the provider primitive Quotum builds the operation on.`,
		"",
		"Tests link to the repository tests that exercise the declared behavior. Scenario ids name conformance scenarios; question ids and decision ids name provider assessment questions and decision register entries in the Quotum documentation repository.",
		"",
		"Planned providers and planned statuses come from a dated provider assessment in the Quotum documentation repository and are not commitments. Provider-layer sources are cited in that assessment and are not linked from this guide.",
	);
	return lines.join("\n");
}

/** Replaces the content between the provider capability markers; the markers must appear once. */
export function replaceProviderCapabilityBlock(markdown: string, block: string): string {
	const start = markdown.indexOf(providerCapabilityBlockStart);
	const end = markdown.indexOf(providerCapabilityBlockEnd);
	if (start === -1 || end === -1) {
		throw new Error("Provider capability markers are missing from the providers guide");
	}
	if (
		markdown.indexOf(providerCapabilityBlockStart, start + 1) !== -1 ||
		markdown.indexOf(providerCapabilityBlockEnd, end + 1) !== -1
	) {
		throw new Error("Provider capability markers must appear exactly once in the providers guide");
	}
	if (end < start) {
		throw new Error("Provider capability end marker precedes its start marker");
	}
	return `${markdown.slice(0, start)}${providerCapabilityBlockStart}\n${block}\n${markdown.slice(end)}`;
}

function providerHeading(declaration: ProviderCapabilityDeclaration): string {
	const name = `${declaration.provider.charAt(0).toUpperCase()}${declaration.provider.slice(1)}`;
	return declaration.availability === "available" ? name : `${name} (${declaration.availability})`;
}

function supportCell(contract: ProviderCapabilityContract, support: OperationSupport): string {
	const status = renderCapabilityStatus(support);
	const kind =
		contract.supportLevels.find((level) => level.id === support.level)?.label ?? support.level;
	// A status named after the support level already says it; a longer kind label replaces it.
	const headline =
		kind === status || kind.startsWith(status)
			? kind
			: `${status} · ${support.composedVia === undefined ? kind : `${kind} via ${support.composedVia}`}`;
	return [
		escapeMarkdown(headline),
		...support.conditions.map((condition) => escapeMarkdown(describeCondition(condition))),
		...evidenceLines(support.verification.evidence),
	].join("<br>");
}

function evidenceLines(evidence: CapabilityEvidence | undefined): string[] {
	if (evidence === undefined) return [];
	const lines: string[] = [];
	if (evidence.tests.length > 0) lines.push(`Tests: ${evidence.tests.map(testLink).join(", ")}`);
	if (evidence.scenarios.length > 0) {
		lines.push(`Scenarios: ${evidence.scenarios.map(escapeMarkdown).join(", ")}`);
	}
	if (evidence.questions.length > 0) {
		lines.push(`Questions: ${evidence.questions.map(escapeMarkdown).join(", ")}`);
	}
	return lines;
}

/** Evidence tests are repository-relative paths, linked from `docs/`. */
function testLink(path: string): string {
	if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) || path.split("/").includes("..")) {
		throw new Error(`Capability evidence test must be a repository-relative path: ${path}`);
	}
	const label = path.replace(/^tests\//, "").replace(/\.test\.ts$/, "");
	return `[${escapeMarkdown(label)}](../${path})`;
}

function tableRow(cells: string[]): string {
	return `|${cells.map((cell) => (cell === "" ? " " : ` ${cell} `)).join("|")}|`;
}

/** Escapes inline Markdown; an underscore inside a word never starts emphasis and stays bare. */
function escapeMarkdown(text: string): string {
	return text
		.replace(/[\\`*[\]|]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, (character) => `\\${character}`)
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r?\n/g, "<br>");
}
