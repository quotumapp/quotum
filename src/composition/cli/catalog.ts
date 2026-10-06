#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { previewSchema } from "../../app/catalog-routes";
import { checkNewCatalogIntent } from "../../catalog/control-plane";
import { type CatalogFileLanguage, catalogFileText } from "../../catalog/format";
import type { AuthoredCatalogIntent, CatalogAdvisory } from "../../catalog/types";
import { BillingClient } from "../../sdk/client";
import { writeStderr, writeStdout } from "../../shared/cli-output";
import {
	CliUsageError,
	type CommandOutput,
	reportOperatorFailure,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Runs `quotum catalog`. `status` is a project-authenticated read; only `diff` and `push`, which
 * preview and publish, need the operator key, and `format` calls no API at all. A failure is one
 * line on stderr.
 */
export async function runCatalogCommand(
	argv: readonly string[],
	env: Environment,
	output: CommandOutput = { stdout: writeStdout, stderr: writeStderr },
): Promise<number> {
	const [command] = argv;
	if (command === undefined || command === "help" || command === "--help") {
		output.stdout(help);
		return 0;
	}
	if (command === "format") return await runCatalogFormat(argv.slice(1), output);
	return await runOperatorCommand(() => catalogCommand(argv, env), "quotum catalog --help", output);
}

/**
 * `quotum catalog format <file> [--write]`: checks a catalog file the way preview does, without
 * calling the API or publishing, and prints it in the canonical spelling, or rewrites the file in
 * place with `--write`. Formatting is idempotent and keeps the file's `expectedRevision`, `null`
 * included. Wrong arguments exit 64; an unreadable or invalid catalog exits 1.
 */
export async function runCatalogFormat(
	args: readonly string[],
	output: CommandOutput = { stdout: writeStdout, stderr: writeStderr },
): Promise<number> {
	try {
		const unknown = args.find((arg) => arg.startsWith("--") && arg !== "--write");
		if (unknown !== undefined) throw new CliUsageError(`Unknown option ${unknown}.`);
		const files = args.filter((arg) => !arg.startsWith("--"));
		const [file] = files;
		if (file === undefined || files.length > 1)
			throw new CliUsageError("format requires one catalog file.");
		const language = catalogFileLanguage(file);
		const formatted = formatCatalogSource(await loadCatalog(file), language);
		for (const advisory of formatted.advisories)
			output.stderr(`Advice at ${advisory.path}: ${advisory.message}`);
		if (args.includes("--write")) {
			await writeFile(resolve(file), formatted.text, "utf8");
			output.stdout(`Wrote ${file} in the canonical spelling.`);
		} else {
			// The output writer ends the text with its own newline.
			output.stdout(formatted.text.slice(0, -1));
		}
		return 0;
	} catch (error) {
		return reportOperatorFailure(error, "quotum catalog --help", output);
	}
}

/**
 * A loaded catalog file checked the way preview checks it, and its text in the canonical spelling.
 * Preview's request schema runs first, so a file is refused for what the API would refuse.
 */
export function formatCatalogSource(
	source: { catalog: unknown; expectedRevision?: number | null },
	language: CatalogFileLanguage,
): { text: string; advisories: CatalogAdvisory[] } {
	const parsed = previewSchema.shape.catalog.safeParse(source.catalog);
	if (!parsed.success) {
		const [issue] = parsed.error.issues;
		throw new Error(
			`Catalog is invalid${issue === undefined ? "" : ` at ${issuePath(issue)}: ${issue.message}`}`,
		);
	}
	const checked = checkNewCatalogIntent(parsed.data as AuthoredCatalogIntent);
	return {
		text: catalogFileText(checked.canonical, language, source.expectedRevision),
		advisories: checked.advisories,
	};
}

/** The language a catalog file is written in, from its extension. */
export function catalogFileLanguage(file: string): CatalogFileLanguage {
	const extension = extname(file).toLowerCase();
	if (extension === ".json") return "json";
	if ([".ts", ".mts", ".cts"].includes(extension)) return "ts";
	if ([".js", ".mjs", ".cjs"].includes(extension)) return "js";
	throw new CliUsageError("format reads a .ts, .js or .json catalog file.");
}

function issuePath(issue: z.core.$ZodIssue): string {
	return issue.path.length === 0
		? "the catalog"
		: issue.path
				.map((part, index) =>
					typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`,
				)
				.join("");
}

async function catalogCommand(argv: readonly string[], env: Environment): Promise<unknown> {
	const [command, ...rest] = argv;
	if (command !== "status" && command !== "diff" && command !== "push")
		throw new CliUsageError(`Unknown catalog command: ${command}.`);
	const unknown = rest.find(
		(arg) => arg.startsWith("--") && !(command === "push" && arg === "--force"),
	);
	if (unknown !== undefined) throw new CliUsageError(`Unknown option ${unknown}.`);
	const [file] = rest.filter((arg) => !arg.startsWith("--"));
	const writes = command !== "status";
	const client = new BillingClient({
		baseUrl: requiredEnv(env, "BILLING_BASE_URL"),
		apiKey: env.BILLING_PROJECT_API_KEY,
		projectKey: env.BILLING_PROJECT_KEY,
		...(writes
			? {
					operatorKey: requiredEnv(env, "BILLING_OPERATOR_API_KEY", `for catalog ${command}`),
					actor: env.BILLING_ACTOR ?? "catalog-cli",
				}
			: {}),
	});
	if (command === "status") return await client.catalog.status();
	if (file === undefined) throw new CliUsageError(`${command} requires a catalog TypeScript file.`);
	const source = await loadCatalog(file);
	const current = await client.catalog.status();
	const expectedRevision = expectedRevisionFor(source.expectedRevision, current.revision);
	const preview = await client.catalog.preview({
		expectedRevision,
		catalog: source.catalog,
	});
	const changed = current.intentHash !== preview.intentHash;
	if (command === "diff")
		return {
			changed,
			currentRevision: current.revision,
			nextRevision: preview.nextRevision,
			intentHash: preview.intentHash,
			expiresAt: preview.expiresAt,
			impact: preview.impact,
		};
	// Publishing the catalog that is already published would still add a revision and write every
	// top-up option again, so a deploy that pushes on every run would add one each time.
	if (!changed && !rest.includes("--force"))
		return {
			changed: false,
			published: false,
			revision: current.revision,
			intentHash: current.intentHash,
		};
	return await client.catalog.publish({
		expectedRevision,
		previewToken: preview.previewToken,
		catalog: source.catalog,
	});
}

/**
 * The revision a push expects. `null` is a real expectation ("nothing is published yet"); only an
 * absent export follows the current revision.
 */
export function expectedRevisionFor(
	declared: number | null | undefined,
	current: number | null,
): number | null {
	return declared === undefined ? current : declared;
}

async function loadCatalog(
	file: string,
): Promise<{ catalog: AuthoredCatalogIntent; expectedRevision?: number | null }> {
	const url = pathToFileURL(resolve(file));
	url.searchParams.set("loadedAt", String(Date.now()));
	const module = (await import(url.href)) as {
		default?: unknown;
		catalog?: unknown;
		expectedRevision?: unknown;
	};
	const catalog = module.catalog ?? module.default;
	if (!isAuthoredCatalogIntent(catalog)) {
		throw new Error("Catalog file must export a catalog intent as `catalog` or default");
	}
	if (
		module.expectedRevision !== undefined &&
		module.expectedRevision !== null &&
		(!Number.isSafeInteger(module.expectedRevision) || Number(module.expectedRevision) < 1)
	) {
		throw new Error("expectedRevision must be a positive integer or null");
	}
	return {
		catalog,
		...(module.expectedRevision === undefined
			? {}
			: { expectedRevision: module.expectedRevision as number | null }),
	};
}

function isAuthoredCatalogIntent(value: unknown): value is AuthoredCatalogIntent {
	return (
		typeof value === "object" &&
		value !== null &&
		"features" in value &&
		Array.isArray(value.features) &&
		"plans" in value &&
		Array.isArray(value.plans) &&
		"topups" in value &&
		Array.isArray(value.topups) &&
		"rateCards" in value &&
		Array.isArray(value.rateCards)
	);
}

function requiredEnv(env: Environment, name: string, purpose?: string): string {
	const value = env[name]?.trim();
	if (value === undefined || value === "")
		throw new Error(`${name} is required${purpose === undefined ? "" : ` ${purpose}`}`);
	return value;
}

const help = `quotum catalog <command> [catalog.ts]

Commands:
  status                       Print the currently published catalog intent and revision
  diff <catalog.ts>            Validate and preview a catalog-as-code change
  push <catalog.ts> [--force]  Preview, then publish the previewed catalog intent; a catalog
                               that is already published is left alone unless --force is given
  format <file> [--write]      Print a .ts, .js or .json catalog in the canonical spelling,
                               or rewrite the file with --write; calls no API

Environment:
  BILLING_BASE_URL, BILLING_PROJECT_API_KEY (or BILLING_PROJECT_KEY);
  diff and push also need BILLING_OPERATOR_API_KEY, and take an optional BILLING_ACTOR`;

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runCatalogCommand(process.argv.slice(2), process.env);
}
