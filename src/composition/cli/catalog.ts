#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import type { z } from "zod";
import { previewSchema } from "../../app/catalog-routes";
import { bindingAdoptionSchema, CatalogBindings } from "../../catalog/bindings";
import { checkNewCatalogIntent } from "../../catalog/control-plane";
import { type CatalogFileLanguage, catalogFileText } from "../../catalog/format";
import type { AuthoredCatalogIntent, CatalogAdvisory } from "../../catalog/types";
import { BillingRepository } from "../../db/repository";
import { BillingClient } from "../../sdk/client";
import { writeStderr, writeStdout } from "../../shared/cli-output";
import { createDirectCatalogApi } from "./direct-catalog";
import {
	CliUsageError,
	type CommandOutput,
	memberOverrideReason,
	type OperatorContextDependencies,
	openOperatorContext,
	operatorActor,
	reportOperatorFailure,
	runOperatorCommand,
} from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

export interface CatalogCommandDependencies extends OperatorContextDependencies {
	/** Replaces the Stripe client that `bindings adopt` reads prices with, for tests. */
	stripeClient?: (secretKey: string) => Stripe;
}

/**
 * Runs `quotum catalog`. `status` is a project-authenticated read; only `diff` and `push`, which
 * preview and publish, need the operator key, and `format` calls no API at all. With `--instance`
 * the commands run against the database instead, with no project key and no `/v1`, which is how an
 * inactive environment, one `/v1` refuses, is reached. A failure is one line on stderr.
 */
export async function runCatalogCommand(
	argv: readonly string[],
	env: Environment,
	output: CommandOutput = { stdout: writeStdout, stderr: writeStderr },
	dependencies: CatalogCommandDependencies = {},
): Promise<number> {
	const [command] = argv;
	if (command === undefined || command === "help" || command === "--help") {
		output.stdout(help);
		return 0;
	}
	if (command === "format") return await runCatalogFormat(argv.slice(1), output);
	return await runOperatorCommand(
		() => catalogCommand(argv, env, dependencies),
		"quotum catalog --help",
		output,
	);
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

async function catalogCommand(
	argv: readonly string[],
	env: Environment,
	dependencies: CatalogCommandDependencies,
): Promise<unknown> {
	const [command, ...allArguments] = argv;
	if (command === "provision")
		throw new CliUsageError(
			"provision reads the database directly; run `quotum catalog provision` or `bun run catalog:provision`.",
		);
	if (command !== "status" && command !== "diff" && command !== "push" && command !== "bindings")
		throw new CliUsageError(`Unknown catalog command: ${command}.`);
	const { rest, direct } = takeDirectOptions(allArguments);
	const unknown = rest.find(
		(arg) => arg.startsWith("--") && !(command === "push" && arg === "--force"),
	);
	if (unknown !== undefined) throw new CliUsageError(`Unknown option ${unknown}.`);
	if (direct !== null) return await runDirect(direct, command, rest, env, dependencies);
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
	return await runCatalogOperation(client.catalog, command, rest);
}

/** The options that select the database and name who is acting: `--instance` turns them on. */
const directOptions = ["instance", "actor", "member-override-reason"] as const;

/**
 * Takes the direct-mode options and their values out of `args`. Like the other operator commands,
 * each needs a value and may be given once. `--actor` and `--member-override-reason` mean nothing
 * without `--instance`, so they are refused rather than ignored.
 */
function takeDirectOptions(args: readonly string[]): {
	rest: string[];
	direct: Map<string, string> | null;
} {
	const rest: string[] = [];
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const name = directOptions.find((option) => arg === `--${option}`);
		if (name === undefined) {
			rest.push(arg);
			continue;
		}
		if (options.has(name)) throw new CliUsageError(`${arg} is given more than once.`);
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--"))
			throw new CliUsageError(`${arg} needs a value.`);
		options.set(name, value);
		index += 1;
	}
	if (!options.has("instance")) {
		if (options.size > 0)
			throw new CliUsageError("--actor and --member-override-reason apply only with --instance.");
		return { rest, direct: null };
	}
	return { rest, direct: options };
}

/**
 * Runs one command against an instance's database rows: no project key, no `/v1`. The operator is
 * authorized the way the other operator commands are, by the gate that admits active and inactive
 * instances of an active organization and makes a change to one that has members name its reason.
 */
async function runDirect(
	options: Map<string, string>,
	command: "status" | "diff" | "push" | "bindings",
	rest: readonly string[],
	env: Environment,
	dependencies: CatalogCommandDependencies,
): Promise<unknown> {
	assertCatalogArguments(command, rest);
	const instanceKey = options.get("instance") ?? "";
	// Reads name no one; a change is audited, so it must name the operator.
	const reads = command === "status" || (command === "bindings" && rest[0] === "list");
	const operator = reads ? "reader" : operatorActor(options, env);
	const reason = memberOverrideReason(options);
	const context = await openOperatorContext(env, dependencies);
	try {
		const target = await context.target(instanceKey);
		const gate = context.gate(target, operator, { memberOverrideReason: reason });
		const stripeClient =
			dependencies.stripeClient ??
			((secretKey: string) => new Stripe(secretKey, { timeout: 10_000, maxNetworkRetries: 0 }));
		const api = createDirectCatalogApi({
			repository: new BillingRepository(context.billingDatabase),
			bindings: new CatalogBindings(context.billingDatabase, context.connections, stripeClient),
			project: target.project,
			operator,
			authorize: async (write) => {
				await gate.instance(context.sql, write);
			},
		});
		return await runCatalogOperation(api, command, rest);
	} finally {
		await context.close();
	}
}

/**
 * The catalog operations a command needs, whether they are served over HTTP by `BillingClient` or
 * by the database directly.
 */
export type CatalogApi = Pick<
	BillingClient["catalog"],
	"status" | "preview" | "publish" | "bindings"
>;

/**
 * The usage errors that depend only on the arguments, so a run against the database can refuse them
 * before it connects.
 */
function assertCatalogArguments(
	command: "status" | "diff" | "push" | "bindings",
	rest: readonly string[],
): void {
	if (command === "bindings") {
		if (!((rest.length === 1 && rest[0] === "list") || (rest.length === 2 && rest[0] === "adopt")))
			throw new CliUsageError("Use bindings list or bindings adopt <file>.");
		return;
	}
	if (command !== "status" && rest.every((arg) => arg.startsWith("--")))
		throw new CliUsageError(`${command} requires a catalog TypeScript file.`);
}

/** Runs one validated `quotum catalog` command against `api`; `rest` is what follows the command. */
async function runCatalogOperation(
	api: CatalogApi,
	command: "status" | "diff" | "push" | "bindings",
	rest: readonly string[],
): Promise<unknown> {
	assertCatalogArguments(command, rest);
	const [file] = rest.filter((arg) => !arg.startsWith("--"));
	if (command === "bindings") {
		if (rest[0] === "list") return await api.bindings.list();
		const input = bindingAdoptionSchema.parse(await Bun.file(rest[1] ?? "").json());
		const key = `binding:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
		return await api.bindings.adopt(input, key);
	}
	if (command === "status") return await api.status();
	if (file === undefined) throw new CliUsageError(`${command} requires a catalog TypeScript file.`);
	const source = await loadCatalog(file);
	const current = await api.status();
	const expectedRevision = expectedRevisionFor(source.expectedRevision, current.revision);
	const preview = await api.preview({
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
	return await api.publish({
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
  provision                    Development import before first publish; refuses production
                               (reads the database: run it as quotum catalog provision)
  bindings list                List Stripe product/price mappings
  bindings adopt <file>        Adopt existing Stripe product/price IDs from JSON
  status                       Print the currently published catalog intent and revision
  diff <catalog.ts>            Validate and preview a catalog-as-code change
  push <catalog.ts> [--force]  Preview, then publish the previewed catalog intent; a catalog
                               that is already published is left alone unless --force is given
  format <file> [--write]      Print a .ts, .js or .json catalog in the canonical spelling,
                               or rewrite the file with --write; calls no API

Environment:
  BILLING_BASE_URL, BILLING_PROJECT_API_KEY (or BILLING_PROJECT_KEY);
  diff, push and bindings also need BILLING_OPERATOR_API_KEY, and take an optional BILLING_ACTOR

Without a project key (an inactive environment has none, and /v1 refuses it), add --instance and
run against the database as the operator, for status, diff, push and bindings:
  quotum catalog <command> ... --instance <key> [--actor <name>] [--member-override-reason <why>]
  POSTGRES_URI, QUOTUM_SECRETS_KEY_ID, QUOTUM_SECRETS_KEY_BASE64, QUOTUM_AUTH_SECRET; diff, push and
  bindings adopt also take --actor (or QUOTUM_ACTOR), recorded as operator:<name>. An organization
  with members needs --member-override-reason for those. BILLING_* are not read.`;

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runCatalogCommand(process.argv.slice(2), process.env);
}
