#!/usr/bin/env bun
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CatalogIntent } from "../../catalog/types";
import { BillingClient } from "../../sdk/client";
import { writeStderr, writeStdout } from "../../shared/cli-output";
import { CliUsageError, type CommandOutput, runOperatorCommand } from "./operator-context";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Runs `quotum catalog`. `status` is a project-authenticated read; only `diff` and `push`, which
 * preview and publish, need the operator key. A failure is one line on stderr.
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
	return await runOperatorCommand(() => catalogCommand(argv, env), "quotum catalog --help", output);
}

async function catalogCommand(argv: readonly string[], env: Environment): Promise<unknown> {
	const [command, file] = argv;
	if (command !== "status" && command !== "diff" && command !== "push")
		throw new CliUsageError(`Unknown catalog command: ${command}.`);
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
	if (command === "diff")
		return {
			changed: current.intentHash !== preview.intentHash,
			currentRevision: current.revision,
			nextRevision: preview.nextRevision,
			intentHash: preview.intentHash,
			expiresAt: preview.expiresAt,
			impact: preview.impact,
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
): Promise<{ catalog: CatalogIntent; expectedRevision?: number | null }> {
	const url = pathToFileURL(resolve(file));
	url.searchParams.set("loadedAt", String(Date.now()));
	const module = (await import(url.href)) as {
		default?: unknown;
		catalog?: unknown;
		expectedRevision?: unknown;
	};
	const catalog = module.catalog ?? module.default;
	if (!isCatalogIntent(catalog)) {
		throw new Error("Catalog file must export a CatalogIntent as `catalog` or default");
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

function isCatalogIntent(value: unknown): value is CatalogIntent {
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
  status             Print the currently published catalog intent and revision
  diff <catalog.ts>  Validate and preview a catalog-as-code change
  push <catalog.ts>  Preview, then publish the unchanged catalog intent

Environment:
  BILLING_BASE_URL, BILLING_PROJECT_API_KEY (or BILLING_PROJECT_KEY);
  diff and push also need BILLING_OPERATOR_API_KEY, and take an optional BILLING_ACTOR`;

// Last, so every declaration above is initialized before the command runs.
if (import.meta.main) {
	process.exitCode = await runCatalogCommand(process.argv.slice(2), process.env);
}
